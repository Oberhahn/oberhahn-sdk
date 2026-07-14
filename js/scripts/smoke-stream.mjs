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
import { init } from "../dist/index.js";
import { chooseProvider, runSmoke } from "./smoke-providers.mjs";

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
  const provider = chooseProvider();
  const meta = { smoke_id: smokeId, session_id: smokeId, feature: "sdk_smoke_stream" };

  console.log("\n→ making real streaming provider call…");
  await runSmoke(provider, true, meta);

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
