import { describe, expect, it } from "vitest";
import { wrap } from "../src/index.js";
import { initCapturing } from "./helpers.js";

function fakeAnthropic(create?: (body: unknown) => unknown) {
  return {
    messages: {
      create:
        create ??
        (async () => ({
          id: "msg_1",
          model: "claude-3-5-sonnet",
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 10,
          },
        })),
    },
  };
}

describe("anthropic adapter", () => {
  it("normalizes a dated snapshot model to its bare alias", async () => {
    const { client, calls } = initCapturing();
    const anthropic = wrap(
      fakeAnthropic(async () => ({
        id: "msg",
        model: "claude-3-5-sonnet-20240620",
        usage: { input_tokens: 5, output_tokens: 2 },
      })),
    );

    await anthropic.messages.create({ model: "claude-3-5-sonnet-20240620", messages: [] });
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      spend_details: { model_provider: "anthropic", model: "claude-3-5-sonnet" },
    });
  });

  it("carries the cache write/read split and totals cached_tokens", async () => {
    const { client, calls } = initCapturing();
    const anthropic = wrap(fakeAnthropic());

    await anthropic.messages.create({ model: "claude-3-5-sonnet", messages: [] });
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      source: "sdk_anthropic",
      provider_message_id: "msg_1",
      spend_details: {
        model_provider: "anthropic",
        model: "claude-3-5-sonnet",
        input_tokens: 1200,
        output_tokens: 300,
        cache_write_tokens: 40,
        cache_read_tokens: 10,
        cached_tokens: 50,
      },
    });
  });

  it("assembles streamed usage across message_start + message_delta", async () => {
    const { client, calls } = initCapturing();
    const anthropic = {
      messages: {
        create: async (_body?: unknown) =>
          (async function* () {
            yield {
              type: "message_start",
              message: {
                id: "msg_s",
                model: "claude-3-5-sonnet",
                usage: { input_tokens: 800, cache_read_input_tokens: 5 },
              },
            };
            yield { type: "content_block_delta", delta: { text: "hi" } };
            yield { type: "message_delta", usage: { output_tokens: 120 } };
          })(),
      },
    };
    const client2 = wrap(anthropic);

    const stream = await client2.messages.create({ model: "claude-3-5-sonnet", stream: true } as never);
    for await (const _ of stream as AsyncIterable<unknown>) void _;
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      provider_message_id: "msg_s",
      spend_details: {
        input_tokens: 800,
        output_tokens: 120,
        cache_read_tokens: 5,
        model: "claude-3-5-sonnet",
      },
    });
  });
});
