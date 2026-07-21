# Changelog

## [0.2.0](https://github.com/Oberhahn/oberhahn-sdk/compare/js-v0.1.0...js-v0.2.0) (2026-07-21)


### Features

* **adapters:** normalize model ids to bare aliases across all providers ([19918ba](https://github.com/Oberhahn/oberhahn-sdk/commit/19918badd236439747274fc4e9be5867dcf015bf))
* add Google Gemini as an SDK provider (js + python) ([#13](https://github.com/Oberhahn/oberhahn-sdk/issues/13)) ([fd73765](https://github.com/Oberhahn/oberhahn-sdk/commit/fd737651df540c34ede16542244146d39e2f115e)), closes [#12](https://github.com/Oberhahn/oberhahn-sdk/issues/12)
* adds python SDK ([2955bd1](https://github.com/Oberhahn/oberhahn-sdk/commit/2955bd11a598b748618015a79ba80371b9fc8301))
* remove more comments ([09f9053](https://github.com/Oberhahn/oberhahn-sdk/commit/09f9053dac00ecc59ed31d3a7ab506ebe55eac9f))
* removes comments ([89a56da](https://github.com/Oberhahn/oberhahn-sdk/commit/89a56dac8e7b68617edb53d033c493cf7db121dd))
* send cost if provided on response ([60de14f](https://github.com/Oberhahn/oberhahn-sdk/commit/60de14f236474d5b636c3d3769d49e6d85701318))
* **smoke:** add OpenRouter (OpenAI-compatible) provider ([25e4727](https://github.com/Oberhahn/oberhahn-sdk/commit/25e4727b625a66378cd522cc13e0a9f494f6b659))
* **smoke:** interactive smoke script; dedupe smoke harness ([8952b49](https://github.com/Oberhahn/oberhahn-sdk/commit/8952b496051e6edfc32e684247ebf510ec25e216))
* update docs, accept openai compat explicit providers, forward cost ([d474cc3](https://github.com/Oberhahn/oberhahn-sdk/commit/d474cc39753aa2bbed3fd7ef68ca4fcc93405332))
* wrap() auto-detection + separate model vendor from routing/hosting ([#21](https://github.com/Oberhahn/oberhahn-sdk/issues/21)) ([b014bbf](https://github.com/Oberhahn/oberhahn-sdk/commit/b014bbf0bdd41ad65451f6823feb42b8a7252107))


### Bug Fixes

* bump python and node versions ([5d6dd66](https://github.com/Oberhahn/oberhahn-sdk/commit/5d6dd66266f2c084ede32aeb2ccad6901aea2398))
* consolidate source to sdk_oberhahn ([4af8094](https://github.com/Oberhahn/oberhahn-sdk/commit/4af80944714ca20011c6cd55fc0f58b221a5a002))
* README updates ([df1e37e](https://github.com/Oberhahn/oberhahn-sdk/commit/df1e37ee85cf4ec8c02dfd143f8ca6aa3f4c9fd9))
* removes comments ([1b6d60c](https://github.com/Oberhahn/oberhahn-sdk/commit/1b6d60cc9881d0e71933ce7afed68b55ae1b221f))
* removes wrap shortcuts ([7b1ff97](https://github.com/Oberhahn/oberhahn-sdk/commit/7b1ff976d9598b94dc1c9b5958371aba0c8826bc))
* sends full event request body to ob ([5dc738f](https://github.com/Oberhahn/oberhahn-sdk/commit/5dc738fdaa7f42454d5d04a5a10dce6ae1ea771d))
* **smoke:** don't prompt for AWS access key/secret in interactive Bedrock ([4d1a03d](https://github.com/Oberhahn/oberhahn-sdk/commit/4d1a03d2dc43a103fecaa18f69d57631043b4074))
* **smoke:** skip prompting for credentials already set in the environment ([1613d52](https://github.com/Oberhahn/oberhahn-sdk/commit/1613d52cc1206eac16c6132f700b488340bb3f6e))
* updates README.md ([34ca0b6](https://github.com/Oberhahn/oberhahn-sdk/commit/34ca0b628825cf6054b2e34efe0ec8cf5c9cd29b))
