# OBERHAHN SDKs

Thin, server-side SDKs that wrap native AI-provider SDKs and report token usage +
attribution to [OBERHAHN](https://oberhahn.com) — so you get visibility into your
AI usage without changing how you make provider calls. Wrap your client once and
keep calling it as before.

This is a **multi-language monorepo**: one SDK per language, each self-contained
in its own directory with its own build, tests, and packaging.

| Language        | Package         | Directory                  | Status |
| --------------- | --------------- | -------------------------- | ------ |
| TypeScript / JS | `@oberhahn/sdk` | [`js/`](./js)              | ✅      |
| Python          | `oberhahn`      | [`python/`](./python)      | ✅      |

Each SDK shares the same shape: `init()` once, then `wrap(client, "<provider>")`
to instrument your provider clients in place. See the per-language
README for install and usage — start with [`js/README.md`](./js/README.md).

## Repository layout

```
.
├── js/            # TypeScript/JS SDK (@oberhahn/sdk)
├── python/        # Python SDK (oberhahn)
├── LICENSE        # MIT — applies to the whole repo
└── .github/       # CI (per-language, path-filtered) + Dependabot
```

## License

[MIT](./LICENSE)
