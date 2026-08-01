#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCommandRunner } from "./contract-rollout/command.mjs";
import { approvalDigest, isContractImpactingPath } from "./contract-rollout/core.mjs";
import { createGitHubClient, parsePullRequestUrl } from "./contract-rollout/github.mjs";

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
  if (!dryRun && option(args, "--confirm") !== CONFIRM) {
    deps.io.err(`Refusing production-changing execution without --confirm ${CONFIRM}.`);
    return 2;
  }
  const status = loadFreshStatus(url, deps.github);
  if (status.record.state !== "awaiting_approval") throw new Error(`rollout state must be awaiting_approval, found ${status.record.state}`);
  if (status.record.audit.status !== "passed" || status.record.audit.blockers !== 0) throw new Error("stored-content audit is not ready");
  if (!status.pulls.every(({ pr }) => allChecksGreen(pr))) throw new Error("not every pull request check is green");
  deps.io.out(`Execution plan for ${status.digest}: upstream merge -> canonical repin -> Backend merge/deploy/smoke -> IDE merge.`);
  if (dryRun) {
    deps.io.out("No changes were made (dry-run).");
    return 0;
  }
  throw new Error("confirmed execution adapter is not installed yet; no changes were made");
}

export async function main(argv = process.argv.slice(2), provided = {}) {
  const io = provided.io ?? defaultIo();
  const root = provided.root ?? DEFAULT_ROOT;
  const runner = provided.runner ?? createCommandRunner();
  const github = provided.github ?? createGitHubClient(runner);
  const deps = { io, root, runner, github };
  try {
    if (argv[0] !== "rollout") throw new Error("usage: contractctl rollout <validate|status|continue>");
    const command = argv[1];
    if (command === "validate") return await validateCommand(argv.slice(2), deps);
    const url = argv[2];
    if (!url) throw new Error(`${command} requires an upstream pull request URL`);
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
