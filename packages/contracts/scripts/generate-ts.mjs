// TS type generator.
//
// Reads every `*.schema.json` from ../schemas/, runs
// json-schema-to-typescript, writes to ../generated/ts/, then writes a
// stable index.ts that re-exports every generated file. CI diff-checks
// the output.

import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile } from "json-schema-to-typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const SCHEMAS_DIR = path.join(PKG, "schemas");
const OUT_DIR = path.join(PKG, "generated", "ts");

const BANNER = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.",
  "// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.",
].join("\n");

function pascal(kebab) {
  return kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const files = (await readdir(SCHEMAS_DIR))
    .filter((f) => f.endsWith(".schema.json"))
    .sort();

  const exports = [];

  for (const file of files) {
    const raw = await readFile(path.join(SCHEMAS_DIR, file), "utf8");
    const schema = JSON.parse(raw);
    const rootName = pascal(file.replace(".schema.json", ""));
    const ts = await compile(schema, rootName, {
      bannerComment: BANNER,
      // Keep additionalProperties: false honored on the TS side.
      strictIndexSignatures: true,
      // Format is optional; json-schema-to-typescript ships prettier.
      // We rely on its default so the generated tree is stable.
      style: {
        singleQuote: false,
        semi: true,
      },
      // Descriptions from Pydantic docstrings become TSDoc comments —
      // keep them; they're the only readable docs a consumer sees.
      unknownAny: false,
      ignoreMinAndMaxItems: false,
    });
    const outFile = file.replace(".schema.json", ".ts");
    await writeFile(path.join(OUT_DIR, outFile), ts, "utf8");
    exports.push({ file: outFile, name: rootName });
  }

  // index.ts: re-export ONLY each schema's root type. `export * from` is
  // too aggressive — json-schema-to-typescript emits per-file helper
  // types (AccountId, SchemaVersion, Venue, ...) that collide across
  // schemas. Named re-export by root type avoids the collision and
  // keeps the public surface small.
  const indexBody =
    BANNER +
    "\n\n" +
    exports
      .map((e) => `export type { ${e.name} } from "./${e.file.replace(/\.ts$/, ".js")}";`)
      .join("\n") +
    "\n";
  await writeFile(path.join(OUT_DIR, "index.ts"), indexBody, "utf8");

  console.log(`Wrote ${exports.length + 1} files to generated/ts/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
