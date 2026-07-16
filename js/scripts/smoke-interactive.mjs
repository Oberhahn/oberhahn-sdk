#!/usr/bin/env node
/**
 * Interactive live smoke test for @oberhahn/sdk.
 *
 * Prompts for everything at the terminal — pick a provider, type the API
 * key(s) (hidden), choose streaming — then hands off to the existing
 * smoke.mjs / smoke-stream.mjs runners (real provider call → post event →
 * read back). Values already in the environment / sdk/.env are offered as
 * defaults so you can just press enter.
 *
 *   Run:  npm run smoke:interactive
 *
 * Makes a real (tiny, cheap) provider call and writes a real event to the
 * configured OBERHAHN endpoint, so run it deliberately.
 */
import readline from "node:readline";
import { loadEnv, runSmokeTest } from "./smoke-run.mjs";

// Offer values from js/.env as defaults.
loadEnv();

// One entry per provider. `fields` are the credentials to collect (secret ones
// are typed hidden); `model` is the optional model override. Add a provider here
// when you add one to smoke-providers.mjs.
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const defaultWrite = rl._writeToOutput.bind(rl);

/** Visible prompt → trimmed answer. */
const ask = (query) => new Promise((resolve) => rl.question(query, (a) => resolve(a.trim())));

/** Hidden prompt (typed characters are not echoed) → trimmed answer. Masking
 * only applies to an interactive TTY; piped input reads normally. */
function askSecret(query) {
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
}

/**
 * Prompt for one field, offering the existing env value as a default (press
 * enter to keep it). Required fields loop until non-empty.
 */
async function collect({ name, prompt, secret }, { required = true } = {}) {
  const existing = process.env[name];
  const hint = existing ? (secret ? " [enter to keep existing]" : ` [enter to keep ${existing}]`) : "";
  for (;;) {
    const answer = secret ? await askSecret(`${prompt}${hint}: `) : await ask(`${prompt}${hint}: `);
    if (answer) return answer;
    if (existing) return existing; // keep the current value
    if (!required) return undefined;
    console.log("  (required)");
  }
}

async function selectProvider() {
  const slugs = Object.keys(CONFIG);
  console.log("\nSelect a provider:");
  slugs.forEach((slug, i) => console.log(`  ${i + 1}) ${CONFIG[slug].label}`));
  for (;;) {
    const choice = await ask("Provider [1]: ");
    if (choice === "") return slugs[0];
    const byNum = Number(choice);
    if (Number.isInteger(byNum) && byNum >= 1 && byNum <= slugs.length) return slugs[byNum - 1];
    const bySlug = choice.toLowerCase();
    if (slugs.includes(bySlug)) return bySlug;
    console.log(`  pick 1–${slugs.length} (or a name: ${slugs.join(", ")})`);
  }
}

async function main() {
  console.log("OBERHAHN interactive smoke test");

  const provider = await selectProvider();
  const cfg = CONFIG[provider];
  console.log(`\n→ ${cfg.label}\n`);

  // Provider credentials.
  for (const field of cfg.fields) {
    process.env[field.name] = await collect(field);
  }

  // Optional model override.
  if (cfg.model) {
    const current = process.env[cfg.model.name] || cfg.model.default;
    const answer = await ask(`Model [enter for ${current}]: `);
    process.env[cfg.model.name] = answer || current;
  }

  // Streaming (only if the provider's smoke runner supports it).
  let streaming = false;
  if (cfg.streams) {
    const answer = (await ask("Streaming? [y/N]: ")).toLowerCase();
    streaming = answer === "y" || answer === "yes";
  }

  // OBERHAHN endpoint + key: reuse from env/.env when present, else prompt.
  process.env.OBERHAHN_BASE_URL =
    process.env.OBERHAHN_BASE_URL ||
    (await ask("OBERHAHN base URL (incl. /v0): "));
  if (!process.env.OBERHAHN_API_KEY) {
    process.env.OBERHAHN_API_KEY = await askSecret("OBERHAHN oak_ key: ");
  }

  // Force the chosen provider for the harness, then hand off — it makes the real
  // call, posts the event, and reads it back from the process.env we populated.
  process.env.OBERHAHN_SMOKE_PROVIDER = provider;
  console.log(
    `\n→ running ${cfg.label} smoke${streaming ? " (streaming)" : ""} against ${process.env.OBERHAHN_BASE_URL}\n`,
  );
  rl.close();
  await runSmokeTest(streaming);
}

main().catch((err) => {
  console.error(`\n✗ ${err?.stack ?? String(err)}\n`);
  rl.close();
  process.exit(1);
});
