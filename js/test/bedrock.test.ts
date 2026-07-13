import { describe, expect, it } from "vitest";
import { wrapBedrock } from "../src/index.js";
import { mapBedrockModel } from "../src/adapters/bedrock.js";
import { initCapturing } from "./helpers.js";

class ConverseCommand {
  constructor(readonly input: { modelId: string }) {}
}
class ConverseStreamCommand {
  constructor(readonly input: { modelId: string }) {}
}
class ListFoundationModelsCommand {
  constructor(readonly input: Record<string, unknown> = {}) {}
}

function fakeBedrock(send: (cmd: unknown) => unknown) {
  return { middlewareStack: {}, send: async (cmd: unknown) => send(cmd) };
}

describe("bedrock adapter", () => {
  it("maps bedrock model ids to canonical provider/model", () => {
    expect(mapBedrockModel("us.anthropic.claude-3-5-sonnet-20240620-v1:0")).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    expect(mapBedrockModel("anthropic.claude-3-haiku-20240307-v1:0")).toEqual({
      provider: "anthropic",
      model: "claude-3-haiku",
    });
  });

  it("extracts usage from a ConverseCommand and maps the model", async () => {
    const { client, calls } = initCapturing();
    const bedrock = wrapBedrock(
      fakeBedrock(() => ({ usage: { inputTokens: 500, outputTokens: 90 } })),
    );

    await bedrock.send(new ConverseCommand({ modelId: "us.anthropic.claude-3-5-sonnet-20240620-v1:0" }));
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      source: "sdk_bedrock",
      spend_details: {
        model_provider: "anthropic",
        model: "claude-3-5-sonnet",
        input_tokens: 500,
        output_tokens: 90,
      },
    });
  });

  it("ignores non-Converse commands (they pass through, no event)", async () => {
    const { client, calls } = initCapturing();
    const bedrock = wrapBedrock(fakeBedrock(() => ({ modelSummaries: [] })));

    const res = await bedrock.send(new ListFoundationModelsCommand());
    await client.awaitPending();

    expect((res as { modelSummaries: unknown[] }).modelSummaries).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reads obMetadata off a Command instance without breaking the command", async () => {
    const { client, calls } = initCapturing();
    const bedrock = wrapBedrock(
      fakeBedrock(() => ({ usage: { inputTokens: 3, outputTokens: 1 } })),
    );
    const cmd = new ConverseCommand({ modelId: "anthropic.claude-3-haiku-20240307-v1:0" });
    // Attach per-call attribution to the command instance (documented pattern).
    Object.assign(cmd, { obMetadata: { customer_id: "cust_9", session_id: "conv_1" } });

    await bedrock.send(cmd);
    await client.awaitPending();

    // Command survived (model still parsed → constructor/prototype intact) and
    // our key was stripped before send saw it.
    expect(cmd).not.toHaveProperty("obMetadata");
    expect(cmd).toBeInstanceOf(ConverseCommand);
    expect(calls[0].body).toMatchObject({
      provider_session_id: "conv_1",
      custom: { customer_id: "cust_9" },
      spend_details: { model: "claude-3-haiku", model_provider: "anthropic" },
    });
  });

  it("reads usage from a ConverseStream metadata event", async () => {
    const { client, calls } = initCapturing();
    const bedrock = wrapBedrock(
      fakeBedrock(() => ({
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: "hi" } } };
          yield { metadata: { usage: { inputTokens: 12, outputTokens: 4 } } };
        })(),
      })),
    );

    const res = (await bedrock.send(
      new ConverseStreamCommand({ modelId: "anthropic.claude-3-haiku-20240307-v1:0" }),
    )) as { stream: AsyncIterable<unknown> };
    for await (const _ of res.stream) void _;
    await client.awaitPending();

    expect(calls[0].body).toMatchObject({
      spend_details: { model_provider: "anthropic", model: "claude-3-haiku", input_tokens: 12, output_tokens: 4 },
    });
  });
});
