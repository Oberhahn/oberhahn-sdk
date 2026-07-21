import { describe, expect, it } from "vitest";
import { wrap } from "../src/index.js";
import { initCapturing } from "./helpers.js";

/** Minimal stand-in for the OpenAI client shape the adapter detects/patches. */
function fakeOpenAI(handlers: {
  chat?: (body: unknown) => unknown;
  responses?: (body: unknown) => unknown;
  embeddings?: (body: unknown) => unknown;
} = {}) {
  return {
    chat: {
      completions: {
        create: async (body: unknown) =>
          handlers.chat?.(body) ?? {
            id: "chatcmpl_1",
            model: "gpt-4o",
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 300,
              prompt_tokens_details: { cached_tokens: 200 },
            },
          },
      },
    },
    // The Responses API reports usage with input_tokens/output_tokens and a
    // nested input_tokens_details.cached_tokens (unlike Chat's prompt_tokens),
    // so it exercises usageFrom's ?? fallbacks distinctly from the chat path.
    responses: {
      create: async (body: unknown) =>
        handlers.responses?.(body) ?? {
          id: "resp_1",
          model: "gpt-4o",
          usage: {
            input_tokens: 800,
            output_tokens: 120,
            input_tokens_details: { cached_tokens: 300 },
          },
        },
    },
    embeddings: {
      create: async (body: unknown) =>
        handlers.embeddings?.(body) ?? {
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 50, total_tokens: 50 },
        },
    },
  };
}

describe("openai adapter", () => {
  it("normalizes a dated snapshot model to its bare alias", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(
      fakeOpenAI({
        chat: () => ({ id: "c", model: "gpt-4o-2024-08-06", usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      }),
    );

    await openai.chat.completions.create({ model: "gpt-4o-2024-08-06", messages: [] });
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      spend_details: { model_provider: "openai", model: "gpt-4o" },
    });
  });

  it("extracts usage from chat.completions.create and posts an event", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(fakeOpenAI());

    const res = await openai.chat.completions.create({ model: "gpt-4o", messages: [] });
    await client.awaitPending();

    expect((res as { id: string }).id).toBe("chatcmpl_1"); // caller still gets the result
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oberhahn.test/v0/events");
    expect(calls[0].headers.authorization).toBe("Bearer oak_test");
    expect(calls[0].body).toMatchObject({
      source: "sdk_oberhahn",
      consumer_type: "customer",
      provider_message_id: "chatcmpl_1",
      spend_details: {
        model_provider: "openai",
        model: "gpt-4o",
        input_tokens: 1000,
        output_tokens: 300,
        cache_read_tokens: 200,
        cached_tokens: 200,
      },
    });
  });

  it("extracts usage from responses.create (input_tokens + input_tokens_details)", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(fakeOpenAI());

    const res = await openai.responses.create({ model: "gpt-4o", input: "hi" } as never);
    await client.awaitPending();

    expect((res as { id: string }).id).toBe("resp_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      source: "sdk_oberhahn",
      provider_message_id: "resp_1",
      spend_details: {
        model_provider: "openai",
        model: "gpt-4o",
        // input_tokens (800) is the total incl. the 300 cached; the adapter
        // reports the 500 non-cached remainder and prices the 300 separately.
        input_tokens: 500,
        output_tokens: 120,
        cache_read_tokens: 300,
        cached_tokens: 300,
      },
    });
  });

  it("extracts usage from embeddings.create (no cache, no stream)", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(fakeOpenAI());

    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "hi",
    } as never);
    await client.awaitPending();

    expect((res as { model: string }).model).toBe("text-embedding-3-small");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      source: "sdk_oberhahn",
      spend_details: {
        model_provider: "openai",
        model: "text-embedding-3-small",
        input_tokens: 50,
        output_tokens: 0,
      },
    });
    // No cached subset reported → the split fields must be absent, not 0/null.
    expect(calls[0].body.spend_details).not.toHaveProperty("cache_read_tokens");
  });

  it("routes obMetadata and strips it before the provider call", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const { client, calls } = initCapturing();
    const openai = wrap(
      fakeOpenAI({
        chat: (body) => {
          seenBody = body as Record<string, unknown>;
          return { id: "c2", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 2 } };
        },
      }),      { metadata: { environment: "production", feature: "support_agent" } },
    );

    await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      obMetadata: { customer_id: "cust_123", session_id: "conv_9", turn_id: "t1" },
    } as never);
    await client.awaitPending();

    expect(seenBody).not.toHaveProperty("obMetadata"); // stripped before forwarding
    expect(calls[0].body).toMatchObject({
      provider_session_id: "conv_9",
      custom: { environment: "production", feature: "support_agent", customer_id: "cust_123", turn_id: "t1" },
    });
  });

  it("captures usage from a streamed response (include_usage final chunk)", async () => {
    const { client, calls } = initCapturing();
    const streaming = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { id: "s1", model: "gpt-4o", choices: [{ delta: { content: "hi" } }] };
              yield { id: "s1", model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5 } };
            })(),
        },
      },
      embeddings: { create: async () => ({}) },
    };
    const openai = wrap(streaming);

    const stream = await openai.chat.completions.create({ model: "gpt-4o", stream: true } as never);
    const seen: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) seen.push(chunk);
    await client.awaitPending();

    expect(seen).toHaveLength(2); // caller still receives every chunk
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      spend_details: { input_tokens: 10, output_tokens: 5, model: "gpt-4o" },
    });
  });

  it("tags an OpenAI-compatible provider as custom.provider (model_provider stays openai)", async () => {
    const { client, calls } = initCapturing();
    const openrouter = wrap(fakeOpenAI(), { provider: "openrouter" });

    await openrouter.chat.completions.create({ model: "gpt-4o", messages: [] });
    await client.awaitPending();

    expect(calls[0].body.spend_details.model_provider).toBe("openai");
    expect(calls[0].body.custom).toEqual({ provider: "openrouter" });
  });

  it("does not tag custom.provider for a native openai client", async () => {
    const { client, calls } = initCapturing();
    const openai = wrap(fakeOpenAI());

    await openai.chat.completions.create({ model: "gpt-4o", messages: [] });
    await client.awaitPending();

    expect(calls[0].body).not.toHaveProperty("custom");
  });

  it("lets a user obMetadata.provider win over the alias tag", async () => {
    const { client, calls } = initCapturing();
    const openrouter = wrap(fakeOpenAI(), { provider: "openrouter" });

    await openrouter.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      obMetadata: { provider: "my_gateway" },
    } as never);
    await client.awaitPending();

    expect(calls[0].body.custom).toMatchObject({ provider: "my_gateway" });
  });

  it("forwards a provider-reported cost when present", async () => {
    const { client, calls } = initCapturing();
    const openrouter = wrap(
      fakeOpenAI({
        chat: () => ({ id: "or_1", model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00042 } }),
      }),
      { provider: "openrouter" },
    );

    await openrouter.chat.completions.create({ model: "gpt-4o", messages: [] });
    await client.awaitPending();

    // Cost is forwarded both top-level (the field the server reads) and nested.
    expect(calls[0].body.cost).toBe(0.00042);
    expect(calls[0].body.spend_details.cost).toBe(0.00042);
  });
});
