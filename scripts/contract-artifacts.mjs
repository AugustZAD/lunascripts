import { isDeepStrictEqual } from "node:util";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: string does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: number is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: number is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: array has too few items`);
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
  const errors = [];
  collectSchemaErrors(value, schema, schema, "$", errors);
  if (errors.length) throw new Error(`${label} does not match contract schema: ${errors.slice(0, 5).join("; ")}`);
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
