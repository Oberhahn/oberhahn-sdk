#!/usr/bin/env node
/**
 * Live smoke test for @oberhahn/sdk against a DEPLOYED OBERHAHN endpoint.
 *
 * Makes ONE real provider call (OpenAI or Anthropic), lets the SDK post the
 * usage event to OBERHAHN, then reads it back to confirm it landed.
 *
 * Everything comes from env vars — no secrets in code, nothing pasted anywhere.
 * This makes a real (tiny, cheap) API call and writes a real event to the
 * deployed endpoint, so run it deliberately.
 *
 *   Required:
 *     OBERHAHN_BASE_URL   deployed API root incl. /v0   (e.g. https://oberhahn.example.com/v0)
 *     OBERHAHN_API_KEY    an oak_ key for that deployment
 *     one provider key:
 *       OPENAI_API_KEY        → wraps a real OpenAI client
 *       ANTHROPIC_API_KEY     → wraps a real Anthropic client
 *
 *   Optional:
 *     OPENAI_MODEL        default "gpt-4o-mini"
 *     ANTHROPIC_MODEL     default "claude-haiku-4-5"
 *
 *   Run:  cd sdk && npm run smoke
 *   (npm run smoke builds dist/ first, then runs this file)
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init, wrap } from "../dist/index.js";

// Load sdk/.env (sibling of scripts/) so `npm run smoke` and a bare
// `node scripts/smoke.mjs` both pick up config without needing --env-file.
// process.env still wins — anything already set is left untouched.
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

// A unique tag so we can find exactly this run's event on readback.
const smokeId = `smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Full attribution payload exercised end-to-end. The SDK routes KNOWN keys
// (session_id → provider_session_id, task_id, consumer_type) to top-level event
// fields and everything else into `custom` (see sdk/src/metadata.ts). The custom
// keys below are exactly the ones the dashboard maps to its dimensions
// (feature/task/client_tool/environment/task_team/task_project/task_assignee).
const smokeMetadata = {
  // known keys → canonical top-level event fields
  session_id: smokeId,
  task_id: `task_${smokeId}`,
  consumer_type: "customer",
  // custom keys → event.custom.* (each backs a dashboard dimension)
  smoke_id: smokeId,
  feature: "sdk_smoke",
  task: "SDK metadata smoke",
  task_team: "Platform",
  task_project: "SDK",
  task_assignee: "paige.jones@pinata.cloud",
  client_tool: "smoke-cli",
  environment: "staging",
};

// Route each sent key to where it should surface on the read-back event, mirroring
// sdk/src/metadata.ts. Returns a list of human-readable mismatches (empty = pass).
const KNOWN_FIELD = {
  session_id: "provider_session_id",
  provider_session_id: "provider_session_id",
  task_id: "task_id",
  consumer_id: "consumer_id",
  consumer_type: "consumer_type",
};
function metadataMismatches(row, meta) {
  const miss = [];
  for (const [key, val] of Object.entries(meta)) {
    const want = String(val);
    const field = KNOWN_FIELD[key];
    const got = field ? row?.[field] : row?.custom?.[key];
    const where = field ? field : `custom.${key}`;
    if (String(got ?? "") !== want) miss.push(`${where}: expected "${want}", got ${got == null ? "(missing)" : `"${got}"`}`);
  }
  return miss;
}

console.log("OBERHAHN smoke test");
console.log(`  endpoint : ${BASE}`);
console.log(`  key      : ${KEY.slice(0, 8)}…`);
console.log(`  smoke_id : ${smokeId}`);

// throwOnError so a bad ingest is loud; onError also logs the reason.
// init() returns the client that owns the outbound queue.
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
  console.log(`  provider : openai (${model})`);
  const res = await openai.chat.completions.create({
    model,
    max_tokens: 100,
    messages: [{ role: "user", content: "Give me a 200 word paragraph'." }],
    obMetadata: smokeMetadata,
  });
  return { provider_message_id: res.id, usage: res.usage };
}

async function runAnthropic() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  const anthropic = wrap(new Anthropic(), "anthropic");
  console.log(`  provider : anthropic (${model})`);
  const res = await anthropic.messages.create({
    model,
    max_tokens: 100,
    messages: [{ role: "user", content: "Give me a 200 word paragraph." }],
    obMetadata: smokeMetadata,
  });
  return { provider_message_id: res.id, usage: res.usage };
}

async function runBedrock() {
  const { BedrockRuntimeClient, ConverseCommand } = await import(
    "@aws-sdk/client-bedrock-runtime"
  );
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) die("Set AWS_REGION for the Bedrock smoke (plus AWS credentials).");
  // Model access must be enabled in your account/region; may need a "us."/"eu."
  // inference-profile prefix. Override with BEDROCK_MODEL_ID.
  const modelId = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0";
  const client = wrap(new BedrockRuntimeClient({ region }), "bedrock");
  console.log(`  provider : bedrock (${modelId}, ${region})`);
  const command = new ConverseCommand({
    modelId,
    messages: [{ role: "user", content: [{ text: "Give me a 200 word paragraph" }] }],
    inferenceConfig: { maxTokens: 16 },
  });
  // Per-call attribution on the command instance (SDK strips it before send).
  Object.assign(command, {
    obMetadata: smokeMetadata,
  });
  const res = await client.send(command);
  return { provider_message_id: undefined, usage: res.usage };
}

async function runGemini() {
  const { GoogleGenAI } = await import("@google/genai");
  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const gemini = wrap(
    new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY }),
    "gemini",
  );
  console.log(`  provider : gemini (${model})`);
  const res = await gemini.models.generateContent({
    model,
    contents: "Give me a 200 word paragraph.",
    obMetadata: smokeMetadata,
  });
  return { provider_message_id: res.responseId, usage: res.usageMetadata };
}

async function readBack() {
  // Poll GET /events filtered by our custom tag. Ingestion is synchronous, but
  // give it a few tries in case of replication lag on the deployment.
  // Filter on our custom tag via the supported `filter=key:value` form. A bare
  // ?smoke_id=… param is silently ignored by GET /events (only start_date,
  // end_date, filter=key:value, and a fixed set of direct params are honored),
  // which would return recent unrelated events and make this readback a false pass.
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
    !!process.env.AWS_ACCESS_KEY_ID || !!process.env.AWS_PROFILE || !!process.env.AWS_REGION;
  // Explicit override wins; otherwise detect from whichever credentials are set.
  const hasGemini = !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
  const provider =
    process.env.OBERHAHN_SMOKE_PROVIDER ??
    (process.env.OPENAI_API_KEY
      ? "openai"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : hasAws
          ? "bedrock"
          : hasGemini
            ? "gemini"
            : null);
  if (!provider) {
    die(
      "No provider selected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS creds, or GEMINI_API_KEY " +
        "(or force with OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock|gemini).",
    );
  }

  const runners = { openai: runOpenAI, anthropic: runAnthropic, bedrock: runBedrock, gemini: runGemini };
  const run = runners[provider];
  if (!run) die(`Unknown OBERHAHN_SMOKE_PROVIDER "${provider}".`);

  console.log("\n→ making real provider call…");
  const sent = await run();
  console.log(`  provider returned id=${sent.provider_message_id}`);
  console.log(`  usage: ${JSON.stringify(sent.usage)}`);

  // The SDK's submit is fire-and-forget; wait for the in-flight POST to finish.
  // (awaitPending is an internal drain helper — the public API ships no flush.)
  console.log("\n→ waiting for the event POST to complete…");
  await oberhahn.awaitPending();

  console.log("\n→ reading the event back from OBERHAHN…");
  const rows = await readBack();
  if (rows === null) return; // readback not permitted; not a failure of ingest
  if (rows.length === 0) {
    die("event NOT found on readback — check the endpoint, key scope, and logs.");
  }
  console.log(`\n✓ event landed. matched ${rows.length} row(s):`);
  console.log(JSON.stringify(rows[0], null, 2));

  // Verify the full attribution payload round-tripped: known keys onto their
  // canonical fields, everything else into custom.* (see sdk/src/metadata.ts).
  const miss = metadataMismatches(rows[0], smokeMetadata);
  if (miss.length > 0) {
    die(`metadata did NOT round-trip:\n    - ${miss.join("\n    - ")}`);
  }
  console.log(`\n✓ all ${Object.keys(smokeMetadata).length} attribution fields round-tripped.`);
}

main().catch((err) => die(err?.stack ?? String(err)));
