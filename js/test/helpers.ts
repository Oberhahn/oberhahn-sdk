import { vi } from "vitest";
import { init } from "../src/index.js";
import type { OberhahnClient } from "../src/client.js";

export interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetch spy that records each POST body and returns 202. */
export function captureFetch(): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchSpy = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(opts?.body ?? "{}")),
      headers: (opts?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return { fetch: fetchSpy as unknown as typeof fetch, calls };
}

/** init() the SDK with a capturing fetch and return the client + calls. */
export function initCapturing(
  extra: Record<string, unknown> = {},
): { client: OberhahnClient; calls: Captured[] } {
  const { fetch, calls } = captureFetch();
  const client = init({
    apiKey: "oak_test",
    baseUrl: "https://oberhahn.test/v0",
    fetch,
    ...extra,
  });
  return { client, calls };
}
