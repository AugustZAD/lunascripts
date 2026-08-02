#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdtempSync, readFileSync as readFile, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCommandRunner } from "./contract-rollout/command.mjs";
import { approvalDigest, isContractImpactingPath } from "./contract-rollout/core.mjs";
import { executeRollout } from "./contract-rollout/execution.mjs";
import { createGitHubClient, parsePullRequestUrl } from "./contract-rollout/github.mjs";
import { applyAuditReport, prepareRollout } from "./contract-rollout/preparation.mjs";
import { createExecutionActions } from "./contract-rollout/runtime.mjs";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIRM = "APPROVE_CONTRACT_ROLLOUT";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args, name) {
  return args.includes(name);
}

function defaultIo() {
  return { out: console.log, err: console.error };
}

function allChecksGreen(pr) {
  return pr.checks.length > 0 && pr.checks.every((check) => check.status === "completed" && check.conclusion === "success");
}

async function validateCommand(args, deps) {
  const base = option(args, "--base");
  const head = option(args, "--head");
  if (!base || !head) throw new Error("validate requires --base <sha> and --head <sha>");
  const changed = deps.runner.capture("git", ["diff", "--name-only", base, head, "--"], { cwd: deps.root })
    .split(/\r?\n/)
    .filter(Boolean);
  const impacting = changed.filter(isContractImpactingPath);
  if (impacting.length === 0) {
    deps.io.out("No contract-impacting files changed; consumer rollout is not required.");
    return 0;
  }
  const manifest = JSON.parse(readFileSync(join(deps.root, "contract/contract.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.contract_version ?? "")) throw new Error("contract_version must be semver");
  if (!new Set(["patch", "minor", "major"]).has(manifest.change_class)) throw new Error("change_class is missing or invalid");
  if (manifest.rollout?.stored_content_policy !== "audit_only") throw new Error("stored content policy must be audit_only");
  const changelog = readFileSync(join(deps.root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## ${manifest.contract_version}`)) throw new Error("CHANGELOG has no entry for contract_version");
  deps.io.out(`${impacting.length} contract-impacting file(s); declared ${manifest.contract_version} (${manifest.change_class}).`);
  return 0;
}

function loadFreshStatus(url, github) {
  const upstreamRef = parsePullRequestUrl(url);
  const record = github.readRolloutRecord(upstreamRef.repository, upstreamRef.number);
  const refs = [record.upstream, record.backend, record.ide];
  const pulls = refs.map((ref) => {
    const parsed = parsePullRequestUrl(ref.pullRequest);
    const pr = github.getPullRequest(parsed.repository, parsed.number);
    if (pr.headSha !== ref.headSha) throw new Error(`${parsed.repository} head changed; approval and audits are invalid`);
    return { ref, pr };
  });
  return { record, pulls, digest: approvalDigest(record) };
}

async function statusCommand(url, args, deps) {
  const status = loadFreshStatus(url, deps.github);
  if (has(args, "--json")) deps.io.out(JSON.stringify(status, null, 2));
  else {
    deps.io.out(`Contract ${status.record.contractVersion} rollout: ${status.record.state}`);
    deps.io.out(`Approval digest: ${status.digest}`);
    for (const { ref, pr } of status.pulls) deps.io.out(`- ${ref.repository}: ${pr.state}, ${pr.headSha}, checks ${allChecksGreen(pr) ? "green" : "not green"}`);
  }
  return 0;
}

async function continueCommand(url, args, deps) {
  const dryRun = has(args, "--dry-run");
  const status = loadFreshStatus(url, deps.github);
  const firstApproval = status.record.state === "awaiting_approval";
  const durableResume = new Set(["executing", "production_verified"]).has(status.record.state) && status.record.approval?.digest;
  if (!dryRun && firstApproval && option(args, "--confirm") !== CONFIRM) {
    deps.io.err(`Refusing production-changing execution without --confirm ${CONFIRM}.`);
    return 2;
  }
  if (!dryRun && !firstApproval && !durableResume) throw new Error(`rollout cannot continue from ${status.record.state}`);
  if (firstApproval) {
    if (status.record.audit.status !== "passed" || status.record.audit.blockers !== 0) throw new Error("stored-content audit is not ready");
    if (!status.pulls.every(({ pr }) => allChecksGreen(pr))) throw new Error("not every pull request check is green");
  }
  deps.io.out(`Execution plan for ${status.digest}: upstream merge -> canonical repin -> Backend merge/deploy/smoke -> IDE merge.`);
  if (dryRun) {
    deps.io.out("No changes were made (dry-run).");
    return 0;
  }
  const upstream = parsePullRequestUrl(url);
  const actions = deps.actions ?? createExecutionActions({ github: deps.github, runner: deps.runner });
  const result = await executeRollout({
    record: status.record,
    confirmed: true,
    actions,
    persist: async (record) => deps.github.upsertRolloutComment(upstream.repository, upstream.number, record),
  });
  if (result.state === "complete") {
    deps.io.out("Contract rollout complete: Backend production is verified and the IDE source PR is merged. No IDE installer release was started.");
    return 0;
  }
  deps.io.err(`Contract rollout stopped in ${result.state}; inspect the rollout comment before continuing.`);
  return 1;
}

async function prepareCommand(url, args, deps) {
  const prepared = prepareRollout({
    upstreamUrl: url,
    root: deps.root,
    runner: deps.runner,
    github: deps.github,
    existingPullRequests: {
      backend: option(args, "--backend-pr"),
      ide: option(args, "--ide-pr"),
    },
  });
  deps.io.out(`Prepared Backend (${prepared.branches.backend}) and IDE (${prepared.branches.ide}) PRs.`);
  if (has(args, "--no-wait-audit")) {
    deps.io.out("Audit not dispatched; rerun prepare without --no-wait-audit to reach the approval gate.");
    return 0;
  }
  const parsed = parsePullRequestUrl(url);
  const started = new Date(Date.now() - 5_000).toISOString();
  deps.github.dispatchWorkflow(
    prepared.record.backend.repository,
    "lunascripts-contract-audit.yml",
    prepared.branches.backend,
    {
      upstream_sha: prepared.record.upstream.headSha,
      backend_sha: prepared.record.backend.headSha,
      upstream_pr_url: url,
    },
  );
  const run = deps.github.waitForWorkflowRun(prepared.record.backend.repository, "lunascripts-contract-audit.yml", {
    createdAfter: started,
    expectedHeadSha: prepared.record.backend.headSha,
  });
  const completed = deps.github.watchWorkflowRun(prepared.record.backend.repository, run.databaseId);
  const download = mkdtempSync(join(tmpdir(), "lunascripts-audit-"));
  try {
    const artifact = `lunascripts-contract-audit-${prepared.record.upstream.headSha}`;
    deps.github.downloadArtifact(prepared.record.backend.repository, run.databaseId, artifact, download);
    const report = JSON.parse(readFile(join(download, "lunascripts-contract-audit.json"), "utf8"));
    const record = applyAuditReport(prepared.record, report);
    deps.github.upsertRolloutComment(parsed.repository, parsed.number, record);
    deps.io.out(`Read-only stored-content audit: ${record.audit.blockers} blocker(s), ${record.audit.repairRecommended} repair recommendation(s).`);
    if (record.state === "awaiting_approval" && completed.conclusion === "success") {
      deps.io.out("Preparation is complete. Review the report, then approve once in this Agent conversation.");
      return 0;
    }
    deps.io.err(`Preparation stopped in ${record.state}; production was not changed.`);
    return 1;
  } finally {
    rmSync(download, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2), provided = {}) {
  const io = provided.io ?? defaultIo();
  const root = provided.root ?? DEFAULT_ROOT;
  const runner = provided.runner ?? createCommandRunner();
  const github = provided.github ?? createGitHubClient(runner);
  const deps = { io, root, runner, github, actions: provided.actions };
  try {
    if (argv[0] !== "rollout") throw new Error("usage: contractctl rollout <validate|prepare|status|continue>");
    const command = argv[1];
    if (command === "validate") return await validateCommand(argv.slice(2), deps);
    const url = argv[2];
    if (!url) throw new Error(`${command} requires an upstream pull request URL`);
    if (command === "prepare") return await prepareCommand(url, argv.slice(3), deps);
    if (command === "status") return await statusCommand(url, argv.slice(3), deps);
    if (command === "continue") return await continueCommand(url, argv.slice(3), deps);
    throw new Error(`unknown rollout command: ${command}`);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await main();
  process.exitCode = code;
}
