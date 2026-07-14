import { describe, expect, it, vi } from "vitest";
import { flush, init, wrap } from "../src/index.js";
import { routeMetadata } from "../src/metadata.js";
import { initCapturing } from "./helpers.js";

function fakeOpenAI(create: () => unknown) {
  return {
    chat: { completions: { create: async () => create() } },
    embeddings: { create: async () => ({}) },
  };
}

describe("metadata routing", () => {
  it("routes known keys to top-level fields and the rest to custom", () => {
    const routed = routeMetadata(
      { environment: "prod" },
      { feature: "agent" },
      { session_id: "s1", task_id: "t1", consumer_id: "c1", consumer_type: "team", turn_id: 7 },
    );
    expect(routed).toEqual({
      provider_session_id: "s1",
      task_id: "t1",
      consumer_id: "c1",
      consumer_type: "team",
      custom: { environment: "prod", feature: "agent", turn_id: "7" },
    });
  });

  it("later sources win on conflict", () => {
    const routed = routeMetadata({ feature: "a" }, { feature: "b" }, { feature: "c" });
    expect(routed.custom.feature).toBe("c");
  });
});

describe("wrap()", () => {
  it("is idempotent — double wrap does not double-emit", async () => {
    const { client, calls } = initCapturing();
    const base = fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const once = wrap(base, "openai");
    const twice = wrap(once, "openai"); // same object, already wrapped

    expect(twice).toBe(once);
    await once.chat.completions.create({ model: "gpt-4o" } as never);
    await client.awaitPending();
    expect(calls).toHaveLength(1);
  });

  it("throws on an unknown provider", () => {
    initCapturing();
    expect(() => wrap({ chat: {} }, "not-a-provider")).toThrow(/unknown provider/);
  });

  it("warns and returns the client untouched when it has none of the provider's methods", () => {
    initCapturing();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = { do: () => 1 };
    expect(wrap(weird, "openai")).toBe(weird);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing patched"));
    warn.mockRestore();
  });
});

describe("client behavior", () => {
  it("never throws into the request path when a submit fails (default)", async () => {
    const onError = vi.fn();
    const client = init({
      apiKey: "oak_test",
      baseUrl: "https://oberhahn.test/v0",
      onError,
      fetch: (async () => new Response("boom", { status: 400 })) as unknown as typeof fetch,
    });
    const openai = wrap(fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })), "openai");

    // The wrapped call resolves normally even though ingest 400s.
    await expect(openai.chat.completions.create({ model: "gpt-4o" } as never)).resolves.toBeDefined();
    await client.awaitPending();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("retries retryable ingest failures", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      return attempts < 2
        ? new Response("try again", { status: 503 })
        : new Response("{}", { status: 202 });
    });
    const client = init({
      apiKey: "oak_test",
      baseUrl: "https://oberhahn.test/v0",
      maxRetries: 3,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const openai = wrap(fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })), "openai");

    await openai.chat.completions.create({ model: "gpt-4o" } as never);
    await client.awaitPending();
    expect(attempts).toBe(2);
  });

  it("stamps status=success and duration_ms on a successful event", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })), "openai");

    await openai.chat.completions.create({ model: "gpt-4o" } as never);
    await client.awaitPending();
    expect(calls[0].body.status).toBe("success");
    expect(typeof calls[0].body.duration_ms).toBe("number");
    expect(calls[0].body.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("emits a status=error event and re-throws when the provider call fails", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(
      fakeOpenAI(() => {
        throw new Error("provider down");
      }),
      "openai",
    );

    await expect(openai.chat.completions.create({ model: "gpt-4o" } as never)).rejects.toThrow("provider down");
    await client.awaitPending();

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      status: "error",
      spend_details: { model_provider: "openai", model: "gpt-4o", input_tokens: 0, output_tokens: 0 },
    });
  });

  it("flush() drains pending submissions (no client handle needed)", async () => {
    const { calls } = initCapturing();
    const openai = wrap(fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })), "openai");

    await openai.chat.completions.create({ model: "gpt-4o" } as never);
    await flush(); // module-level public drain
    expect(calls).toHaveLength(1);
  });

  it("is a no-op passthrough when disabled", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    const client = init({
      apiKey: "oak_test",
      baseUrl: "https://oberhahn.test/v0",
      enabled: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const openai = wrap(fakeOpenAI(() => ({ id: "x", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } })), "openai");

    const res = await openai.chat.completions.create({ model: "gpt-4o" } as never);
    await client.awaitPending();
    expect((res as { id: string }).id).toBe("x");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
