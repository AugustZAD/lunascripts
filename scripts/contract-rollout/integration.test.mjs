import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../contractctl.mjs";
import { applyAuditReport, bindAuditReport, prepareRollout } from "./preparation.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(root, name, files = {}) {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);
  mkdirSync(work);
  git(["init", "-b", "main"], work);
  git(["config", "user.name", "Rollout Fixture"], work);
  git(["config", "user.email", "rollout@example.invalid"], work);
  for (const [path, value] of Object.entries(files)) {
    const target = join(work, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, value);
  }
  git(["add", "."], work);
  git(["commit", "-m", "fixture"], work);
  git(["init", "--bare", bare], root);
  git(["remote", "add", "origin", bare], work);
  git(["push", "-u", "origin", "main"], work);
  return { work, bare, sha: git(["rev-parse", "HEAD"], work) };
}

test("offline three-repository prepare and approval dry-run never mutate production", async () => {
  const root = mkdtempSync(join(tmpdir(), "contract-rollout-integration-"));
  const upstream = repository(root, "upstream", {
    "contract/contract.json": JSON.stringify({ contract_version: "2.0.0", change_class: "major" }),
    "LS-SPEC.md": "fixture\n",
  });
  const backend = repository(root, "backend", { "README.md": "backend\n" });
  const ide = repository(root, "ide", { "README.md": "ide\n" });
  const remotes = new Map([
    ["https://github.com/cdotlock/lunaverse-backend.git", backend.bare],
    ["https://github.com/cdotlock/lunaverse-ide.git", ide.bare],
  ]);
  const commandCalls = [];
  const runner = {
    capture(command, args, options = {}) {
      commandCalls.push([command, ...args]);
      const actual = command === "git" && args[0] === "clone" && remotes.has(args[1])
        ? [args[0], remotes.get(args[1]), ...args.slice(2)]
        : args;
      return execFileSync(command, actual, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    },
  };
  const pulls = new Map();
  let preparedRecord;
  const github = {
    getPullRequest(repo, number) {
      if (repo === "cdotlock/lunascripts") return { headSha: upstream.sha, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", checks: [{ status: "completed", conclusion: "success" }] };
      const pr = pulls.get(`${repo}/${number}`);
      return { ...pr, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] };
    },
    findPullRequestByHead: () => null,
    createPullRequest(repo, value) {
      const number = repo.endsWith("backend") ? 128 : 15;
      const pr = { number, url: `https://github.com/${repo}/pull/${number}`, headSha: value.expectedHeadSha };
      pulls.set(`${repo}/${number}`, pr);
      return pr;
    },
    getPullRequestFiles: () => [],
    upsertRolloutComment(_repo, _number, value) { preparedRecord = value; },
  };
  const noopConsumer = (key, repo) => ({
    key, repository: repo,
    update: () => [process.execPath, ["-e", "process.stdout.write('{}')"]],
    verify: [], owned: ["contract-fixture"], allowed: ["contract-fixture"],
  });
  prepareRollout({
    upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2",
    root: upstream.work,
    runner,
    github,
    consumers: [
      noopConsumer("backend", "cdotlock/lunaverse-backend"),
      noopConsumer("ide", "cdotlock/lunaverse-ide"),
    ],
  });
  const envelope = bindAuditReport(preparedRecord, { readOnly: true, blockers: 0, repairRecommended: 2 }, {
    kind: "bootstrap",
    repository: preparedRecord.backend.repository,
    revision: preparedRecord.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts",
    sourceReportSha256: `sha256:${"2".repeat(64)}`,
  });
  preparedRecord = applyAuditReport(preparedRecord, envelope);
  github.readRolloutRecord = () => preparedRecord;
  const lines = [];
  const code = await main(
    ["rollout", "continue", preparedRecord.upstream.pullRequest, "--dry-run"],
    { github, runner, root: upstream.work, io: { out: (line) => lines.push(line), err: (line) => lines.push(line) } },
  );
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /No changes were made/);
  assert.equal(commandCalls.some((call) => ["railway", "curl"].includes(call[0]) || call.includes("merge")), false);
  assert.equal(commandCalls.some((call) => call.join(" ").match(/r2|supabase|put-object/i)), false);
});
