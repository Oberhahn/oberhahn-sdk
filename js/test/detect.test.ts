import { describe, expect, it } from "vitest";
import { detectProvider } from "../src/detect.js";

// Fakes carrying the same API surface each adapter patches — detection
// duck-types on those methods, so these exercise the real code path.
const openai = { chat: { completions: { create() {} } } };
const openaiResponses = { responses: { create() {} } };
const anthropic = { messages: { create() {} } };
const gemini = { models: { generateContent() {} } };
const bedrock = { send() {}, middlewareStack: {} };

describe("detectProvider", () => {
  it("detects each provider by its API surface", () => {
    expect(detectProvider(openai)).toBe("openai");
    expect(detectProvider(openaiResponses)).toBe("openai");
    expect(detectProvider(anthropic)).toBe("anthropic");
    expect(detectProvider(gemini)).toBe("gemini");
    expect(detectProvider(bedrock)).toBe("bedrock");
  });

  it("folds OpenAI-compatible clients (same surface) to openai", () => {
    // e.g. an OpenAI client pointed at OpenRouter/Azure — pass { provider } to
    // select a different adapter.
    const compat = { chat: { completions: { create() {} } }, baseURL: "https://openrouter.ai/api/v1" };
    expect(detectProvider(compat)).toBe("openai");
  });

  it("throws (never guesses) for an unrecognized client", () => {
    expect(() => detectProvider({ foo() {} })).toThrow(/couldn't detect the provider/);
    // A bare `send` isn't enough to claim Bedrock.
    expect(() => detectProvider({ send() {} })).toThrow(/couldn't detect the provider/);
  });
});
