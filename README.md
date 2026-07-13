# OBERHAHN SDKs

Thin, server-side SDKs that wrap native AI-provider SDKs, extract token usage +
attribution, and post canonical events to [OBERHAHN](https://oberhahn.com) for
AI-spend monitoring. The SDK never prices anything — it reports token counts and
the OBERHAHN server derives cost.

This is a **multi-language monorepo**: one SDK per language, each self-contained
in its own directory with its own build, tests, and packaging.

| Language        | Package        | Directory              | Status |
| --------------- | -------------- | ---------------------- | ------ |
| TypeScript / JS | `@oberhahn/sdk` | [`js/`](./js)          | ✅      |
| Python          | _tbd_          | `python/` _(planned)_  | 🚧     |

Each SDK shares the same shape: `init()` once, then `wrap(client, "<provider>")`
to instrument OpenAI / Anthropic / Bedrock clients in place. See the per-language
README for install and usage — start with [`js/README.md`](./js/README.md).

## Repository layout

```
.
├── js/            # TypeScript/JS SDK (@oberhahn/sdk)
├── python/        # Python SDK (planned)
├── LICENSE        # MIT — applies to the whole repo
└── .github/       # CI (per-language, path-filtered) + Dependabot
```

## License

[MIT](./LICENSE)
