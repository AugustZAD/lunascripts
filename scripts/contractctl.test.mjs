import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "./contractctl.mjs";
import { validateJsonAgainstSchema } from "./contract-artifacts.mjs";
import { createCommandRunner } from "./contract-rollout/command.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function releaseRoot() {
  const root = mkdtempSync(join(tmpdir(), "lunascripts-contractctl-"));
  for (const path of ["cmd", "contract", "docs", "internal"]) {
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  }
  for (const path of ["CHANGELOG.md", "go.mod"]) cpSync(join(ROOT, path), join(root, path));
  return root;
}

function validationRunner(root, baseManifest = { contract_version: "2.0.0" }) {
  const real = createCommandRunner();
  return {
    capture(command, args, options = {}) {
      if (command === "git" && args[0] === "diff") return "contract/contract.json";
      if (command === "git" && args[0] === "ls-tree") {
        return readdirSync(join(ROOT, "contract/fixtures/valid"))
          .filter((name) => name.endsWith(".ls"))
          .map((name) => `contract/fixtures/valid/${name}`)
          .join("\n");
      }
      if (command === "git" && args[0] === "show") {
        const path = String(args[1]).split(":").slice(1).join(":");
        if (path === "contract/contract.json") return JSON.stringify(baseManifest);
        if (path === "contract/episode.schema.json") {
          const schema = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
          schema.properties.ls_contract_version.const = baseManifest.contract_version;
          return JSON.stringify(schema);
        }
        return readFileSync(join(ROOT, path), "utf8");
      }
      return real.capture(command, args, { ...options, cwd: options.cwd ?? root });
    },
  };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

test("help exposes only validation, consumer preparation/sync, and read-only status", async () => {
  const sink = io();
  assert.equal(await main(["--help"], { io: sink.value, runner: {}, github: {} }), 0);
  const text = sink.out.join("\n");
  assert.match(text, /consumers <prepare\|sync>/);
  assert.match(text, /status/);
  assert.doesNotMatch(text, /merge|deploy|continue|resume|confirm/i);
});

test("removed controller actions are unknown and perform no calls", async () => {
  const sink = io();
  const calls = [];
  const runner = new Proxy({}, { get: () => (...args) => calls.push(args) });
  assert.equal(await main(["rollout", "continue", "https://github.com/cdotlock/lunascripts/pull/2"], { io: sink.value, runner, github: {} }), 1);
  assert.deepEqual(calls, []);
  assert.match(sink.err[0], /unknown/);
});

test("status rejects a report whose adopted branch no longer matches the exact PR head branch", async () => {
  const sink = io();
  const sha = "a".repeat(40);
  const report = {
    schemaVersion: 2, kind: "consumer-preparation",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", candidateHeadSha: sha, pinSha: sha },
    contractVersion: "2.0.0",
    consumers: {
      backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", branch: "codex/lunascripts-authority", headSha: sha, diffEvidence: { baseSha: sha, remoteFiles: [] } },
      ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", branch: "codex/lunascripts-authority", headSha: sha, diffEvidence: { baseSha: sha, remoteFiles: [] } },
    },
    audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
  };
  const github = {
    readPreparationReport: () => report,
    getPullRequest: (repository) => repository === "cdotlock/lunascripts"
      ? { state: "OPEN", baseBranch: "main", headSha: sha }
      : { state: "OPEN", baseBranch: "main", baseSha: sha, headSha: sha, headBranch: "codex/other" },
    getPullRequestFiles: () => [],
  };
  assert.equal(await main(["rollout", "status", "https://github.com/cdotlock/lunascripts/pull/2", "--json"], { io: sink.value, runner: {}, github }), 1);
  assert.match(sink.err[0], /branch|identity/i);
});

test("rollout validation rejects a contract/schema version mismatch", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schemaPath = join(root, "contract/episode.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.properties.ls_contract_version.const = "2.0.0";
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner: validationRunner(root),
  }), 1);
  assert.match(sink.err.join("\n"), /schema|version/i);
});

test("rollout validation rejects a valid fixture whose committed JSON is stale", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixturePath = join(root, "contract/fixtures/valid/legacy-character-look.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  fixture.title = "stale committed output";
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner: validationRunner(root),
  }), 1);
  assert.match(sink.err.join("\n"), /fixture|stale|byte/i);
});

test("rollout validation rejects minor when the Episode schema tightens", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const schemaPath = join(root, "contract/episode.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.properties.title.minLength = 999;
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner: validationRunner(root), artifactValidator: () => {},
  }), 1);
  assert.match(sink.err.join("\n"), /change class minor.*major|classifier.*major/i);
});

test("rollout validation rejects minor when a base valid fixture fails under the HEAD compiler", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const normal = validationRunner(root);
  const runner = {
    capture(command, args, options = {}) {
      if (command === "go" && args.includes("compile") && String(options.stage ?? "").includes("base fixture")) {
        throw new Error("HEAD compiler rejected previously valid source");
      }
      return normal.capture(command, args, options);
    },
  };
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner, artifactValidator: () => {},
  }), 1);
  assert.match(sink.err.join("\n"), /change class minor.*major|classifier.*major/i);
});

test("schema validation fails closed on unsupported validation keywords", () => {
  assert.throws(
    () => validateJsonAgainstSchema("value", { type: "string", unknownConstraint: true }),
    /unsupported JSON Schema keyword unknownConstraint/i,
  );
});

test("rollout validation requires every current invalid fixture to stay invalid", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "contract/fixtures/invalid/lowercase-mark-signal.ls"), `@episode main:01 "Now valid" {
@signal mark NOW_VALID
@gate { @end complete }
}`);
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner: validationRunner(root), artifactValidator: () => {},
  }), 1);
  assert.match(sink.err.join("\n"), /invalid fixture lowercase-mark-signal\.ls unexpectedly validates/i);
});

test("rollout validation rejects a declared change class below the version classifier", async (t) => {
  const root = releaseRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, "contract/contract.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.change_class = "patch";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const sink = io();
  assert.equal(await main(["rollout", "validate", "--base", "base", "--head", "head"], {
    root, io: sink.value, runner: validationRunner(root), artifactValidator: () => {},
  }), 1);
  assert.match(sink.err.join("\n"), /change class|minor|classifier/i);
});
