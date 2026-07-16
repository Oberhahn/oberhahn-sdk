#!/usr/bin/env node
/**
 * Live STREAMING smoke test for @oberhahn/sdk: same as smoke.mjs but makes a
 * real *streaming* provider call — the SDK tees the stream and extracts usage
 * only once it's fully drained. See smoke-run.mjs for env vars + the harness.
 *
 *   Run:  cd js && npm run smoke:stream
 */
import { runSmokeTest } from "./smoke-run.mjs";

runSmokeTest(true).catch((err) => {
  console.error(`\n✗ ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
