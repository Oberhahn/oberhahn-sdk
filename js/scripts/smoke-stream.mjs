#!/usr/bin/env node
/**
 * Live STREAMING smoke test for @oberhahn/sdk against a DEPLOYED OBERHAHN endpoint.
 *
 * Same contract as smoke.mjs but makes a real *streaming* provider call: the SDK
 * tees the stream, and only extracts usage once the stream is fully drained. So
 * this script consumes every chunk before awaiting the ingest POST.
 *
 * Env vars are identical to smoke.mjs (loaded from js/.env automatically):
 *   Required: OBERHAHN_BASE_URL (incl. /v0), OBERHAHN_API_KEY, one provider key.
 *   Optional: OPENAI_MODEL, ANTHROPIC_MODEL, BEDROCK_MODEL_ID, OBERHAHN_SMOKE_PROVIDER.
 *
 *   Run:  cd js && npm run smoke:stream
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init, wrap } from "../dist/index.js";

const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
if (typeof process.loadEnvFile === "function" && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const BASE = process.env.OBERHAHN_BASE_URL;
const KEY = process.env.OBERHAHN_API_KEY;

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!BASE) die("OBERHAHN_BASE_URL is not set (deployed API root incl. /v0).");
if (!KEY) die("OBERHAHN_API_KEY is not set (an oak_ key for the deployment).");

const smokeId = `smokestream_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

console.log("OBERHAHN streaming smoke test");
console.log(`  endpoint : ${BASE}`);
console.log(`  key      : ${KEY.slice(0, 8)}…`);
console.log(`  smoke_id : ${smokeId}`);

const oberhahn = init({
  apiKey: KEY,
  baseUrl: BASE,
  throwOnError: false,
  onError: (err) => console.error("  submit error:", err?.message ?? err),
});

async function runOpenAI() {
  const { default: OpenAI } = await import("openai");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const openai = wrap(new OpenAI(), "openai");
  console.log(`  provider : openai (${model}, streaming)`);
  const stream = await openai.chat.completions.create({
    model,
    max_tokens: 100,
    // Without include_usage OpenAI streams carry NO usage block → nothing to emit.
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Give me a 200 word paragraph." }],
    obMetadata: { smoke_id: smokeId, session_id: smokeId, feature: "sdk_smoke_stream" },
  });
  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return { text };
}

async function runAnthropic() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  const anthropic = wrap(new Anthropic(), "anthropic");
  console.log(`  provider : anthropic (${model}, streaming)`);
  const stream = await anthropic.messages.create({
    model,
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Give me a 200 word paragraph." }],
    obMetadata: { smoke_id: smokeId, session_id: smokeId, feature: "sdk_smoke_stream" },
  });
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      text += event.delta.text;
    }
  }
  return { text };
}

async function runBedrock() {
  const { BedrockRuntimeClient, ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) die("Set AWS_REGION for the Bedrock streaming smoke (plus AWS credentials).");
  const modelId = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0";
  const client = wrap(new BedrockRuntimeClient({ region }), "bedrock");
  console.log(`  provider : bedrock (${modelId}, ${region}, streaming)`);
  const command = new ConverseStreamCommand({
    modelId,
    messages: [{ role: "user", content: [{ text: "Give me a 200 word paragraph" }] }],
    inferenceConfig: { maxTokens: 16 },
  });
  // Per-call attribution on the command instance (SDK strips it before send).
  Object.assign(command, {
    obMetadata: { smoke_id: smokeId, session_id: smokeId, feature: "sdk_smoke_stream" },
  });
  const res = await client.send(command);
  let text = "";
  for await (const event of res.stream) {
    text += event.contentBlockDelta?.delta?.text ?? "";
  }
  return { text };
}

async function readBack() {
  // Filter on our custom tag via the supported `filter=key:value` form (a bare
  // ?smoke_id=… is silently ignored by GET /events and would false-pass).
  const url = `${BASE.replace(/\/$/, "")}/events?filter=${encodeURIComponent(`smoke_id:${smokeId}`)}&limit=5`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}` } });
    if (res.status === 401 || res.status === 403) {
      console.warn(
        `\n  readback not permitted (${res.status}) — an ingest-only key can't read /events.\n` +
          `  The event may still have landed; verify with a read key or the dashboard.`,
      );
      return null;
    }
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const rows = Array.isArray(body) ? body : (body.events ?? []);
      if (rows.length > 0) return rows;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

async function main() {
  const hasAws =
    !!process.env.AWS_ACCESS_KEY_ID || !!process.env.AWS_BEARER_TOKEN_BEDROCK || !!process.env.AWS_REGION;
  const provider =
    process.env.OBERHAHN_SMOKE_PROVIDER ??
    (process.env.OPENAI_API_KEY
      ? "openai"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : hasAws
          ? "bedrock"
          : null);
  if (!provider) {
    die("No provider selected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or AWS creds.");
  }
  const runners = { openai: runOpenAI, anthropic: runAnthropic, bedrock: runBedrock };
  const run = runners[provider];
  if (!run) die(`Streaming smoke supports openai|anthropic|bedrock, not "${provider}".`);

  console.log("\n→ making real streaming provider call…");
  const { text } = await run();
  console.log(`  stream drained. text: ${JSON.stringify(text)}`);

  console.log("\n→ waiting for the event POST to complete…");
  await oberhahn.awaitPending();

  console.log("\n→ reading the event back from OBERHAHN…");
  const rows = await readBack();
  if (rows === null) return;
  if (rows.length === 0) {
    die("event NOT found on readback — streaming usage may not have been extracted.");
  }
  console.log(`\n✓ streamed event landed. matched ${rows.length} row(s):`);
  console.log(JSON.stringify(rows[0], null, 2));
}

main().catch((err) => die(err?.stack ?? String(err)));
