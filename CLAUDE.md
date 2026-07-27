# OBERHAHN SDK — agent guide

Monorepo: `js/` (`@oberhahn/sdk`) and `python/` (`oberhahn`). Both wrap native
provider SDK clients (OpenAI / Anthropic / Bedrock / Gemini), extract token usage
+ attribution, and POST canonical events to OBERHAHN. Thin by design: never price,
never send prompt/response content, never break the wrapped call.
