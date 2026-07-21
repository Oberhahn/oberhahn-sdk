import type { Adapter, MethodSpec, ProviderUsage } from "./adapters/types.js";
import { OberhahnClient } from "./client.js";
import { buildEvent } from "./event.js";
import { routeMetadata } from "./metadata.js";
import type { Provider } from "./registry.js";

/** Marker so a client (and each patched method) is only wrapped once. */
const WRAPPED = Symbol.for("oberhahn.wrapped");

export interface WrapOptions {
  /**
   * Provider slug. Omit to auto-detect from the client (see `detectProvider`);
   * detection throws if the client is ambiguous (e.g. an OpenAI-compatible
   * client pointed at an unknown host), so pass it explicitly in that case.
   */
  provider?: Provider;
  /** Per-client attribution, merged above `init` metadata, below `obMetadata`. */
  metadata?: Record<string, unknown>;
}

interface EmitContext {
  ob: OberhahnClient;
  adapterName: string;
  clientMetadata: Record<string, unknown> | undefined;
  perCall: Record<string, unknown>;
  args: unknown[];
  spec: MethodSpec;
  /** `Date.now()` captured just before the provider call, for `duration_ms`. */
  start: number;
  /** Routing layer to record as `custom.provider` (e.g. "openrouter") when the
   * requested slug isn't the adapter's own name. `undefined` for a native call. */
  providerTag?: string;
}

/**
 * Patch every usage-bearing method the adapter declares, in place, and return
 * the same client. Idempotent: re-wrapping (or double-wrapping) is a no-op, so
 * events are never double-emitted.
 */
export function patchClient<T extends object>(
  client: T,
  adapter: Adapter,
  ob: OberhahnClient,
  opts: WrapOptions = {},
  providerTag?: string,
): T {
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;
  let patched = 0;
  for (const spec of adapter.methods) {
    if (patchMethod(client, spec, ob, adapter.name, opts.metadata, providerTag)) patched += 1;
  }
  if (patched === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[oberhahn] wrap(): none of the ${adapter.name} methods ` +
        `(${adapter.methods.map((m) => m.path).join(", ")}) were found on the client — ` +
        `nothing patched. Is this a ${adapter.name} client?`,
    );
  }
  Object.defineProperty(client, WRAPPED, { value: true, enumerable: false });
  return client;
}

/** Patch one method in place. Returns `true` if the method existed and was wrapped. */
function patchMethod(
  client: object,
  spec: MethodSpec,
  ob: OberhahnClient,
  adapterName: string,
  clientMetadata: Record<string, unknown> | undefined,
  providerTag?: string,
): boolean {
  const parts = spec.path.split(".");
  const key = parts.pop() as string;
  let owner: Record<string, unknown> = client as Record<string, unknown>;
  for (const part of parts) {
    const next = owner?.[part];
    if (next == null || typeof next !== "object") return false; // method not present
    owner = next as Record<string, unknown>;
  }
  const original = owner[key];
  if (typeof original !== "function") return false;
  if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) return true;

  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const { cleanedArgs, perCall } = stripObMetadata(args);
    const isStream = spec.isStream?.(cleanedArgs) ?? false;
    const ctx: EmitContext = {
      ob,
      adapterName,
      clientMetadata,
      perCall,
      args: cleanedArgs,
      spec,
      start: Date.now(),
      providerTag,
    };
    let result: unknown;
    try {
      result = (original as (...a: unknown[]) => unknown).apply(this, cleanedArgs);
    } catch (err) {
      safeEmitError(ctx); // synchronous provider failure
      throw err;
    }
    return handleResult(result, isStream, ctx);
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
  owner[key] = wrapped;
  return true;
}

/**
 * Pull `obMetadata` / `ob_metadata` off the first argument.
 *
 * For a plain request body (OpenAI/Anthropic) return a shallow clone without
 * our keys, so the caller's object is never mutated. For a class instance
 * (e.g. a Bedrock `Command`) spreading would strip its prototype and break the
 * provider call, so read the keys and `delete` them in place — preserving the
 * instance `send()` needs.
 */
function stripObMetadata(args: unknown[]): {
  cleanedArgs: unknown[];
  perCall: Record<string, unknown>;
} {
  const first = args[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return { cleanedArgs: args, perCall: {} };
  }
  const rec = first as Record<string, unknown>;
  if (!("obMetadata" in rec) && !("ob_metadata" in rec)) {
    return { cleanedArgs: args, perCall: {} };
  }
  const perCall: Record<string, unknown> = {
    ...(isObj(rec.ob_metadata) ? rec.ob_metadata : {}),
    ...(isObj(rec.obMetadata) ? rec.obMetadata : {}),
  };
  if (isPlainObject(first)) {
    const { obMetadata: _o, ob_metadata: _u, ...rest } = rec;
    return { cleanedArgs: [rest, ...args.slice(1)], perCall };
  }
  // Class instance — keep it, just remove our keys in place.
  delete rec.obMetadata;
  delete rec.ob_metadata;
  return { cleanedArgs: args, perCall };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A plain `{}` / `Object.create(null)` object — not a class instance. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function handleResult(result: unknown, isStream: boolean, ctx: EmitContext): unknown {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as Promise<unknown>).then(
      (resolved) => finish(resolved, isStream, ctx),
      (err) => {
        safeEmitError(ctx); // the awaited provider call rejected
        throw err;
      },
    );
  }
  return finish(result, isStream, ctx);
}

function finish(resolved: unknown, isStream: boolean, ctx: EmitContext): unknown {
  try {
    if (isStream && ctx.spec.extractStream) {
      return teeStream(resolved, ctx);
    }
    emit(ctx.spec.extract(resolved, ctx.args), ctx);
  } catch (err) {
    if (ctx.ob.throwOnError) throw err;
  }
  return resolved;
}

/** Record the routing layer as `custom.provider` (e.g. "openrouter"), without
 * overwriting a tag the adapter already set. */
function tagProvider(usage: ProviderUsage, tag: string | undefined): void {
  if (!tag) return;
  if (usage.custom?.provider === undefined) {
    usage.custom = { ...usage.custom, provider: tag };
  }
}

function emit(usage: ProviderUsage | null, ctx: EmitContext): void {
  if (!usage) return;
  tagProvider(usage, ctx.providerTag);
  const routed = routeMetadata(ctx.ob.metadata, ctx.clientMetadata, ctx.perCall);
  ctx.ob.submit(
    buildEvent(usage, routed, { durationMs: Date.now() - ctx.start, status: "success" }),
  );
}

/** Emit a zero-token `status:"error"` event for a failed call. */
function emitError(ctx: EmitContext): void {
  const info = ctx.spec.modelInfo
    ? ctx.spec.modelInfo(ctx.args)
    : {
        model_provider: ctx.adapterName,
        model: ((ctx.args[0] as { model?: string } | undefined)?.model ?? "unknown"),
      };
  if (!info) return; // adapter says this call isn't a billable operation — skip
  const usage: ProviderUsage = {
    model: info.model,
    model_provider: info.model_provider,
    input_tokens: 0,
    output_tokens: 0,
  };
  tagProvider(usage, ctx.providerTag);
  const routed = routeMetadata(ctx.ob.metadata, ctx.clientMetadata, ctx.perCall);
  ctx.ob.submit(
    buildEvent(usage, routed, { durationMs: Date.now() - ctx.start, status: "error" }),
  );
}

/** Record the error event, but never let a reporting failure mask the caller's
 * original exception — swallow anything thrown here. */
function safeEmitError(ctx: EmitContext): void {
  try {
    emitError(ctx);
  } catch {
    /* attribution must never break the caller's error path */
  }
}

/**
 * Tee a streamed result: yield every chunk to the caller unchanged while
 * collecting them, then extract usage once the stream is fully consumed.
 * Handles both directly-async-iterable results (OpenAI/Anthropic streams) and
 * results whose iterable lives on `.stream` (Bedrock ConverseStream).
 */
function teeStream(resolved: unknown, ctx: EmitContext): unknown {
  const direct = asAsyncIterable(resolved);
  if (direct) {
    return teeIterable(resolved as AsyncIterable<unknown>, ctx);
  }
  const nested = (resolved as { stream?: unknown } | null)?.stream;
  if (asAsyncIterable(nested)) {
    try {
      (resolved as { stream: unknown }).stream = teeIterable(nested as AsyncIterable<unknown>, ctx);
    } catch {
      /* frozen result — nothing we can safely do */
    }
    return resolved;
  }
  // Not iterable after all — best effort with no chunks.
  emit(ctx.spec.extractStream?.([], ctx.args) ?? null, ctx);
  return resolved;
}

function asAsyncIterable(v: unknown): boolean {
  return !!v && typeof (v as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
}

/**
 * Proxy the async-iterable so the original object keeps its methods/identity,
 * but iteration is teed. Chunks are collected and usage is emitted when the
 * underlying iterator reports `done` (or is closed via `return`/`throw`).
 */
function teeIterable<T extends object>(iterable: T, ctx: EmitContext): T {
  return new Proxy(iterable, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const inner = (target as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          const chunks: unknown[] = [];
          let finished = false;
          const done = (errored: boolean) => {
            if (finished) return;
            finished = true;
            if (errored) {
              safeEmitError(ctx); // stream failed mid-flight
              return;
            }
            try {
              emit(ctx.spec.extractStream?.(chunks, ctx.args) ?? null, ctx);
            } catch (err) {
              if (ctx.ob.throwOnError) throw err;
            }
          };
          return {
            async next(...a: unknown[]) {
              let r;
              try {
                r = await inner.next(...(a as []));
              } catch (err) {
                done(true);
                throw err;
              }
              if (r.done) done(false);
              else chunks.push(r.value);
              return r;
            },
            async return(value?: unknown) {
              done(false);
              return inner.return ? inner.return(value) : { value, done: true };
            },
            async throw(err?: unknown) {
              done(true);
              if (inner.throw) return inner.throw(err);
              throw err;
            },
          } as AsyncIterator<unknown>;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
