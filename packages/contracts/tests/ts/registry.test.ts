// Registry completeness + version-sync guarantees.
//
// validators.ts keeps three hand-maintained lists (JSON imports, the
// SCHEMAS array, the SchemaName union) alongside export.py's
// EXPORTED_MODELS. Nothing structural forces them to agree — this test
// does. A model added on the Python side without a matching validator
// registration fails HERE instead of as a runtime throw inside a
// consumer (the PR-8 executor's re-validation path).

import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import schemaIndex from "../../schemas/index.json" with { type: "json" };
import { getValidator, SCHEMA_VERSION, type SchemaName } from "../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(HERE, "../../schemas");

describe("schema registry completeness", () => {
  it("every schema in index.json has a compiled Ajv validator with a matching $id", () => {
    for (const entry of schemaIndex.schemas) {
      const validator = getValidator(entry.slug as SchemaName);
      expect(validator, `no validator for ${entry.slug}`).toBeTypeOf("function");
      const schema = validator.schema as { $id?: string };
      expect(schema.$id).toBe(entry.id);
    }
  });

  it("every *.schema.json on disk appears in index.json (no zombies)", () => {
    const onDisk = readdirSync(SCHEMAS_DIR)
      .filter((f) => f.endsWith(".schema.json"))
      .sort();
    const indexed = schemaIndex.schemas.map((s) => s.file).sort();
    expect(onDisk).toEqual(indexed);
  });

  it("index.json and generated TS agree on file count", () => {
    const generated = readdirSync(path.resolve(HERE, "../../generated/ts"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ".schema.json"))
      .sort();
    const indexed = schemaIndex.schemas.map((s) => s.file).sort();
    expect(generated).toEqual(indexed);
  });
});

describe("SCHEMA_VERSION cross-language sync", () => {
  it("TS constant comes from the generated index (single source of truth)", () => {
    expect(SCHEMA_VERSION).toBe(schemaIndex.schema_version);
  });

  it("every schema pins schema_version to exactly the package version", () => {
    const escaped = SCHEMA_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expected = `^${escaped}$`;
    for (const entry of schemaIndex.schemas) {
      const validator = getValidator(entry.slug as SchemaName);
      const schema = validator.schema as {
        properties?: { schema_version?: { pattern?: string } };
      };
      expect(
        schema.properties?.schema_version?.pattern,
        `${entry.slug} schema_version pattern`,
      ).toBe(expected);
    }
  });
});
