import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UPSTREAM_REPOSITORY, assertUpstreamAuthority, nextRolloutState } from "./core.mjs";
import { parsePullRequestUrl } from "./github.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;

export const CONSUMERS = Object.freeze([
  {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    install: ["pnpm", ["install", "--frozen-lockfile"]],
    update: (sha) => ["node", ["scripts/update-lunascripts-contract.mjs", "--ref", sha, "--json"]],
    verify: [
      ["node", ["--test", "scripts/update-lunascripts-contract.test.mjs"]],
      ["pnpm", ["vitest", "run", "scripts/lunascripts-contract-audit.test.ts", "scripts/check-lunascripts-authority.test.ts", "__tests__/core/schema-signal-int.test.ts"]],
    ],
    owned: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
    allowed: [
      ".github/workflows/lunascripts-authority.yml",
      ".github/workflows/lunascripts-contract-audit.yml",
      ".github/workflows/railway-shared-persistence-env-deploy.yml",
      "CLAUDE.md",
      "__tests__/core/schema-signal-int.test.ts",
      "app/core/lunascripts-contract.ts",
      "app/core/schema.ts",
      "app/core/types.ts",
      "app/services/release-content-health-policy.ts",
      "app/services/release-content-health-service.test.ts",
      "app/services/release-content-health-service.ts",
      "contracts/lunascripts",
      "contracts/lunascripts.lock.json",
      "package.json",
      "scripts/check-lunascripts-authority.mjs",
      "scripts/check-lunascripts-authority.test.ts",
      "scripts/lunascripts-contract-audit-lib.ts",
      "scripts/lunascripts-contract-audit.test.ts",
      "scripts/lunascripts-contract-audit.ts",
      "scripts/lunascripts-rollout-workflow.test.ts",
      "scripts/update-lunascripts-contract.mjs",
      "scripts/update-lunascripts-contract.test.mjs",
    ],
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
    allowed: [
      ".github/workflows/lunascripts-authority.yml",
      "AGENTS.md",
      "agents/_shared/knowledge/LS-SPEC.md",
      "agents/adaptation/skills/entity-planner/SKILL.md",
      "agents/adaptation/skills/episode-writer/ls-spec.md",
      "agents/adaptation/skills/planner-reviewer/SKILL.md",
      "docs/superpowers/plans/2026-08-01-lunascripts-contract-authority.md",
      "package.json",
      "scripts/check-lunascripts-authority.mjs",
      "scripts/update-vendor.mjs",
      "test/agent-guidance-contract.test.mjs",
      "test/lunascripts-authority.test.mjs",
      "test/update-vendor.test.mjs",
      "vendor/README.md",
      "vendor/lunascripts",
    ],
  },
]);

export function rolloutBranch(version, upstreamSha) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("contract version must be semver");
  if (!SHA_RE.test(upstreamSha)) throw new Error("upstream SHA must be a full lowercase commit");
  return `contract-rollout/v${version}-${upstreamSha.slice(0, 8)}`;
}

function treeDigest(runner, cwd, sha) {
  const treeSha = runner.capture("git", ["rev-parse", `${sha}^{tree}`], { cwd });
  if (!SHA_RE.test(treeSha)) throw new Error("upstream candidate did not resolve an exact Git tree");
  return `sha256:${createHash("sha256").update(treeSha).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function payloadDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function validateAuditSource(source, record) {
  if (!source || typeof source !== "object") throw new Error("audit provenance source is required");
  if (source.repository !== record.backend.repository) throw new Error("audit producer repository does not match Backend");
  if (source.revision !== record.backend.headSha) throw new Error("audit producer revision does not match backendHeadSha");
  if (!/^sha256:[0-9a-f]{64}$/.test(source.sourceReportSha256 ?? "")) {
    throw new Error("audit sourceReportSha256 is invalid");
  }
  if (source.kind === "bootstrap") {
    if (source.executable !== "scripts/lunascripts-contract-audit.ts") {
      throw new Error("bootstrap audit executable is not authoritative");
    }
    return;
  }
  if (source.kind === "github-actions") {
    if (source.workflow !== "lunascripts-contract-audit.yml" || !Number.isInteger(source.runId) || source.runId <= 0) {
      throw new Error("audit workflow provenance is invalid");
    }
    return;
  }
  throw new Error("audit provenance kind is invalid");
}

export function bindAuditReport(record, report, source) {
  validateAuditSource(source, record);
  if (report?.readOnly !== true) throw new Error("audit report does not prove read-only execution");
  for (const key of ["blockers", "repairRecommended"]) {
    if (!Number.isInteger(report[key]) || report[key] < 0) throw new Error(`audit report ${key} is invalid`);
  }
  return {
    schemaVersion: 1,
    provenance: {
      upstreamHeadSha: record.upstream.headSha,
      backendHeadSha: record.backend.headSha,
      ideHeadSha: record.ide.headSha,
      contractVersion: record.contractVersion,
      source: structuredClone(source),
    },
    payloadDigest: payloadDigest(report),
    report: structuredClone(report),
  };
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

export function changedFiles(runner, cwd) {
  const output = runner.capture("git", ["status", "--porcelain=v1", "-z"], { cwd, trim: false });
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("malformed git porcelain: missing NUL terminator");
  const fields = output.split("\0");
  fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (entry.length < 4 || entry[2] !== " " || entry.slice(3).length === 0) {
      throw new Error("malformed git porcelain entry");
    }
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const source = fields[++index];
      if (!source) throw new Error("malformed git porcelain rename entry");
      paths.push(source);
    }
  }
  return [...new Set(paths)];
}

function isOwned(path, owned) {
  return owned.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function verifyConsumerPullRequest({ github, consumer, pullRequest, expectedHeadSha }) {
  const parsed = parsePullRequestUrl(pullRequest);
  if (parsed.repository !== consumer.repository) throw new Error(`consumer PR must belong to ${consumer.repository}`);
  const pr = github.getPullRequest(parsed.repository, parsed.number);
  if (pr.baseBranch !== "main") throw new Error(`${consumer.repository} pull request base must be main`);
  if (pr.headSha !== expectedHeadSha) throw new Error(`${consumer.repository} pull request head changed during diff verification`);
  const files = [...new Set(github.getPullRequestFiles(parsed.repository, parsed.number))].sort();
  const allowed = consumer.allowed ?? consumer.owned;
  const unexpected = files.filter((file) => !isOwned(file, allowed));
  if (unexpected.length) throw new Error(`${consumer.repository} has unapproved pull request paths: ${unexpected.join(", ")}`);
  const material = JSON.stringify({ baseBranch: pr.baseBranch, headSha: pr.headSha, files });
  return {
    baseBranch: pr.baseBranch,
    files,
    digest: `sha256:${createHash("sha256").update(material).digest("hex")}`,
  };
}

function handoff(error, upstreamUrl) {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message.replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED]");
  const failure = new Error(`${sanitized}\nHandoff: node scripts/contractctl.mjs rollout prepare ${upstreamUrl}`);
  failure.code = "ROLLOUT_HANDOFF";
  return failure;
}

export function prepareConsumerWorkspace({ runner, github, consumer, branch, upstreamSha, contractVersion, upstreamUrl, baseDir, existingPullRequest = null, expectedHeadSha = null }) {
  const cwd = join(baseDir, consumer.key);
  runner.capture("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    `https://github.com/${consumer.repository}.git`,
    cwd,
  ], { stage: `clone ${consumer.key} consumer` });
  const existing = existingPullRequest ?? github.findPullRequestByHead(consumer.repository, branch);
  if (existing) {
    runner.capture("git", ["fetch", "origin", "main", branch], { cwd });
    runner.capture("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd });
    runner.capture("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd });
    if (expectedHeadSha) {
      const checkedOutHead = runner.capture("git", ["rev-parse", "HEAD"], { cwd });
      if (checkedOutHead !== expectedHeadSha) throw new Error(`${consumer.repository} checked out head does not match the approved head`);
    }
  } else {
    runner.capture("git", ["fetch", "origin", "main"], { cwd });
    runner.capture("git", ["checkout", "-B", branch, "origin/main"], { cwd });
  }

  if (consumer.install) {
    const [installCommand, installArgs] = consumer.install;
    runner.capture(installCommand, installArgs, { cwd });
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
  if (existing?.isDraft) github.markPullRequestReady(consumer.repository, existing.number, headSha);
  const diffEvidence = verifyConsumerPullRequest({ github, consumer, pullRequest: pr.url, expectedHeadSha: pr.headSha });
  return { repository: consumer.repository, pullRequest: pr.url, headSha: pr.headSha, diffEvidence };
}

export function prepareRollout({ upstreamUrl, root, runner, github, consumers = CONSUMERS, keepWorkspaces = false, existingPullRequests = {} }) {
  const parsed = parsePullRequestUrl(upstreamUrl);
  if (parsed.repository !== UPSTREAM_REPOSITORY) throw handoff(new Error(`upstream must use canonical upstream repository ${UPSTREAM_REPOSITORY}`), upstreamUrl);
  const upstreamPr = github.getPullRequest(parsed.repository, parsed.number);
  assertUpstreamAuthority({ repository: parsed.repository, pullRequest: upstreamUrl, baseBranch: upstreamPr.baseBranch });
  if (upstreamPr.state !== "OPEN" || upstreamPr.mergeable !== "MERGEABLE") {
    throw handoff(new Error("upstream pull request must be an open mergeable candidate"), upstreamUrl);
  }
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
        verifyConsumerPullRequest({
          github,
          consumer,
          pullRequest: existingPullRequests[consumer.key],
          expectedHeadSha: existingPullRequest.headSha,
        });
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
        baseBranch: upstreamPr.baseBranch,
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

export function applyAuditReport(record, envelope) {
  if (envelope?.schemaVersion !== 1 || !envelope.provenance || !envelope.report) {
    throw new Error("audit import requires a bound audit envelope");
  }
  for (const [key, expected] of [
    ["upstreamHeadSha", record.upstream.headSha],
    ["backendHeadSha", record.backend.headSha],
    ["ideHeadSha", record.ide.headSha],
    ["contractVersion", record.contractVersion],
  ]) {
    if (envelope.provenance[key] !== expected) throw new Error(`audit provenance ${key} does not match rollout`);
  }
  validateAuditSource(envelope.provenance.source, record);
  if (envelope.payloadDigest !== payloadDigest(envelope.report)) throw new Error("audit payload digest does not match report");
  const report = envelope.report;
  if (report.readOnly !== true) throw new Error("audit report does not prove read-only execution");
  if (!Number.isInteger(report.blockers) || report.blockers < 0 || !Number.isInteger(report.repairRecommended) || report.repairRecommended < 0) {
    throw new Error("audit report counts are invalid");
  }
  const passed = report.blockers === 0;
  return {
    ...record,
    state: nextRolloutState("preparing", passed ? "checks_passed" : "checks_failed"),
    audit: {
      status: passed ? "passed" : "blocked",
      blockers: report.blockers,
      repairRecommended: report.repairRecommended,
      remediation: "manual_review_only",
      reportDigest: envelope.payloadDigest,
      provenance: structuredClone(envelope.provenance),
    },
  };
}
