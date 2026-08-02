#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, readFileSync as readFile, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCommandRunner } from "./contract-rollout/command.mjs";
import { approvalDigest, isContractImpactingPath } from "./contract-rollout/core.mjs";
import { executeRollout } from "./contract-rollout/execution.mjs";
import { createGitHubClient, parsePullRequestUrl } from "./contract-rollout/github.mjs";
import { CONSUMERS, applyAuditReport, bindAuditReport, prepareRollout, verifyConsumerPullRequest } from "./contract-rollout/preparation.mjs";
import { createExecutionActions } from "./contract-rollout/runtime.mjs";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIRM = "APPROVE_CONTRACT_ROLLOUT";
const RESUME_CONFIRM = "APPROVE_CONTRACT_ROLLOUT_RESUME";

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

function printHelp(io) {
  io.out([
    "Usage: node scripts/contractctl.mjs rollout <command> [options]",
    "",
    "Commands:",
    "  validate --base <sha> --head <sha>",
    "  bind-audit <upstream-pr-url> --backend-pr <url> --ide-pr <url> --upstream-head <sha> --backend-head <sha> --ide-head <sha> --audit-report <raw.json> --report-sha256 <sha256> --output <bound.json>",
    "  prepare <upstream-pr-url> [--backend-pr <url> --ide-pr <url>] [--audit-report <bound.json>] [--no-wait-audit]",
    "  status <upstream-pr-url> [--json]",
    `  continue <upstream-pr-url> [--dry-run] --confirm ${CONFIRM}`,
    `  resume <upstream-pr-url> [--confirm ${RESUME_CONFIRM}]`,
    "",
    "Safety:",
    "  bind-audit verifies the raw report checksum and binds all three exact PR heads plus the contract version.",
    "  prepare may write consumer branches/PR metadata and rollout comments, but does not merge or deploy.",
    `  continue crosses the production boundary only with --confirm ${CONFIRM}.`,
    `  resume is read-only by default; a blocked checkpoint resumes only with --confirm ${RESUME_CONFIRM}.`,
    "  Audit blockers stop approval. Manual repair recommendations are included in the approval digest but never mutate stored content.",
  ].join("\n"));
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
  if (record.upstream.repository !== upstreamRef.repository || record.upstream.pullRequest !== url) {
    throw new Error("rollout record upstream pull request does not match the command URL container");
  }
  const refs = [
    record.upstream,
    record.execution?.consumerRepin?.backend ?? record.backend,
    record.execution?.consumerRepin?.ide ?? record.ide,
  ];
  const pulls = refs.map((ref) => {
    const parsed = parsePullRequestUrl(ref.pullRequest);
    const pr = github.getPullRequest(parsed.repository, parsed.number);
    if (pr.headSha !== ref.headSha) throw new Error(`${parsed.repository} head changed; approval and audits are invalid`);
    const consumer = CONSUMERS.find((value) => value.repository === ref.repository);
    if (consumer) {
      const evidence = verifyConsumerPullRequest({ github, consumer, pullRequest: ref.pullRequest, expectedHeadSha: ref.headSha });
      if (JSON.stringify(evidence) !== JSON.stringify(ref.diffEvidence)) {
        throw new Error(`${ref.repository} pull request diff evidence changed after preparation`);
      }
    }
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
  if (durableResume && status.record.approval.digest !== status.digest) {
    throw new Error("stored approval digest does not match the current rollout; no external action is allowed");
  }
  if (!dryRun && firstApproval && option(args, "--confirm") !== CONFIRM) {
    deps.io.err(`Refusing production-changing execution without --confirm ${CONFIRM}.`);
    return 2;
  }
  if (!dryRun && !firstApproval && !durableResume) throw new Error(`rollout cannot continue from ${status.record.state}`);
  if (firstApproval) {
    if (status.record.audit.status !== "passed" || status.record.audit.blockers !== 0) throw new Error("stored-content audit is not ready");
    for (const { ref, pr } of status.pulls) {
      if (pr.state !== "OPEN") throw new Error(`${ref.repository} pull request is not open`);
      if (pr.isDraft) throw new Error(`${ref.repository} pull request is still a draft`);
      if (pr.mergeable !== "MERGEABLE") throw new Error(`${ref.repository} pull request is not mergeable`);
    }
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

async function resumeCommand(url, args, deps) {
  const status = loadFreshStatus(url, deps.github);
  if (status.record.state !== "rollout_blocked") throw new Error(`rollout resume requires rollout_blocked state, found ${status.record.state}`);
  if (status.record.audit.status !== "passed" || status.record.audit.blockers !== 0) throw new Error("stored-content audit is not ready for recovery");
  if (status.record.approval?.digest !== status.digest) throw new Error("stored approval digest does not match the current rollout; recovery is forbidden");
  if (!status.pulls.every(({ pr }) => allChecksGreen(pr))) throw new Error("not every pull request check is green for recovery");
  if (option(args, "--confirm") !== RESUME_CONFIRM) {
    deps.io.out(`Blocked rollout recovery is ready at stage ${status.record.execution?.stage ?? "unknown"}.`);
    deps.io.out(`Review the failure, then rerun with --confirm ${RESUME_CONFIRM}; no changes were made.`);
    return 0;
  }
  const upstream = parsePullRequestUrl(url);
  const { failure: _failure, ...checkpoint } = status.record;
  const recovered = {
    ...checkpoint,
    state: "executing",
    recovery: { confirmedAt: new Date().toISOString(), fromStage: status.record.execution?.stage ?? "unknown" },
  };
  deps.github.upsertRolloutComment(upstream.repository, upstream.number, recovered);
  const actions = deps.actions ?? createExecutionActions({ github: deps.github, runner: deps.runner });
  const result = await executeRollout({
    record: recovered,
    confirmed: true,
    actions,
    persist: async (record) => deps.github.upsertRolloutComment(upstream.repository, upstream.number, record),
  });
  if (result.state === "complete") {
    deps.io.out("Blocked rollout recovery completed; Backend production is verified and IDE source is merged.");
    return 0;
  }
  deps.io.err(`Contract rollout recovery stopped in ${result.state}; inspect the rollout comment before any further action.`);
  return 1;
}

function requiredOption(args, name) {
  const value = option(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function bindAuditCommand(url, args, deps) {
  const backendUrl = requiredOption(args, "--backend-pr");
  const ideUrl = requiredOption(args, "--ide-pr");
  const reportPath = requiredOption(args, "--audit-report");
  const outputPath = requiredOption(args, "--output");
  const expectedHeads = {
    upstream: requiredOption(args, "--upstream-head"),
    backend: requiredOption(args, "--backend-head"),
    ide: requiredOption(args, "--ide-head"),
  };
  for (const [key, sha] of Object.entries(expectedHeads)) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--${key}-head must be a full lowercase Git SHA`);
  }
  const expectedChecksum = requiredOption(args, "--report-sha256").replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) throw new Error("--report-sha256 must be a SHA-256 digest");

  const refs = [
    ["upstream", url, "cdotlock/lunascripts"],
    ["backend", backendUrl, "cdotlock/lunaverse-backend"],
    ["ide", ideUrl, "cdotlock/lunaverse-ide"],
  ];
  const pulls = {};
  for (const [key, pullRequest, expectedRepository] of refs) {
    const parsed = parsePullRequestUrl(pullRequest);
    if (parsed.repository !== expectedRepository) throw new Error(`${key} PR must belong to ${expectedRepository}`);
    const pr = deps.github.getPullRequest(parsed.repository, parsed.number);
    if (pr.state !== "OPEN") throw new Error(`${key} PR must be open`);
    if (pr.headSha !== expectedHeads[key]) throw new Error(`${key} PR head ${pr.headSha} does not match expected ${expectedHeads[key]}`);
    pulls[key] = { repository: parsed.repository, pullRequest, headSha: pr.headSha };
  }
  const localHead = deps.runner.capture("git", ["rev-parse", "HEAD"], { cwd: deps.root });
  if (localHead !== pulls.upstream.headSha) throw new Error(`local HEAD ${localHead} does not match upstream PR head ${pulls.upstream.headSha}`);
  const manifest = JSON.parse(readFileSync(join(deps.root, "contract/contract.json"), "utf8"));
  const raw = readFileSync(reportPath);
  const actualChecksum = createHash("sha256").update(raw).digest("hex");
  if (actualChecksum !== expectedChecksum) throw new Error(`audit report SHA-256 mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  const report = JSON.parse(raw.toString("utf8"));
  const record = {
    ...pulls,
    contractVersion: manifest.contract_version,
  };
  const envelope = bindAuditReport(record, report, {
    kind: "bootstrap",
    repository: pulls.backend.repository,
    revision: pulls.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts",
    sourceReportSha256: `sha256:${actualChecksum}`,
  });
  writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
  deps.io.out(`Bound read-only audit to ${pulls.upstream.headSha}, ${pulls.backend.headSha}, and ${pulls.ide.headSha}.`);
  deps.io.out(`Wrote ${outputPath}; the source report was not modified.`);
  return 0;
}

async function prepareCommand(url, args, deps) {
  const prepare = deps.prepareRollout ?? prepareRollout;
  const prepared = prepare({
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
  const suppliedAudit = option(args, "--audit-report");
  if (suppliedAudit) {
    const report = JSON.parse(readFile(suppliedAudit, "utf8"));
    const record = applyAuditReport(prepared.record, report);
    const parsed = parsePullRequestUrl(url);
    deps.github.upsertRolloutComment(parsed.repository, parsed.number, record);
    deps.io.out(`Imported read-only stored-content audit: ${record.audit.blockers} blocker(s), ${record.audit.repairRecommended} repair recommendation(s).`);
    if (record.state === "awaiting_approval") {
      deps.io.out("Preparation is complete. Review the report, then approve once in this Agent conversation.");
      return 0;
    }
    deps.io.err(`Preparation stopped in ${record.state}; production was not changed.`);
    return 1;
  }
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
    const reportPath = join(download, "lunascripts-contract-audit.json");
    const raw = readFile(reportPath);
    const report = JSON.parse(raw.toString("utf8"));
    const envelope = bindAuditReport(prepared.record, report, {
      kind: "github-actions",
      repository: prepared.record.backend.repository,
      revision: prepared.record.backend.headSha,
      workflow: "lunascripts-contract-audit.yml",
      runId: run.databaseId,
      runUrl: completed.url,
      sourceReportSha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    });
    const record = applyAuditReport(prepared.record, envelope);
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
  const deps = { io, root, runner, github, actions: provided.actions, prepareRollout: provided.prepareRollout };
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp(io);
      return 0;
    }
    if (argv[0] !== "rollout") throw new Error("usage: contractctl rollout <validate|bind-audit|prepare|status|continue|resume>");
    const command = argv[1];
    if (command === "validate") return await validateCommand(argv.slice(2), deps);
    const url = argv[2];
    if (!url) throw new Error(`${command} requires an upstream pull request URL`);
    if (command === "bind-audit") return await bindAuditCommand(url, argv.slice(3), deps);
    if (command === "prepare") return await prepareCommand(url, argv.slice(3), deps);
    if (command === "status") return await statusCommand(url, argv.slice(3), deps);
    if (command === "continue") return await continueCommand(url, argv.slice(3), deps);
    if (command === "resume") return await resumeCommand(url, argv.slice(3), deps);
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
