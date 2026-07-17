import { describe, expect, it } from "vitest";
import { stripModelDate } from "../src/adapters/normalize.js";

describe("stripModelDate", () => {
  it("strips Anthropic's solid -YYYYMMDD snapshot suffix", () => {
    expect(stripModelDate("claude-3-5-sonnet-20240620")).toBe("claude-3-5-sonnet");
    expect(stripModelDate("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
  });

  it("strips OpenAI's dashed -YYYY-MM-DD snapshot suffix", () => {
    expect(stripModelDate("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(stripModelDate("o1-2024-12-17")).toBe("o1");
  });

  it("leaves a bare alias untouched", () => {
    expect(stripModelDate("gpt-4o")).toBe("gpt-4o");
    expect(stripModelDate("claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
    expect(stripModelDate("unknown")).toBe("unknown");
  });

  it("does not touch a 4-digit YYMM tag that is part of the name", () => {
    // Anchored at the end and requires 8 digits (or a dashed date), so a
    // Mistral-style `-2407` version tag survives.
    expect(stripModelDate("mistral-large-2407")).toBe("mistral-large-2407");
  });
});
