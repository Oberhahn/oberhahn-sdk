#!/usr/bin/env node
/**
 * Live smoke test for @oberhahn/sdk against a DEPLOYED OBERHAHN endpoint: one
 * real (non-streaming) provider call → post the usage event → read it back and
 * verify attribution round-tripped. See smoke-run.mjs for env vars + the
 * harness. Makes a real (tiny, cheap) API call, so run it deliberately.
 *
 *   Run:  cd js && npm run smoke
 */
import { runSmokeTest } from "./smoke-run.mjs";

runSmokeTest(false).catch((err) => {
  console.error(`\n✗ ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
