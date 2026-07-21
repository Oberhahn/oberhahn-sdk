import { describe, expect, it } from "vitest";
import { wrap } from "../src/index.js";
import { initCapturing } from "./helpers.js";

/** Minimal stand-in for the @google/genai client shape the adapter patches. */
function fakeGemini(handlers: {
  generate?: (body: unknown) => unknown;
  stream?: (body: unknown) => unknown;
} = {}) {
  return {
    models: {
      generateContent: async (body: unknown) =>
        handlers.generate?.(body) ?? {
          responseId: "resp_1",
          modelVersion: "gemini-2.0-flash",
          usageMetadata: {
            promptTokenCount: 1200,
            candidatesTokenCount: 300,
            cachedContentTokenCount: 200,
            totalTokenCount: 1500,
          },
        },
      generateContentStream: async (body: unknown) =>
        handlers.stream?.(body) ??
        (async function* () {
          yield { modelVersion: "gemini-2.0-flash", candidates: [{ content: { parts: [{ text: "hi" }] } }] };
          yield {
            responseId: "s1",
            modelVersion: "gemini-2.0-flash",
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              cachedContentTokenCount: 4,
            },
          };
        })(),
    },
  };
}

describe("gemini adapter", () => {
  it("normalizes the stable-version suffix off modelVersion", async () => {
    const { client, calls } = initCapturing();
    const gemini = wrap(
      fakeGemini({
        generate: () => ({
          responseId: "r",
          modelVersion: "gemini-1.5-pro-002",
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        }),
      }),
    );

    await gemini.models.generateContent({ model: "gemini-1.5-pro-002", contents: "hi" } as never);
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      spend_details: { model_provider: "google", model: "gemini-1.5-pro" },
    });
  });

  it("extracts usage from models.generateContent and posts an event", async () => {
    const { client, calls } = initCapturing();
    const gemini = wrap(fakeGemini());

    const res = await gemini.models.generateContent({ model: "gemini-2.0-flash", contents: "hi" } as never);
    await client.awaitPending();

    expect((res as { responseId: string }).responseId).toBe("resp_1"); // caller still gets the result
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      source: "sdk_oberhahn",
      provider_message_id: "resp_1",
      spend_details: {
        model_provider: "google",
        model: "gemini-2.0-flash",
        // promptTokenCount (1200) already includes the 200 cached tokens, so the
        // adapter reports the 1000 non-cached remainder as input_tokens.
        input_tokens: 1000,
        output_tokens: 300,
        cache_read_tokens: 200,
        cached_tokens: 200,
      },
    });
  });

  it("omits the cache split when no cached tokens are reported", async () => {
    const { client, calls } = initCapturing();
    const gemini = wrap(
      fakeGemini({
        generate: () => ({
          responseId: "resp_2",
          modelVersion: "gemini-2.0-flash",
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 },
        }),
      }),    );

    await gemini.models.generateContent({ model: "gemini-2.0-flash", contents: "hi" } as never);
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      spend_details: { model_provider: "google", model: "gemini-2.0-flash", input_tokens: 40, output_tokens: 12 },
    });
    // No cached subset reported → the split field must be absent, not 0/null.
    expect(calls[0].body.spend_details).not.toHaveProperty("cache_read_tokens");
  });

  it("routes obMetadata and strips it before the provider call", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const { client, calls } = initCapturing();
    const gemini = wrap(
      fakeGemini({
        generate: (body) => {
          seenBody = body as Record<string, unknown>;
          return {
            responseId: "r3",
            modelVersion: "gemini-2.0-flash",
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          };
        },
      }),    );

    await gemini.models.generateContent({
      model: "gemini-2.0-flash",
      contents: "hi",
      obMetadata: { customer_id: "cust_9", session_id: "conv_1" },
    } as never);
    await client.awaitPending();

    expect(seenBody).not.toHaveProperty("obMetadata"); // stripped before forwarding
    expect(calls[0].body).toMatchObject({
      provider_session_id: "conv_1",
      custom: { customer_id: "cust_9" },
    });
  });

  it("captures usage from a streamed generateContentStream (final chunk)", async () => {
    const { client, calls } = initCapturing();
    const gemini = wrap(fakeGemini());

    const stream = (await gemini.models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: "hi",
    } as never)) as AsyncIterable<unknown>;
    const seen: unknown[] = [];
    for await (const chunk of stream) seen.push(chunk);
    await client.awaitPending();

    expect(seen).toHaveLength(2); // caller still receives every chunk
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      spend_details: {
        model_provider: "google",
        model: "gemini-2.0-flash",
        input_tokens: 6, // 10 total − 4 cached
        output_tokens: 5,
        cache_read_tokens: 4,
      },
    });
  });

  it("emits a status:error event when generateContent throws", async () => {
    const { client, calls } = initCapturing();
    const gemini = wrap(
      fakeGemini({
        generate: () => {
          throw new Error("gemini down");
        },
      }),    );

    await expect(
      gemini.models.generateContent({ model: "gemini-2.0-flash", contents: "hi" } as never),
    ).rejects.toThrow("gemini down");
    await client.awaitPending();

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      status: "error",
      spend_details: { model_provider: "google", model: "gemini-2.0-flash", input_tokens: 0 },
    });
  });
});
