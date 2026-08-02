import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextRolloutState } from "./core.mjs";
import { parsePullRequestUrl } from "./github.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;

export const CONSUMERS = Object.freeze([
  {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    update: (sha) => ["node", ["scripts/update-lunascripts-contract.mjs", "--ref", sha, "--json"]],
    verify: [
      ["node", ["--test", "scripts/update-lunascripts-contract.test.mjs"]],
      ["pnpm", ["vitest", "run", "scripts/lunascripts-contract-audit.test.ts", "scripts/check-lunascripts-authority.test.ts", "__tests__/core/schema-signal-int.test.ts"]],
    ],
    owned: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
  },
  {
    key: "ide",
    repository: "cdotlock/lunaverse-ide",
    update: (sha) => ["node", ["scripts/update-vendor.mjs", "lunascripts", "--ref", sha, "--json"]],
    verify: [
      ["node", ["--test", "test/lunascripts-authority.test.mjs", "test/agent-guidance-contract.test.mjs", "test/update-vendor.test.mjs"]],
      ["go", ["test", "./..."], { cwd: "vendor/lunascripts" }],
    ],
    owned: [
      "vendor/lunascripts",
      "vendor/README.md",
      "agents/adaptation/skills/episode-writer/ls-spec.md",
      "agents/_shared/knowledge/LS-SPEC.md",
    ],
  },
]);

export function rolloutBranch(version, upstreamSha) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("contract version must be semver");
  if (!SHA_RE.test(upstreamSha)) throw new Error("upstream SHA must be a full lowercase commit");
  return `contract-rollout/v${version}-${upstreamSha.slice(0, 8)}`;
}

function treeDigest(runner, cwd, sha) {
  const listing = runner.capture("git", ["ls-tree", "-r", "--full-tree", sha], { cwd });
  return `sha256:${createHash("sha256").update(listing).digest("hex")}`;
}

function prBody({ contractVersion, upstreamSha, upstreamUrl, key, files, evidence }) {
  const dependency = key === "backend"
    ? "Merge only after the upstream authority PR is merged and this exact pin is refreshed to canonical main."
    : "Do not merge until the Backend revision is deployed and production smoke is verified.";
  return [
    `## Lunaverse Script contract ${contractVersion}`,
    "",
    `Upstream candidate: \`${upstreamSha}\` (${upstreamUrl})`,
    "",
    dependency,
    "This PR is owned by `contractctl`; do not merge it manually while the rollout record is active.",
    "Stored production content is audited read-only and is never repaired by this rollout.",
    "",
    "### Generated files",
    ...files.map((file) => `- \`${file}\``),
    "",
    "### Local verification",
    ...evidence.map((line) => `- ${line}`),
  ].join("\n");
}

function changedFiles(runner, cwd) {
  return runner.capture("git", ["status", "--porcelain=v1"], { cwd })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function isOwned(path, owned) {
  return owned.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function handoff(error, upstreamUrl) {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message.replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED]");
  const failure = new Error(`${sanitized}\nHandoff: node scripts/contractctl.mjs rollout prepare ${upstreamUrl}`);
  failure.code = "ROLLOUT_HANDOFF";
  return failure;
}

export function prepareConsumerWorkspace({ runner, github, consumer, branch, upstreamSha, contractVersion, upstreamUrl, baseDir, existingPullRequest = null }) {
  const cwd = join(baseDir, consumer.key);
  runner.capture("git", ["clone", `https://github.com/${consumer.repository}.git`, cwd]);
  const existing = existingPullRequest ?? github.findPullRequestByHead(consumer.repository, branch);
  if (existing) {
    runner.capture("git", ["fetch", "origin", "main", branch], { cwd });
    runner.capture("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd });
    runner.capture("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd });
  } else {
    runner.capture("git", ["fetch", "origin", "main"], { cwd });
    runner.capture("git", ["checkout", "-B", branch, "origin/main"], { cwd });
  }

  const [updateCommand, updateArgs] = consumer.update(upstreamSha);
  const updateResult = runner.capture(updateCommand, updateArgs, { cwd });
  JSON.parse(updateResult);
  const evidence = [];
  for (const [command, args, options = {}] of consumer.verify) {
    runner.capture(command, args, { cwd: options.cwd ? join(cwd, options.cwd) : cwd });
    evidence.push(`\`${command} ${args.join(" ")}\``);
  }
  const files = changedFiles(runner, cwd);
  const unexpected = files.filter((file) => !isOwned(file, consumer.owned));
  if (unexpected.length) throw new Error(`${consumer.repository} updater changed unowned paths: ${unexpected.join(", ")}`);
  if (files.length) {
    runner.capture("git", ["add", "--", ...consumer.owned], { cwd });
    runner.capture("git", ["commit", "-m", `chore(ls): consume contract ${contractVersion}`], { cwd });
  }
  const headSha = runner.capture("git", ["rev-parse", "HEAD"], { cwd });
  if (!SHA_RE.test(headSha)) throw new Error(`${consumer.repository} did not resolve a full head SHA`);
  runner.capture("git", existing ? ["push", "origin", branch] : ["push", "--set-upstream", "origin", branch], { cwd });

  const body = prBody({ contractVersion, upstreamSha, upstreamUrl, key: consumer.key, files, evidence });
  const pr = existing
    ? github.updatePullRequest(consumer.repository, existing.number, { title: `chore(ls): consume contract ${contractVersion}`, body, expectedHeadSha: headSha })
    : github.createPullRequest(consumer.repository, { branch, base: "main", title: `chore(ls): consume contract ${contractVersion}`, body, expectedHeadSha: headSha });
  return { repository: consumer.repository, pullRequest: pr.url, headSha: pr.headSha };
}

export function prepareRollout({ upstreamUrl, root, runner, github, consumers = CONSUMERS, keepWorkspaces = false, existingPullRequests = {} }) {
  const parsed = parsePullRequestUrl(upstreamUrl);
  const upstreamPr = github.getPullRequest(parsed.repository, parsed.number);
  const localHead = runner.capture("git", ["rev-parse", "HEAD"], { cwd: root });
  if (upstreamPr.headSha !== localHead) throw new Error(`local HEAD ${localHead} does not match upstream PR head ${upstreamPr.headSha}`);
  const manifest = JSON.parse(readFileSync(join(root, "contract/contract.json"), "utf8"));
  const defaultBranch = rolloutBranch(manifest.contract_version, upstreamPr.headSha);
  const baseDir = mkdtempSync(join(tmpdir(), "lunascripts-rollout-"));
  const prepared = {};
  const branches = {};
  try {
    for (const consumer of consumers) {
      let existingPullRequest = null;
      if (existingPullRequests[consumer.key]) {
        const adopted = parsePullRequestUrl(existingPullRequests[consumer.key]);
        if (adopted.repository !== consumer.repository) throw new Error(`${consumer.key} PR must belong to ${consumer.repository}`);
        existingPullRequest = github.getPullRequest(adopted.repository, adopted.number);
        if (existingPullRequest.state !== "OPEN" || !existingPullRequest.headBranch) throw new Error(`${consumer.key} PR must be open with a readable head branch`);
        existingPullRequest = { ...existingPullRequest, number: adopted.number };
      }
      const branch = existingPullRequest?.headBranch ?? defaultBranch;
      branches[consumer.key] = branch;
      prepared[consumer.key] = prepareConsumerWorkspace({
        runner, github, consumer, branch, upstreamSha: upstreamPr.headSha,
        contractVersion: manifest.contract_version, upstreamUrl, baseDir, existingPullRequest,
      });
    }
    const record = {
      schemaVersion: 1,
      state: "preparing",
      upstream: {
        repository: parsed.repository,
        pullRequest: upstreamUrl,
        headSha: upstreamPr.headSha,
        treeDigest: treeDigest(runner, root, upstreamPr.headSha),
      },
      contractVersion: manifest.contract_version,
      changeClass: manifest.change_class,
      backend: prepared.backend,
      ide: prepared.ide,
      audit: { status: "pending", blockers: 0, repairRecommended: 0 },
    };
    github.upsertRolloutComment(parsed.repository, parsed.number, record);
    return { branch: defaultBranch, branches, record };
  } catch (error) {
    throw handoff(error, upstreamUrl);
  } finally {
    if (!keepWorkspaces) rmSync(baseDir, { recursive: true, force: true });
  }
}

export function applyAuditReport(record, report) {
  if (report?.readOnly !== true) throw new Error("audit report does not prove read-only execution");
  if (!Number.isInteger(report.blockers) || !Number.isInteger(report.repairRecommended)) throw new Error("audit report counts are invalid");
  const passed = report.blockers === 0;
  return {
    ...record,
    state: nextRolloutState("preparing", passed ? "checks_passed" : "checks_failed"),
    audit: {
      status: passed ? "passed" : "blocked",
      blockers: report.blockers,
      repairRecommended: report.repairRecommended,
    },
  };
}
