# OBERHAHN SDK — agent guide

Monorepo: `js/` (`@oberhahn/sdk`) and `python/` (`oberhahn`). Both wrap native
provider SDK clients (OpenAI / Anthropic / Bedrock / Gemini), extract token usage
+ attribution, and POST canonical events to OBERHAHN. Thin by design: never price,
never send prompt/response content, never break the wrapped call.

## Adding a provider

Follow `.claude/commands/add-provider.md` and `SPECS.md` (the adapter contract).
It's a one-file-per-language adapter + tests + a drift canary + a dep pin + one
smoke-table entry. Correctness is proven by the drift canaries in CI against the
real provider SDK types — **no API key is needed** to get a green PR.

## When resolving an issue via the GitHub Action (`@claude`)

If the issue asks for a code change (e.g. adding a provider), after you've
committed your work to the working branch, **open a pull request** — don't just
leave a branch and a link:

```sh
gh pr create --base main \
  --title "<conventional-commit title>" \
  --body "Closes #<issue-number>

<one-paragraph summary of what changed + what CI validates>"
```

Then make sure CI is green (`js`, `python` jobs) before reporting done. Never put
a real API key in the repo, a fixture, or a PR comment.
