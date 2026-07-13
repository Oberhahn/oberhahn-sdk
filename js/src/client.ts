import type { ResolvedConfig } from "./config.js";
import type { OberhahnEvent } from "./event.js";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function backoffMs(attempt: number): number {
  // 100ms, 200ms, 400ms, … (deterministic; no jitter dependency).
  return 100 * 2 ** attempt;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns config + the immediate-submit path to `POST {baseUrl}/events`.
 *
 * Immediate mode (the only mode): every accepted event kicks off its POST
 * right away (serverless-safe — nothing sits buffered waiting for a drain).
 * Submission is fire-and-forget from the caller's perspective; attribution
 * never blocks or breaks the wrapped request unless `throwOnError` is set.
 */
export class OberhahnClient {
  private inFlight = new Set<Promise<void>>();
  private warnedMisconfigured = false;

  constructor(readonly config: ResolvedConfig) {}

  get metadata(): Record<string, unknown> {
    return this.config.metadata;
  }

  get throwOnError(): boolean {
    return this.config.throwOnError;
  }

  /** Enqueue (and, in immediate mode, immediately begin sending) one event. */
  submit(event: OberhahnEvent): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (!this.config.apiKey || !this.config.baseUrl) {
      if (!this.warnedMisconfigured) {
        this.warnedMisconfigured = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[oberhahn] apiKey/baseUrl not configured — events are being dropped. " +
            "Call init({ apiKey, baseUrl }) or set OBERHAHN_API_KEY / OBERHAHN_BASE_URL.",
        );
      }
      return Promise.resolve();
    }

    const task = this.post(event, 0);
    const tracked = task.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);

    if (this.config.throwOnError) return tracked;
    return tracked.catch((err) => {
      this.config.onError?.(err);
    });
  }

  /**
   * Await all in-flight submissions. Not part of the public API surface (the
   * SDK ships no `flush`); used by tests and available for graceful shutdown.
   * @internal
   */
  async awaitPending(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async post(event: OberhahnEvent, attempt: number): Promise<void> {
    const url = `${this.config.baseUrl!.replace(/\/$/, "")}/events`;
    let res: Response;
    try {
      res = await this.config.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      });
    } catch (err) {
      // Network/transport failure — retry then give up.
      if (attempt < this.config.maxRetries) {
        await delay(backoffMs(attempt));
        return this.post(event, attempt + 1);
      }
      throw err;
    }

    if (!res.ok) {
      if (RETRYABLE.has(res.status) && attempt < this.config.maxRetries) {
        await delay(backoffMs(attempt));
        return this.post(event, attempt + 1);
      }
      throw new Error(`[oberhahn] ingest failed: ${res.status} ${res.statusText}`);
    }
  }
}
