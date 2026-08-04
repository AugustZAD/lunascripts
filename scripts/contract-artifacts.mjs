import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { canonicalize, classifyContractChange } from "./contract-rollout/core.mjs";

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref",
  "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "properties", "required", "additionalProperties",
  "allOf", "anyOf", "oneOf", "if", "then", "else",
  "items", "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "pattern", "enum", "const",
]);

function assertSupportedSchema(schema, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${path}: schema nodes must be objects`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) throw new Error(`unsupported JSON Schema keyword ${keyword} at ${path}`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${path}.properties.${name}`);
  for (const [name, child] of Object.entries(schema.$defs ?? {})) assertSupportedSchema(child, `${path}.$defs.${name}`);
  for (const keyword of ["items", "if", "then", "else"]) {
    if (schema[keyword] && typeof schema[keyword] === "object") assertSupportedSchema(schema[keyword], `${path}.${keyword}`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    schema[keyword]?.forEach((child, index) => assertSupportedSchema(child, `${path}.${keyword}[${index}]`));
  }
}

function schemaTarget(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported JSON Schema reference ${ref}`);
  return ref.slice(2).split("/").reduce((value, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return value?.[key];
  }, root);
}

function typeMatches(value, type) {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`unsupported JSON Schema type ${type}`);
  }
}

function collectSchemaErrors(value, schema, root, path, errors) {
  if (schema.$ref) {
    const target = schemaTarget(root, schema.$ref);
    if (!target) errors.push(`${path}: unresolved schema reference ${schema.$ref}`);
    else collectSchemaErrors(value, target, root, path, errors);
    return;
  }

  const matches = (candidate) => {
    const nested = [];
    collectSchemaErrors(value, candidate, root, path, nested);
    return nested.length === 0;
  };

  if (schema.allOf) {
    for (const candidate of schema.allOf) collectSchemaErrors(value, candidate, root, path, errors);
  }
  if (schema.anyOf && !schema.anyOf.some(matches)) errors.push(`${path}: does not match any allowed schema`);
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) errors.push(`${path}: must match exactly one allowed schema`);
  if (schema.if) {
    if (matches(schema.if)) {
      if (schema.then) collectSchemaErrors(value, schema.then, root, path, errors);
    } else if (schema.else) collectSchemaErrors(value, schema.else, root, path, errors);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected ${types.join(" or ")}`);
      return;
    }
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))) {
    errors.push(`${path}: value is outside the declared enum`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: string is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: string is too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: string does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: number is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: number is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: array has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: array has too many items`);
    if (schema.items) value.forEach((item, index) => collectSchemaErrors(item, schema.items, root, `${path}[${index}]`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}: missing required property ${required}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) collectSchemaErrors(child, schema.properties[key], root, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
    }
  }
}

export function validateJsonAgainstSchema(value, schema, label = "JSON document") {
  assertSupportedSchema(schema);
  const errors = [];
  collectSchemaErrors(value, schema, schema, "$", errors);
  if (errors.length) throw new Error(`${label} does not match contract schema: ${errors.slice(0, 5).join("; ")}`);
}

function stable(value) {
  return JSON.stringify(canonicalize(value));
}

function schemaTighteningReasons(base, head, path = "$") {
  const reasons = [];
  const add = (message) => reasons.push(`${path}: ${message}`);
  const baseRequired = new Set(base.required ?? []);
  for (const name of head.required ?? []) if (!baseRequired.has(name)) add(`new required property ${name}`);

  const baseTypes = base.type === undefined ? null : new Set(Array.isArray(base.type) ? base.type : [base.type]);
  const headTypes = head.type === undefined ? null : new Set(Array.isArray(head.type) ? head.type : [head.type]);
  if (!baseTypes && headTypes) add("type constraint added");
  else if (baseTypes && headTypes && [...baseTypes].some((type) => !headTypes.has(type))) add("allowed type removed");

  for (const keyword of ["minimum", "minLength", "minItems"]) {
    if (head[keyword] !== undefined && (base[keyword] === undefined || head[keyword] > base[keyword])) add(`${keyword} increased`);
  }
  for (const keyword of ["maximum", "maxLength", "maxItems"]) {
    if (head[keyword] !== undefined && (base[keyword] === undefined || head[keyword] < base[keyword])) add(`${keyword} decreased`);
  }
  if (head.pattern !== undefined && head.pattern !== base.pattern) add("pattern added or changed");
  if (head.additionalProperties === false && base.additionalProperties !== false) add("additional properties became disallowed");
  if (head.additionalProperties && typeof head.additionalProperties === "object" && stable(head.additionalProperties) !== stable(base.additionalProperties)) {
    add("additionalProperties schema changed ambiguously");
  }

  if (head.enum) {
    if (!base.enum || base.enum.some((value) => !head.enum.some((candidate) => isDeepStrictEqual(candidate, value)))) add("enum narrowed");
  }
  const versionPath = "$.properties.ls_contract_version";
  if (Object.hasOwn(head, "const") && (!Object.hasOwn(base, "const") || !isDeepStrictEqual(base.const, head.const)) && path !== versionPath) {
    add("const added or changed");
  }

  for (const keyword of ["$ref", "allOf", "anyOf", "oneOf", "if", "then", "else", "items"]) {
    if (head[keyword] !== undefined && stable(head[keyword]) !== stable(base[keyword])) add(`${keyword} changed ambiguously`);
  }

  const baseProperties = base.properties ?? {};
  const headProperties = head.properties ?? {};
  for (const [name, child] of Object.entries(baseProperties)) {
    if (!headProperties[name]) {
      if (head.additionalProperties === false) reasons.push(`${path}.properties.${name}: previously declared property removed`);
      continue;
    }
    reasons.push(...schemaTighteningReasons(child, headProperties[name], `${path}.properties.${name}`));
  }
  const baseDefs = base.$defs ?? {};
  const headDefs = head.$defs ?? {};
  for (const [name, child] of Object.entries(baseDefs)) {
    if (!headDefs[name]) reasons.push(`${path}.$defs.${name}: definition removed ambiguously`);
    else reasons.push(...schemaTighteningReasons(child, headDefs[name], `${path}.$defs.${name}`));
  }
  return reasons;
}

function replayBaseValidFixtures({ root, base, runner }) {
  const paths = runner.capture("git", ["ls-tree", "-r", "--name-only", base, "--", "contract/fixtures/valid"], { cwd: root })
    .split(/\r?\n/).filter((path) => path.endsWith(".ls"));
  const reasons = [];
  const replayRoot = mkdtempSync(join(tmpdir(), "lunascripts-base-fixtures-"));
  try {
    for (const [index, path] of paths.entries()) {
      const sourcePath = join(replayRoot, `${index}-${basename(path)}`);
      const outputPath = join(replayRoot, `${index}.json`);
      writeFileSync(sourcePath, runner.capture("git", ["show", `${base}:${path}`], { cwd: root, trim: false }));
      try {
        runner.capture("go", ["run", "./cmd/lsc", "compile", sourcePath, "-o", outputPath], {
          cwd: root,
          stage: `compile base fixture ${path} with HEAD compiler`,
        });
      } catch {
        reasons.push(`previously valid base fixture ${path} no longer compiles`);
      }
    }
  } finally {
    rmSync(replayRoot, { recursive: true, force: true });
  }
  return reasons;
}

function assertCurrentInvalidFixturesRemainInvalid(root, manifest) {
  const invalidRoot = join(root, "contract", manifest.invalid_fixtures);
  for (const name of readdirSync(invalidRoot).filter((entry) => entry.endsWith(".ls")).sort()) {
    const result = spawnSync("go", ["run", "./cmd/lsc", "validate", join(invalidRoot, name)], {
      cwd: root,
      encoding: "utf8",
      timeout: 2 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status === null) throw new Error(`could not execute invalid fixture ${name}: ${result.error?.message ?? result.signal ?? "unknown failure"}`);
    if (result.status === 0) throw new Error(`invalid fixture ${name} unexpectedly validates under the HEAD compiler`);
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (!/error:|\[[A-Z][A-Z0-9_]+\]/.test(diagnostic)) throw new Error(`invalid fixture ${name} failed without a compiler diagnostic`);
  }
}

export function classifyContractSemantics({ root, base, manifest, runner }) {
  const baseSchema = JSON.parse(runner.capture("git", ["show", `${base}:contract/episode.schema.json`], { cwd: root }));
  const headSchema = JSON.parse(readFileSync(join(root, "contract", manifest.episode_schema), "utf8"));
  assertSupportedSchema(baseSchema, "base schema");
  assertSupportedSchema(headSchema, "HEAD schema");
  const tightened = [
    ...replayBaseValidFixtures({ root, base, runner }),
    ...schemaTighteningReasons(baseSchema, headSchema),
  ];
  assertCurrentInvalidFixturesRemainInvalid(root, manifest);
  return { lowerBound: classifyContractChange({ tightened }), reasons: tightened };
}

function jsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

export function validateContractArtifacts({ root, manifest, runner }) {
  const contractRoot = join(root, "contract");
  const schemaPath = join(contractRoot, manifest.episode_schema);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const schemaVersion = schema.properties?.ls_contract_version?.const;
  if (schemaVersion !== manifest.contract_version) {
    throw new Error(`episode schema version ${JSON.stringify(schemaVersion)} does not match contract version ${manifest.contract_version}`);
  }

  const docs = readFileSync(join(contractRoot, manifest.json_output_spec), "utf8");
  if (!docs.includes(`"ls_contract_version": "${manifest.contract_version}"`)) {
    throw new Error(`JSON output documentation does not show contract version ${manifest.contract_version}`);
  }

  const fixturesRoot = join(contractRoot, manifest.valid_fixtures);
  const sources = readdirSync(fixturesRoot).filter((name) => name.endsWith(".ls")).sort();
  if (!sources.length) throw new Error("contract has no valid source fixtures");
  const generatedRoot = mkdtempSync(join(tmpdir(), "lunascripts-fixtures-"));
  try {
    for (const sourceName of sources) {
      const expectedName = `${basename(sourceName, ".ls")}.json`;
      const expectedPath = join(fixturesRoot, expectedName);
      const generatedPath = join(generatedRoot, expectedName);
      runner.capture("go", ["run", "./cmd/lsc", "compile", join(fixturesRoot, sourceName), "-o", generatedPath], {
        cwd: root,
        stage: `compile contract fixture ${sourceName}`,
      });
      const expected = readFileSync(expectedPath);
      const generated = readFileSync(generatedPath);
      if (!expected.equals(generated)) throw new Error(`valid fixture ${expectedName} is stale; generated JSON is not byte-identical`);
      validateJsonAgainstSchema(JSON.parse(expected.toString("utf8")), schema, `valid fixture ${expectedName}`);
    }
  } finally {
    rmSync(generatedRoot, { recursive: true, force: true });
  }

  for (const fixturePath of jsonFiles(join(contractRoot, "fixtures"))) {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (fixture.ls_contract_version !== manifest.contract_version) {
      throw new Error(`fixture ${fixturePath.slice(root.length + 1)} has contract version ${JSON.stringify(fixture.ls_contract_version)}, want ${manifest.contract_version}`);
    }
  }

  const featureParade = join(root, "testdata", "feature_parade");
  try {
    for (const path of jsonFiles(featureParade)) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (Object.hasOwn(value, "ls_contract_version") && value.ls_contract_version !== manifest.contract_version) {
        throw new Error(`golden ${path.slice(root.length + 1)} has contract version ${JSON.stringify(value.ls_contract_version)}, want ${manifest.contract_version}`);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
