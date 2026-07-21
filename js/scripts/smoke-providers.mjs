// Provider smoke runners — ONE entry per provider covers BOTH smoke scripts
// (non-stream + stream). Adding a provider = one entry here, not a runner in
// each of smoke.mjs / smoke-stream.mjs. Each returns
// { provider_message_id?, usage? }; streaming returns {} (usage is extracted
// from the stream by the SDK and confirmed on read-back). `wrap()` uses the
// global client the calling script init()'d.
import { wrap } from "../dist/index.js";

const PROMPT = "Give me a 200 word paragraph.";
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

export const SMOKE_PROVIDERS = {
  async openai(streaming, meta) {
    const { default: OpenAI } = await import("openai");
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const client = wrap(new OpenAI());
    console.log(`  provider : openai (${model}${streaming ? ", streaming" : ""})`);
    const args = { model, max_tokens: 100, messages: [{ role: "user", content: PROMPT }], obMetadata: meta };
    if (streaming) {
      const s = await client.chat.completions.create({ ...args, stream: true, stream_options: { include_usage: true } });
      let n = 0;
      for await (const _ of s) n++;
      console.log(`  consumed ${n} chunk(s)`);
      return {};
    }
    const res = await client.chat.completions.create(args);
    return { provider_message_id: res.id, usage: res.usage };
  },

  async anthropic(streaming, meta) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
    const client = wrap(new Anthropic());
    console.log(`  provider : anthropic (${model}${streaming ? ", streaming" : ""})`);
    const args = { model, max_tokens: 100, messages: [{ role: "user", content: PROMPT }], obMetadata: meta };
    if (streaming) {
      const s = await client.messages.create({ ...args, stream: true });
      let n = 0;
      for await (const _ of s) n++;
      console.log(`  consumed ${n} event(s)`);
      return {};
    }
    const res = await client.messages.create(args);
    return { provider_message_id: res.id, usage: res.usage };
  },

  async bedrock(streaming, meta) {
    const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) die("Set AWS_REGION for the Bedrock smoke (plus AWS credentials).");
    const modelId = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0";
    const client = wrap(new BedrockRuntimeClient({ region }));
    console.log(`  provider : bedrock (${modelId}, ${region}${streaming ? ", streaming" : ""})`);
    const input = { modelId, messages: [{ role: "user", content: [{ text: PROMPT }] }], inferenceConfig: { maxTokens: 16 } };
    const command = streaming ? new ConverseStreamCommand(input) : new ConverseCommand(input);
    // Per-call attribution on the command instance (SDK strips it before send).
    Object.assign(command, { obMetadata: meta });
    const res = await client.send(command);
    if (streaming) {
      let n = 0;
      for await (const _ of res.stream) n++;
      console.log(`  consumed ${n} event(s)`);
      return {};
    }
    return { usage: res.usage };
  },

  async gemini(streaming, meta) {
    const { GoogleGenAI } = await import("@google/genai");
    const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
    const client = wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY }));
    console.log(`  provider : gemini (${model}${streaming ? ", streaming" : ""})`);
    const args = { model, contents: PROMPT, obMetadata: meta };
    if (streaming) {
      const s = await client.models.generateContentStream(args);
      let n = 0;
      for await (const _ of s) n++;
      console.log(`  consumed ${n} chunk(s)`);
      return {};
    }
    const res = await client.models.generateContent(args);
    return { provider_message_id: res.responseId, usage: res.usageMetadata };
  },

  async openrouter(streaming, meta) {
    // OpenRouter is OpenAI-wire-compatible: the OpenAI client pointed at
    // OpenRouter's base URL, wrapped with an explicit provider so the event is
    // tagged custom.provider="openrouter" (model_provider stays "openai").
    const { default: OpenAI } = await import("openai");
    if (!process.env.OPENROUTER_API_KEY) die("Set OPENROUTER_API_KEY for the OpenRouter smoke.");
    const baseURL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
    const client = wrap(new OpenAI({ baseURL, apiKey: process.env.OPENROUTER_API_KEY }), { provider: "openrouter" });
    console.log(`  provider : openrouter (${model} @ ${baseURL}${streaming ? ", streaming" : ""})`);
    // usage.include asks OpenRouter to report cost, which the OpenAI adapter
    // forwards to spend_details.cost.
    const args = { model, max_tokens: 100, messages: [{ role: "user", content: PROMPT }], usage: { include: true }, obMetadata: meta };
    if (streaming) {
      const s = await client.chat.completions.create({ ...args, stream: true, stream_options: { include_usage: true } });
      let n = 0;
      for await (const _ of s) n++;
      console.log(`  consumed ${n} chunk(s)`);
      return {};
    }
    const res = await client.chat.completions.create(args);
    return { provider_message_id: res.id, usage: res.usage };
  },
};

export function chooseProvider() {
  const forced = process.env.OBERHAHN_SMOKE_PROVIDER;
  if (forced) return forced;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_REGION)
    return "bedrock";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  die(
    "No provider selected. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS creds, GEMINI_API_KEY, " +
      "or OPENROUTER_API_KEY (or force with " +
      "OBERHAHN_SMOKE_PROVIDER=openai|anthropic|bedrock|gemini|openrouter).",
  );
}

export async function runSmoke(provider, streaming, meta) {
  const fn = SMOKE_PROVIDERS[provider];
  if (!fn) die(`Unknown provider "${provider}". Known: ${Object.keys(SMOKE_PROVIDERS).join(", ")}.`);
  return fn(streaming, meta);
}
