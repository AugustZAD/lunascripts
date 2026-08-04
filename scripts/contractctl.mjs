#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCommandRunner } from "./contract-rollout/command.mjs";
import { compareSemverClass, isContractImpactingPath, validatePreparationReport } from "./contract-rollout/core.mjs";
import { createGitHubClient, parsePullRequestUrl } from "./contract-rollout/github.mjs";
import { prepareConsumers, syncConsumers } from "./contract-rollout/preparation.mjs";
import { classifyContractSemantics, validateContractArtifacts } from "./contract-artifacts.mjs";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultIo() {
  return { out: console.log, err: console.error };
}

function printHelp(io) {
  io.out([
    "Usage: node scripts/contractctl.mjs rollout <command>",
    "",
    "Commands:",
    "  validate --base <sha> --head <sha>",
    "  consumers <prepare|sync> <upstream-pr-url> [--backend-pr <url> --ide-pr <url>] [--audit-report <bound.json>]",
    "  status <upstream-pr-url> [--json]",
    "",
    "This tool only prepares or synchronizes open consumer pull requests. Production content is audit-only.",
    "All integration, releases, production verification, and downstream sequencing are manual.",
  ].join("\n"));
}

function validateCommand(args, deps) {
  const base = option(args, "--base");
  const head = option(args, "--head");
  if (!base || !head) throw new Error("validate requires --base <sha> and --head <sha>");
  const changed = deps.runner.capture("git", ["diff", "--name-only", base, head, "--"], { cwd: deps.root }).split(/\r?\n/).filter(Boolean);
  const impacting = changed.filter(isContractImpactingPath);
  if (!impacting.length) { deps.io.out("No contract-impacting files changed."); return 0; }
  const manifest = JSON.parse(readFileSync(join(deps.root, "contract/contract.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.contract_version ?? "") || !new Set(["patch", "minor", "major"]).has(manifest.change_class)) throw new Error("contract metadata is invalid");
  if (manifest.rollout?.stored_content_policy !== "audit_only") throw new Error("stored content policy must be audit_only");
  const changelog = readFileSync(join(deps.root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## ${manifest.contract_version}`)) throw new Error("CHANGELOG has no matching contract version");

  const previous = JSON.parse(deps.runner.capture("git", ["show", `${base}:contract/contract.json`], { cwd: deps.root }));
  const versionLowerBound = compareSemverClass(previous.contract_version, manifest.contract_version);
  const semantic = deps.semanticClassifier({ root: deps.root, base, manifest, runner: deps.runner });
  const rank = { patch: 0, minor: 1, major: 2 };
  const lowerBound = rank[semantic.lowerBound] > rank[versionLowerBound] ? semantic.lowerBound : versionLowerBound;
  if (rank[manifest.change_class] < rank[lowerBound]) {
    const detail = semantic.reasons.length ? `: ${semantic.reasons.slice(0, 3).join("; ")}` : "";
    throw new Error(`declared change class ${manifest.change_class} is below classifier lower bound ${lowerBound}${detail}`);
  }
  deps.artifactValidator({ root: deps.root, manifest, runner: deps.runner });
  deps.io.out(`${impacting.length} contract-impacting file(s); ${manifest.contract_version} (${manifest.change_class}).`);
  return 0;
}

function loadEnvelope(args) {
  const path = option(args, "--audit-report");
  return path ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function verifyStatus(url, github) {
  const upstreamRef = parsePullRequestUrl(url);
  const report = validatePreparationReport(github.readPreparationReport(upstreamRef.repository, upstreamRef.number));
  if (report.upstream.pullRequest !== url) throw new Error("preparation report belongs to a different upstream PR");
  const upstream = github.getPullRequest(upstreamRef.repository, upstreamRef.number);
  if (upstream.baseBranch !== "main" || upstream.headSha !== report.upstream.candidateHeadSha) throw new Error("upstream PR identity changed");
  if (report.upstream.canonicalMergeSha) {
    if (upstream.state !== "MERGED" || upstream.mergeSha !== report.upstream.canonicalMergeSha || report.upstream.pinSha !== upstream.mergeSha ||
        !github.isCommitReachableFromMain(upstreamRef.repository, upstream.mergeSha)) throw new Error("canonical upstream merge pin is invalid");
  }
  const fresh = {};
  for (const [key, consumer] of Object.entries(report.consumers)) {
    const ref = parsePullRequestUrl(consumer.pullRequest);
    const pr = github.getPullRequest(ref.repository, ref.number);
    if (pr.state !== "OPEN" || pr.baseBranch !== "main" || pr.headBranch !== consumer.branch || pr.baseSha !== consumer.diffEvidence.baseSha || pr.headSha !== consumer.headSha) throw new Error(`${key} consumer PR identity or branch changed`);
    const files = github.getPullRequestFiles(ref.repository, ref.number);
    if (JSON.stringify(files) !== JSON.stringify(consumer.diffEvidence.remoteFiles)) throw new Error(`${key} consumer paginated diff changed`);
    fresh[key] = { url: consumer.pullRequest, headSha: consumer.headSha, checks: pr.checks };
  }
  return { report, fresh };
}

export async function main(argv = process.argv.slice(2), provided = {}) {
  const deps = {
    io: provided.io ?? defaultIo(), root: provided.root ?? DEFAULT_ROOT,
    runner: provided.runner ?? createCommandRunner(),
    artifactValidator: provided.artifactValidator ?? validateContractArtifacts,
    semanticClassifier: provided.semanticClassifier ?? classifyContractSemantics,
  };
  deps.github = provided.github ?? createGitHubClient(deps.runner);
  try {
    if (argv.includes("--help") || argv.includes("-h")) { printHelp(deps.io); return 0; }
    if (argv[0] !== "rollout") throw new Error("usage: contractctl rollout <validate|consumers|status>");
    if (argv[1] === "validate") return validateCommand(argv.slice(2), deps);
    if (argv[1] === "consumers") {
      const action = argv[2];
      const url = argv[3];
      if (!url || !new Set(["prepare", "sync"]).has(action)) throw new Error("consumers requires prepare or sync and an upstream PR URL");
      const args = argv.slice(4);
      const auditEnvelope = loadEnvelope(args);
      const report = action === "prepare"
        ? prepareConsumers({ upstreamUrl: url, root: deps.root, runner: deps.runner, github: deps.github, auditEnvelope,
          existingPullRequests: { backend: option(args, "--backend-pr"), ide: option(args, "--ide-pr") } })
        : syncConsumers({ upstreamUrl: url, root: deps.root, runner: deps.runner, github: deps.github, auditEnvelope });
      deps.io.out(JSON.stringify(report, null, 2));
      return 0;
    }
    if (argv[1] === "status") {
      const url = argv[2];
      if (!url) throw new Error("status requires an upstream PR URL");
      const result = verifyStatus(url, deps.github);
      deps.io.out(argv.includes("--json") ? JSON.stringify(result, null, 2) : `Prepared ${result.fresh.backend.url} and ${result.fresh.ide.url} at ${result.report.upstream.pinSha}.`);
      return 0;
    }
    throw new Error(`unknown rollout command: ${argv[1]}`);
  } catch (error) {
    deps.io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
