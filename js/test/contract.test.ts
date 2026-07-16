/**
 * Contract / drift tests against the REAL provider SDK types.
 *
 * Unlike the per-adapter suites (which use hand-built fakes to test wiring),
 * this file imports the installed provider SDKs' response *types* and:
 *
 *   1. Type canaries — accessor functions typed against the real response
 *      types, reading exactly the fields each adapter depends on. If a bump
 *      renames/removes a field (e.g. `usage.prompt_tokens`), this file fails to
 *      `tsc` — the Dependabot drift tripwire, no API keys or network required.
 *   2. Runtime fixtures — objects pinned to the real types via `satisfies`, fed
 *      through the adapters to prove `extract()` still finds usage.
 *
 * If Dependabot opens a PR bumping `openai` / `@anthropic-ai/sdk` /
 * `@aws-sdk/client-bedrock-runtime` and an adapter's assumptions break, CI
 * (typecheck + this test) goes red and the PR does not auto-merge.
 */
import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { GenerateContentResponse, GenerateContentResponseUsageMetadata } from "@google/genai";
import { describe, expect, it } from "vitest";
import { openaiAdapter } from "../src/adapters/openai.js";
import { anthropicAdapter } from "../src/adapters/anthropic.js";
import { bedrockAdapter } from "../src/adapters/bedrock.js";
import { geminiAdapter } from "../src/adapters/gemini.js";

// ---------------------------------------------------------------------------
// 1. Type canaries — compile-time only. Each reads the exact fields the
//    matching adapter relies on. A shape change breaks the build here.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unused-vars */
function _openaiChatContract(r: OpenAI.Chat.Completions.ChatCompletion): void {
  const _id: string = r.id;
  const _model: string = r.model;
  const _in: number | undefined = r.usage?.prompt_tokens;
  const _out: number | undefined = r.usage?.completion_tokens;
  const _cacheRead: number | undefined = r.usage?.prompt_tokens_details?.cached_tokens;
}

function _openaiResponsesContract(u: OpenAI.Responses.ResponseUsage): void {
  const _in: number = u.input_tokens;
  const _out: number = u.output_tokens;
  const _cacheRead: number = u.input_tokens_details.cached_tokens;
}

function _openaiEmbeddingsContract(r: OpenAI.Embeddings.CreateEmbeddingResponse): void {
  const _in: number = r.usage.prompt_tokens;
  const _model: string = r.model;
}

function _anthropicContract(m: Anthropic.Messages.Message): void {
  const _id: string = m.id;
  const _model: string = m.model;
  const _in: number = m.usage.input_tokens;
  const _out: number = m.usage.output_tokens;
  const _cacheWrite: number | null = m.usage.cache_creation_input_tokens;
  const _cacheRead: number | null = m.usage.cache_read_input_tokens;
}

function _anthropicStreamContract(
  start: Anthropic.Messages.RawMessageStartEvent,
  delta: Anthropic.Messages.RawMessageDeltaEvent,
): void {
  const _startType: "message_start" = start.type;
  const _startIn: number = start.message.usage.input_tokens;
  const _deltaType: "message_delta" = delta.type;
  const _deltaOut: number = delta.usage.output_tokens;
}

function _bedrockContract(out: ConverseCommandOutput, u: TokenUsage): void {
  const _usage: TokenUsage | undefined = out.usage;
  const _in: number | undefined = u.inputTokens;
  const _out: number | undefined = u.outputTokens;
  const _cacheRead: number | undefined = u.cacheReadInputTokens;
  const _cacheWrite: number | undefined = u.cacheWriteInputTokens;
}

function _geminiContract(
  r: GenerateContentResponse,
  u: GenerateContentResponseUsageMetadata,
): void {
  const _id: string | undefined = r.responseId;
  const _model: string | undefined = r.modelVersion;
  const _usage: GenerateContentResponseUsageMetadata | undefined = r.usageMetadata;
  const _in: number | undefined = u.promptTokenCount;
  const _out: number | undefined = u.candidatesTokenCount;
  const _cacheRead: number | undefined = u.cachedContentTokenCount;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// 2. Runtime fixtures — pinned to the real types via `satisfies`, run through
//    the adapters. `satisfies` makes a field rename break compilation too.
// ---------------------------------------------------------------------------

describe("openai contract (real types)", () => {
  it("extract() reads a real-typed ChatCompletion usage block", () => {
    const usage = {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200 },
    } satisfies OpenAI.Completions.CompletionUsage;
    const result = { id: "chatcmpl_1", model: "gpt-4o", usage } satisfies Pick<
      OpenAI.Chat.Completions.ChatCompletion,
      "id" | "model" | "usage"
    >;

    const out = openaiAdapter.methods[0].extract(result, [{ model: "gpt-4o" }]);
    expect(out).toMatchObject({
      model: "gpt-4o",
      model_provider: "openai",
      // prompt_tokens (1200) already includes the 200 cached_tokens, so the
      // adapter reports the 1000 non-cached remainder as input_tokens (the
      // cached subset is priced separately via cache_read_tokens).
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_tokens: 200,
      provider_message_id: "chatcmpl_1",
    });
  });
});

describe("anthropic contract (real types)", () => {
  it("extract() reads a real-typed Message usage block", () => {
    const usage = {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 10,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } satisfies Anthropic.Messages.Usage;
    const result = { id: "msg_1", model: "claude-3-5-sonnet", usage } satisfies Pick<
      Anthropic.Messages.Message,
      "id" | "model" | "usage"
    >;

    const out = anthropicAdapter.methods[0].extract(result, [{ model: "claude-3-5-sonnet" }]);
    expect(out).toMatchObject({
      model: "claude-3-5-sonnet",
      model_provider: "anthropic",
      input_tokens: 1200,
      output_tokens: 300,
      cache_write_tokens: 40,
      cache_read_tokens: 10,
      provider_message_id: "msg_1",
    });
  });

  it("null cache counts (real type allows null) are dropped, not emitted", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } satisfies Anthropic.Messages.Usage;
    const out = anthropicAdapter.methods[0].extract({ id: "m", model: "x", usage }, [{}]);
    expect(out).not.toHaveProperty("cache_write_tokens");
    expect(out).not.toHaveProperty("cache_read_tokens");
  });
});

describe("bedrock contract (real types)", () => {
  it("extract() reads a real-typed ConverseCommandOutput usage block", () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 90,
      totalTokens: 590,
    } satisfies TokenUsage;
    // A ConverseCommand-shaped arg (constructor name drives the extract path).
    class ConverseCommand {
      constructor(readonly input: { modelId: string }) { }
    }
    const out = bedrockAdapter.methods[0].extract({ usage } as { usage: TokenUsage }, [
      new ConverseCommand({ modelId: "us.anthropic.claude-3-5-sonnet-20240620-v1:0" }),
    ]);
    expect(out).toMatchObject({
      model: "claude-3-5-sonnet",
      model_provider: "anthropic",
      input_tokens: 500,
      output_tokens: 90,
    });
  });
});

describe("gemini contract (real types)", () => {
  it("extract() reads a real-typed GenerateContentResponse usage block", () => {
    const usageMetadata = {
      promptTokenCount: 1200,
      candidatesTokenCount: 300,
      cachedContentTokenCount: 200,
      totalTokenCount: 1500,
    } satisfies GenerateContentResponseUsageMetadata;
    const result = {
      responseId: "resp_1",
      modelVersion: "gemini-2.0-flash",
      usageMetadata,
    } satisfies Pick<GenerateContentResponse, "responseId" | "modelVersion" | "usageMetadata">;

    const out = geminiAdapter.methods[0].extract(result, [{ model: "gemini-2.0-flash" }]);
    expect(out).toMatchObject({
      model: "gemini-2.0-flash",
      model_provider: "google",
      // promptTokenCount (1200) already includes the 200 cached tokens, so the
      // adapter reports the 1000 non-cached remainder as input_tokens.
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_tokens: 200,
      provider_message_id: "resp_1",
    });
  });
});
