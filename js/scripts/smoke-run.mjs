// Shared harness for the smoke scripts. Makes ONE real provider call (stream or
// not), lets the SDK post the usage event to a DEPLOYED OBERHAHN endpoint, reads
// it back, and verifies the full attribution payload round-tripped. The entry
// scripts (smoke.mjs / smoke-stream.mjs / smoke-interactive.mjs) are thin
// wrappers over runSmokeTest().
//
// Everything comes from env vars (loaded from js/.env automatically):
//   Required: OBERHAHN_BASE_URL (incl. /v0), OBERHAHN_API_KEY, one provider key.
//   Optional: OPENAI_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL / BEDROCK_MODEL_ID,
//             OBERHAHN_SMOKE_PROVIDER.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init } from "../dist/index.js";
import { chooseProvider, runSmoke } from "./smoke-providers.mjs";

/** Load js/.env (sibling of scripts/) as defaults; process.env still wins. */
export function loadEnv() {
  const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  if (typeof process.loadEnvFile === "function" && existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// Known metadata keys → canonical top-level event fields (see src/metadata.ts);
// everything else lands in custom.*.
const KNOWN_FIELD = {
  session_id: "provider_session_id",
  task_id: "task_id",
  consumer_id: "consumer_id",
  consumer_type: "consumer_type",
};

/** Human-readable mismatches between the sent metadata and the read-back row. */
function metadataMismatches(row, meta) {
  const miss = [];
  for (const [key, val] of Object.entries(meta)) {
    const field = KNOWN_FIELD[key];
    const got = field ? row?.[field] : row?.custom?.[key];
    const where = field ?? `custom.${key}`;
    if (String(got ?? "") !== String(val)) {
      miss.push(`${where}: expected "${val}", got ${got == null ? "(missing)" : `"${got}"`}`);
    }
  }
  return miss;
}

/** Poll GET /events for our unique smoke_id tag. */
async function readBack(base, key, smokeId) {
  const url = `${base.replace(/\/$/, "")}/events?filter=${encodeURIComponent(`smoke_id:${smokeId}`)}&limit=5`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
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

/** Run the end-to-end smoke; `streaming` picks the streaming provider path. */
export async function runSmokeTest(streaming = false) {
  loadEnv();
  const base = process.env.OBERHAHN_BASE_URL;
  const key = process.env.OBERHAHN_API_KEY;
  if (!base) die("OBERHAHN_BASE_URL is not set (deployed API root incl. /v0).");
  if (!key) die("OBERHAHN_API_KEY is not set (an oak_ key for the deployment).");

  const smokeId = `smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const meta = {
    session_id: smokeId,
    task_id: `task_${smokeId}`,
    consumer_type: "customer",
    smoke_id: smokeId,
    feature: streaming ? "sdk_smoke_stream" : "sdk_smoke",
    task: "SDK metadata smoke",
    task_team: "Platform",
    task_project: "SDK",
    task_assignee: "paige.jones@pinata.cloud",
    client_tool: "smoke-cli",
    environment: "staging",
  };

  console.log(`OBERHAHN smoke test${streaming ? " (streaming)" : ""}`);
  console.log(`  endpoint : ${base}`);
  console.log(`  key      : ${key.slice(0, 8)}…`);
  console.log(`  smoke_id : ${smokeId}`);

  const oberhahn = init({
    apiKey: key,
    baseUrl: base,
    throwOnError: false,
    onError: (err) => console.error("  submit error:", err?.message ?? err),
  });

  const provider = chooseProvider();
  console.log(`\n→ making real${streaming ? " streaming" : ""} provider call…`);
  const sent = await runSmoke(provider, streaming, meta);
  if (sent.provider_message_id) console.log(`  provider returned id=${sent.provider_message_id}`);
  if (sent.usage) console.log(`  usage: ${JSON.stringify(sent.usage)}`);

  console.log("\n→ waiting for the event POST to complete…");
  await oberhahn.awaitPending();

  console.log("\n→ reading the event back from OBERHAHN…");
  const rows = await readBack(base, key, smokeId);
  if (rows === null) return; // readback not permitted; not an ingest failure
  if (rows.length === 0) die("event NOT found on readback — check the endpoint, key scope, and logs.");
  console.log(`\n✓ event landed. matched ${rows.length} row(s):`);
  console.log(JSON.stringify(rows[0], null, 2));

  const miss = metadataMismatches(rows[0], meta);
  if (miss.length > 0) die(`metadata did NOT round-trip:\n    - ${miss.join("\n    - ")}`);
  console.log(`\n✓ all ${Object.keys(meta).length} attribution fields round-tripped.`);
}
