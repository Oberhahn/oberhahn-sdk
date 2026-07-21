#!/usr/bin/env node
/**
 * Scaffold a new provider adapter.
 *
 *     node scripts/new-adapter.mjs <slug>
 *
 * Writes a stubbed adapter (`src/adapters/<slug>.ts`) + test
 * (`test/<slug>.test.ts`), and registers the adapter in `src/registry.ts` at the
 * `// scaffold:` anchors. After running, implement the `extract` body and the
 * method `path`, then follow the printed checklist (devDependency, contract canary).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // js/
const SRC = join(ROOT, "src");

const slug = process.argv[2];
if (!slug || !/^[a-z][a-z0-9_]*$/.test(slug)) {
  console.error("usage: node scripts/new-adapter.mjs <slug>   (lowercase, [a-z][a-z0-9_]*)");
  process.exit(1);
}

const adapterPath = join(SRC, "adapters", `${slug}.ts`);
const testPath = join(ROOT, "test", `${slug}.test.ts`);
const registryPath = join(SRC, "registry.ts");
if (existsSync(adapterPath)) {
  console.error(`adapter already exists: ${adapterPath}`);
  process.exit(1);
}

const ADAPTER = `import type { Adapter, MethodSpec, ProviderUsage } from "./types.js";

const PROVIDER = "${slug}";

/** Pull usage from a non-streaming result. \`null\` → don't emit. */
function extract(result: unknown, args: unknown[]): ProviderUsage | null {
  const r = result as { usage?: { input_tokens?: number; output_tokens?: number }; model?: string; id?: string } | undefined;
  if (!r?.usage) return null;
  const body = args[0] as { model?: string } | undefined;
  return {
    model: r.model ?? body?.model ?? "unknown",
    model_provider: PROVIDER,
    input_tokens: r.usage.input_tokens ?? 0,   // TODO: real field
    output_tokens: r.usage.output_tokens ?? 0, // TODO: real field
    // cache_read_tokens, cache_write_tokens, provider_message_id: r.id
  };
}

const methods: MethodSpec[] = [
  {
    path: "TODO.method.path", // dotted path to monkey-patch, e.g. "messages.create"
    extract,
    // isStream: (args) => (args[0] as { stream?: boolean } | undefined)?.stream === true,
    // extractStream: (chunks, args) => null,
    // modelInfo: (args) => ({ model_provider: PROVIDER, model: (args[0] as { model?: string })?.model ?? "unknown" }),
  },
];

export const ${slug}Adapter: Adapter = { name: PROVIDER, methods };
`;

const TEST = `import { describe, it } from "vitest";

// TODO: implement the ${slug} adapter, then un-skip and build a fake client whose
// method path returns a result with a usage block; assert the posted event body.
describe.skip("${slug} adapter", () => {
  it("extracts usage and posts an event", () => {});
});
`;

writeFileSync(adapterPath, ADAPTER);
writeFileSync(testPath, TEST);

let reg = readFileSync(registryPath, "utf8");
if (!reg.includes(`./adapters/${slug}.js`)) {
  const importAnchor = "// scaffold:imports";
  const entryAnchor = "  // scaffold:entries";
  if (!reg.includes(importAnchor) || !reg.includes(entryAnchor)) {
    console.error("scaffold anchors not found in registry.ts — was it edited away?");
    process.exit(1);
  }
  reg = reg.replace(importAnchor, `import { ${slug}Adapter } from "./adapters/${slug}.js";\n${importAnchor}`);
  reg = reg.replace(entryAnchor, `  [${slug}Adapter.name]: ${slug}Adapter,\n${entryAnchor}`);
  writeFileSync(registryPath, reg);
}

console.log(`✓ created src/adapters/${slug}.ts`);
console.log(`✓ created test/${slug}.test.ts`);
console.log(`✓ registered ${slug}Adapter in src/registry.ts`);
console.log("\nNext:");
console.log(`  1. Implement extract (+ isStream/extractStream) and the MethodSpec.path in adapters/${slug}.ts`);
console.log(`  2. Un-skip and flesh out test/${slug}.test.ts`);
console.log(`  3. Add the provider SDK to devDependencies (pinned) + peerDependencies in package.json`);
console.log(`  4. Add a type-level drift canary for it in test/contract.test.ts`);
console.log(`  5. Do the same in the Python SDK: cd ../python && python scripts/new_adapter.py ${slug}`);
