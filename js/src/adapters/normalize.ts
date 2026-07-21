/**
 * Shared model-id normalization, applied by every adapter before it emits
 * `ProviderUsage.model`.
 *
 * Providers report the same model under a bare alias (`gpt-4o`,
 * `claude-3-5-sonnet`) and as a dated snapshot (`gpt-4o-2024-08-06`,
 * `claude-3-5-sonnet-20240620`). OBERHAHN's pricing table keys on the bare
 * alias, and its `by_model` breakdowns group on the literal string we send, so
 * stripping the date here (a) keeps the model priceable and (b) rolls every
 * dated snapshot up into one row instead of fragmenting the breakdown per date.
 *
 * The regex mirrors the ledger's own `DATE_SUFFIX_RE`
 * (`oberhahn-loop/src/domain/pricing.ts`) so the SDK and server never disagree
 * about what "the same model" is — it covers Anthropic's solid `-YYYYMMDD` and
 * OpenAI's dashed `-YYYY-MM-DD`. Anchored at the end, so it never touches a
 * 4-digit `YYMM` tag that is part of the name (`mistral-large-2407`).
 */
const DATE_SUFFIX_RE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/** Strip a trailing dated-snapshot suffix to recover the bare model alias. */
export function stripModelDate(model: string): string {
  return model.replace(DATE_SUFFIX_RE, "");
}
