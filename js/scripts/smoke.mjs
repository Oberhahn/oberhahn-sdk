#!/usr/bin/env node
/**
 * Live smoke test for @oberhahn/sdk against a DEPLOYED OBERHAHN endpoint: makes
 * ONE real provider call, lets the SDK post the usage event, reads it back, and
 * verifies the attribution round-tripped.
 *
 *   npm run smoke               one non-streaming call (env-driven)
 *   npm run smoke:stream        one streaming call
 *   npm run smoke:interactive   prompt for provider / key / model / streaming
 *
 * Env (loaded from js/.env automatically; process.env wins):
 *   Required: OBERHAHN_BASE_URL (incl. /v0), OBERHAHN_API_KEY, one provider key.
 *   Optional: OPENAI_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL / BEDROCK_MODEL_ID,
 *             OBERHAHN_SMOKE_PROVIDER.
 *
 * Makes a real (tiny, cheap) API call and writes a real event, so run it
 * deliberately. Per-provider call logic lives in smoke-providers.mjs.
 */
import readline from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init } from "../dist/index.js";
import { chooseProvider, runSmoke } from "./smoke-providers.mjs";

/** Load js/.env (sibling of scripts/) as defaults; process.env still wins. */
function loadEnv() {
  const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  if (typeof process.loadEnvFile === "function" && existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Harness: real call → post event → read back → verify attribution.
// ---------------------------------------------------------------------------

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
async function runSmokeTest(streaming) {
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

// ---------------------------------------------------------------------------
// Interactive mode (--interactive): prompt for provider / key(s) / model /
// streaming, populate process.env, then run the harness.
// ---------------------------------------------------------------------------

// One entry per provider. `fields` are the credentials to collect (secret ones
// are typed hidden on a TTY). Mirrors smoke-providers.mjs.
const CONFIG = {
  openai: {
    label: "OpenAI",
    fields: [{ name: "OPENAI_API_KEY", prompt: "OpenAI API key", secret: true }],
    model: { name: "OPENAI_MODEL", default: "gpt-4o-mini" },
    streams: true,
  },
  anthropic: {
    label: "Anthropic",
    fields: [{ name: "ANTHROPIC_API_KEY", prompt: "Anthropic API key", secret: true }],
    model: { name: "ANTHROPIC_MODEL", default: "claude-haiku-4-5" },
    streams: true,
  },
  bedrock: {
    label: "AWS Bedrock",
    fields: [
      { name: "AWS_ACCESS_KEY_ID", prompt: "AWS access key id", secret: true },
      { name: "AWS_SECRET_ACCESS_KEY", prompt: "AWS secret access key", secret: true },
      { name: "AWS_REGION", prompt: "AWS region (e.g. us-east-1)", secret: false },
    ],
    model: { name: "BEDROCK_MODEL_ID", default: "anthropic.claude-3-5-haiku-20241022-v1:0" },
    streams: true,
  },
  gemini: {
    label: "Google Gemini",
    fields: [{ name: "GEMINI_API_KEY", prompt: "Gemini API key", secret: true }],
    model: { name: "GEMINI_MODEL", default: "gemini-2.0-flash" },
    streams: true,
  },
};

async function runInteractive() {
  loadEnv();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const defaultWrite = rl._writeToOutput.bind(rl);
  const ask = (query) => new Promise((resolve) => rl.question(query, (a) => resolve(a.trim())));

  // Hidden prompt (no echo). Masking only applies to an interactive TTY; piped
  // input reads normally.
  const askSecret = (query) => {
    if (!process.stdin.isTTY) return ask(query);
    return new Promise((resolve) => {
      process.stdout.write(query);
      rl._writeToOutput = () => {};
      rl.question("", (value) => {
        rl._writeToOutput = defaultWrite;
        process.stdout.write("\n");
        resolve(value.trim());
      });
    });
  };

  // Prompt for one field — but skip entirely when it's already set (from .env
  // or the environment); just use the existing value.
  const collect = async ({ name, prompt, secret }) => {
    if (process.env[name]) {
      console.log(`  using ${name} from the environment`);
      return process.env[name];
    }
    for (;;) {
      const answer = secret ? await askSecret(`${prompt}: `) : await ask(`${prompt}: `);
      if (answer) return answer;
      console.log("  (required)");
    }
  };

  const slugs = Object.keys(CONFIG);
  console.log("OBERHAHN interactive smoke test\n\nSelect a provider:");
  slugs.forEach((slug, i) => console.log(`  ${i + 1}) ${CONFIG[slug].label}`));
  let provider = slugs[0];
  for (;;) {
    const choice = await ask("Provider [1]: ");
    if (choice === "") break;
    const byNum = Number(choice);
    if (Number.isInteger(byNum) && byNum >= 1 && byNum <= slugs.length) {
      provider = slugs[byNum - 1];
      break;
    }
    if (slugs.includes(choice.toLowerCase())) {
      provider = choice.toLowerCase();
      break;
    }
    console.log(`  pick 1–${slugs.length} (or a name: ${slugs.join(", ")})`);
  }

  const cfg = CONFIG[provider];
  console.log(`\n→ ${cfg.label}\n`);

  for (const field of cfg.fields) {
    process.env[field.name] = await collect(field);
  }
  if (cfg.model) {
    const current = process.env[cfg.model.name] || cfg.model.default;
    process.env[cfg.model.name] = (await ask(`Model [enter for ${current}]: `)) || current;
  }
  let streaming = false;
  if (cfg.streams) {
    streaming = ["y", "yes"].includes((await ask("Streaming? [y/N]: ")).toLowerCase());
  }

  // OBERHAHN endpoint + key: reuse from env when present, else prompt.
  process.env.OBERHAHN_BASE_URL =
    process.env.OBERHAHN_BASE_URL || (await ask("OBERHAHN base URL (incl. /v0): "));
  if (!process.env.OBERHAHN_API_KEY) {
    process.env.OBERHAHN_API_KEY = await askSecret("OBERHAHN oak_ key: ");
  }
  process.env.OBERHAHN_SMOKE_PROVIDER = provider;

  console.log(`\n→ running ${cfg.label} smoke${streaming ? " (streaming)" : ""}\n`);
  rl.close();
  await runSmokeTest(streaming);
}

// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const run = args.has("--interactive") ? runInteractive() : runSmokeTest(args.has("--stream"));
run.catch((err) => {
  console.error(`\n✗ ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
