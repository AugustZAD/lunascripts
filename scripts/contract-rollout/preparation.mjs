import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_COMMAND_TIMEOUT_MS } from "./command.mjs";
import { UPSTREAM_REPOSITORY, assertSha, contentDigest, validatePreparationReport as validateReport } from "./core.mjs";
import { parsePullRequestUrl } from "./github.mjs";
import { cleanupRolloutWorkspace, createRolloutWorkspace } from "./workspace.mjs";

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
      ".github/workflows/lunascripts-authority.yml", ".github/workflows/lunascripts-contract-audit.yml", "CLAUDE.md",
      "__tests__/core/schema-signal-int.test.ts", "app/core/lunascripts-contract.ts", "app/core/schema.ts", "app/core/types.ts",
      "app/services/release-content-health-policy.ts", "app/services/release-content-health-service.test.ts", "app/services/release-content-health-service.ts",
      "contracts/lunascripts", "contracts/lunascripts.lock.json", "package.json", "scripts/check-lunascripts-authority.mjs",
      "scripts/check-lunascripts-authority.test.ts", "scripts/lunascripts-contract-audit-lib.ts", "scripts/lunascripts-contract-audit.test.ts",
      "scripts/lunascripts-contract-audit.ts", "scripts/update-lunascripts-contract.mjs", "scripts/update-lunascripts-contract.test.mjs",
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
    owned: ["vendor/lunascripts", "vendor/README.md", ".bin/lsc", "agents/adaptation/skills/episode-writer/ls-spec.md", "agents/_shared/knowledge/LS-SPEC.md"],
    allowed: [
      ".github/workflows/lunascripts-authority.yml", "AGENTS.md", "agents/_shared/knowledge/LS-SPEC.md",
      "agents/adaptation/skills/entity-planner/SKILL.md", "agents/adaptation/skills/episode-writer/ls-spec.md",
      "agents/adaptation/skills/planner-reviewer/SKILL.md", "package.json", "scripts/check-lunascripts-authority.mjs",
      "scripts/update-vendor.mjs", "test/agent-guidance-contract.test.mjs", "test/lunascripts-authority.test.mjs",
      "test/update-vendor.test.mjs", "vendor/README.md", "vendor/lunascripts", ".bin/lsc",
    ],
  },
]);

export const validatePreparationReport = validateReport;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function payloadDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

export function rolloutBranch(version, upstreamSha) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("contract version must be semver");
  assertSha(upstreamSha, "upstream SHA");
  return `contract-rollout/v${version}-${upstreamSha.slice(0, 8)}`;
}

export function changedFiles(runner, cwd) {
  const output = runner.capture("git", ["status", "--porcelain=v1", "-z"], { cwd, trim: false });
  if (!output) return [];
  if (!output.endsWith("\0")) throw new Error("malformed git porcelain: missing NUL terminator");
  const fields = output.split("\0");
  fields.pop();
  const paths = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (entry.length < 4 || entry[2] !== " ") throw new Error("malformed git porcelain entry");
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      if (!fields[index + 1]) throw new Error("malformed git porcelain rename entry");
      paths.push(fields[++index]);
    }
  }
  return [...new Set(paths)].sort();
}

function isAllowed(path, allowed) {
  return allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function gitObjectType(mode) {
  if (mode === "000000") return "missing";
  if (mode === "160000") return "submodule";
  if (mode === "120000") return "symlink";
  if (mode.startsWith("100")) return "blob";
  return "unknown";
}

function parseRawDiff(raw) {
  if (!raw.endsWith("\0")) throw new Error("full diff evidence is missing its NUL terminator");
  const fields = raw.split("\0");
  fields.pop();
  const files = [];
  for (let index = 0; index < fields.length;) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z]\d*)$/.exec(fields[index++]);
    if (!match) throw new Error("full diff evidence contains a malformed raw record");
    const firstPath = fields[index++];
    const code = match[5];
    const renamed = code.startsWith("R") || code.startsWith("C");
    const path = renamed ? fields[index++] : firstPath;
    files.push({
      path,
      status: code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : code.startsWith("R") ? "renamed" : code.startsWith("C") ? "copied" : code === "T" ? "type_changed" : `unknown:${code}`,
      previousPath: renamed ? firstPath : null,
      oldMode: match[1], newMode: match[2], oldType: gitObjectType(match[1]), newType: gitObjectType(match[2]),
      baseBlobSha: match[3], headBlobSha: match[4],
    });
  }
  return files;
}

export function validateDiffEvidence(evidence, allowed) {
  for (const key of ["baseSha", "headSha", "mergeBaseSha", "headTreeSha", "expectedTreeSha"]) assertSha(evidence?.[key], `diff evidence ${key}`);
  if (evidence.mergeBaseSha !== evidence.baseSha) throw new Error("consumer branch diverges from its exact main base");
  if (evidence.headTreeSha !== evidence.expectedTreeSha) throw new Error("head tree does not match clean-base regenerated tree");
  if (!/^sha256:[0-9a-f]{64}$/.test(evidence.patchSha256 ?? "") || evidence.patchSha256 !== evidence.expectedPatchSha256) throw new Error("head patch does not match clean-base regenerated patch");
  if (!Array.isArray(evidence.files)) throw new Error("diff evidence files are missing");
  for (const file of evidence.files) {
    if (!isAllowed(file.path, allowed)) throw new Error(`unapproved consumer path: ${file.path}`);
    if (file.previousPath || file.status === "renamed" || file.status === "copied") throw new Error("rename and copy changes are forbidden");
    if (file.status === "deleted") throw new Error("delete changes are forbidden");
    if (!new Set(["added", "modified"]).has(file.status)) throw new Error(`unsafe diff status: ${file.status}`);
    if (file.newType === "symlink") throw new Error("symlink changes are forbidden");
    if (file.newType === "submodule") throw new Error("submodule changes are forbidden");
    if (!new Set(["100644", "100755"]).has(file.newMode) || file.newType !== "blob") throw new Error(`unsafe file mode or object type: ${file.newMode}`);
  }
  const material = { ...evidence };
  delete material.digest;
  if (evidence.digest !== payloadDigest(material)) throw new Error("diff evidence digest mismatch");
  return evidence;
}

export function buildDiffEvidence({ runner, cwd, baseSha, headSha, allowed, expectedTreeSha, expectedPatchSha256 }) {
  const evidence = {
    baseSha, headSha,
    mergeBaseSha: runner.capture("git", ["merge-base", baseSha, headSha], { cwd }),
    headTreeSha: runner.capture("git", ["rev-parse", `${headSha}^{tree}`], { cwd }),
    expectedTreeSha,
    patchSha256: `sha256:${createHash("sha256").update(runner.capture("git", ["diff", "--binary", "--full-index", "--no-ext-diff", baseSha, headSha, "--"], { cwd, trim: false })).digest("hex")}`,
    expectedPatchSha256,
    files: parseRawDiff(runner.capture("git", ["diff", "--raw", "-z", "--full-index", "--no-abbrev", baseSha, headSha, "--"], { cwd, trim: false })),
  };
  evidence.digest = payloadDigest(evidence);
  return validateDiffEvidence(evidence, allowed);
}

function sanitize(value, key = "") {
  if (/(?:secret|token|password|authorization|cookie)/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  if (typeof value !== "string") return value;
  let text = value.replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED]");
  if (/^https?:\/\//.test(text)) {
    try { const url = new URL(text); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; text = url.toString(); } catch {}
  }
  return text;
}

function validateAuditSource(source, report) {
  if (source?.repository !== report.consumers.backend.repository || source?.revision !== report.consumers.backend.headSha ||
      !/^sha256:[0-9a-f]{64}$/.test(source?.sourceReportSha256 ?? "")) throw new Error("audit source provenance does not match Backend");
  const bootstrap = source.kind === "bootstrap" && source.executable === "scripts/lunascripts-contract-audit.ts";
  const workflow = source.kind === "github-actions" && source.workflow === "lunascripts-contract-audit.yml" && Number.isInteger(source.runId) && source.runId > 0;
  if (!bootstrap && !workflow) throw new Error("audit source provenance is not authoritative");
}

export function bindAuditReport(report, raw, source) {
  validateAuditSource(source, report);
  if (raw?.readOnly !== true || !Array.isArray(raw.findings)) throw new Error("audit report must prove read-only execution with findings");
  return {
    schemaVersion: 1,
    provenance: {
      upstreamHeadSha: report.upstream.candidateHeadSha,
      backendHeadSha: report.consumers.backend.headSha,
      ideHeadSha: report.consumers.ide.headSha,
      contractVersion: report.contractVersion,
      source: structuredClone(source),
    },
    payloadDigest: payloadDigest(raw),
    report: structuredClone(raw),
  };
}

export function applyAuditReport(report, envelope) {
  if (envelope?.schemaVersion !== 1 || !envelope.provenance || !envelope.report) throw new Error("audit import requires a bound envelope");
  for (const [key, expected] of [
    ["upstreamHeadSha", report.upstream.candidateHeadSha], ["backendHeadSha", report.consumers.backend.headSha],
    ["ideHeadSha", report.consumers.ide.headSha], ["contractVersion", report.contractVersion],
  ]) if (envelope.provenance[key] !== expected) throw new Error(`audit provenance ${key} does not match preparation`);
  validateAuditSource(envelope.provenance.source, report);
  const raw = envelope.report;
  if (envelope.payloadDigest !== payloadDigest(raw) || raw.readOnly !== true || !Array.isArray(raw.findings)) throw new Error("audit payload is not an intact read-only report");
  const findings = sanitize(raw.findings);
  const blockers = findings.filter((finding) => /block/i.test(finding.status ?? ""));
  const repairRecommendations = findings.filter((finding) => /repair/i.test(finding.status ?? "")).map((finding) => ({
    novelId: finding.novelId ?? null, episodeId: finding.episodeId ?? null,
    suggestions: (finding.issues ?? []).map((issue) => ({ path: issue.path ?? null, action: issue.message ?? "manual review" })),
  }));
  if (blockers.length !== raw.blockers || repairRecommendations.length !== raw.repairRecommended) throw new Error("audit finding counts do not match summary counts");
  return validateReport({ ...report, audit: {
    status: blockers.length ? "blocked" : "passed", readOnly: true, episodeCount: raw.episodeCount, compatible: raw.compatible,
    blockers, repairRecommendations, findings, findingsDigest: payloadDigest(findings), reportDigest: envelope.payloadDigest,
    provenance: structuredClone(envelope.provenance), remediation: "manual_review_only",
  } });
}

export function executeConsumerUpdater(runner, consumer, cwd, pinSha) {
  const [command, args] = consumer.update(pinSha);
  const raw = runner.capture(command, args, { cwd, timeoutMs: TEST_COMMAND_TIMEOUT_MS, stage: `update ${consumer.key} contract pin` });
  JSON.parse(raw);
}

function assertOwnedChanges(runner, cwd, consumer) {
  const changed = changedFiles(runner, cwd);
  const unsafe = changed.filter((path) => !isAllowed(path, consumer.owned));
  if (unsafe.length) throw new Error(`${consumer.repository} updater changed paths it does not own: ${unsafe.join(", ")}`);
  return changed;
}

function regenerateExpected({ runner, consumer, baseDir, branch, startingHeadSha, baseSha, pinSha, hasExisting }) {
  const cwd = join(baseDir, `${consumer.key}-expected`);
  runner.capture("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${consumer.repository}.git`, cwd], { stage: `clone ${consumer.key} expected tree` });
  runner.capture("git", ["fetch", "origin", "main", ...(hasExisting ? [branch] : [])], { cwd });
  runner.capture("git", ["checkout", "--detach", startingHeadSha], { cwd });
  executeConsumerUpdater(runner, consumer, cwd, pinSha);
  assertOwnedChanges(runner, cwd, consumer);
  runner.capture("git", ["add", "--all", "--", ...consumer.owned], { cwd });
  const treeSha = runner.capture("git", ["write-tree"], { cwd });
  assertSha(treeSha, `${consumer.key} regenerated tree`);
  const patch = runner.capture("git", ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", baseSha, "--"], { cwd, trim: false });
  return { treeSha, patchSha256: `sha256:${createHash("sha256").update(patch).digest("hex")}` };
}

function manualBody(contractVersion, pinSha, upstreamUrl, evidence) {
  return [
    `## Lunaverse Script contract ${contractVersion}`, "", `Exact upstream pin: \`${pinSha}\` (${upstreamUrl})`, "",
    "This consumer PR is preparation-only. Merge, production release, production verification, and downstream merge are separate human actions.",
    "Stored production content remains read-only; listed repairs are suggestions only.", "",
    `Full diff evidence: \`${evidence.digest}\``, `Head tree: \`${evidence.headTreeSha}\``, `Binary patch: \`${evidence.patchSha256}\``,
  ].join("\n");
}

function completeRemoteEvidence(github, consumer, pr, local) {
  const before = github.getPullRequest(consumer.repository, pr.number);
  if (before.state !== "OPEN" || before.baseBranch !== "main" || before.headSha !== local.headSha || before.baseSha !== local.baseSha) throw new Error(`${consumer.repository} PR identity changed before diff pagination`);
  const remoteFiles = github.getPullRequestFiles(consumer.repository, pr.number);
  const after = github.getPullRequest(consumer.repository, pr.number);
  if (JSON.stringify({ state: before.state, baseSha: before.baseSha, headSha: before.headSha }) !== JSON.stringify({ state: after.state, baseSha: after.baseSha, headSha: after.headSha })) throw new Error(`${consumer.repository} PR raced during diff pagination`);
  if (remoteFiles.length !== local.files.length) throw new Error(`${consumer.repository} paginated file count does not match local full diff`);
  for (const file of local.files) {
    const remote = remoteFiles.find((item) => item.path === file.path);
    if (!remote || remote.previousPath || remote.status !== file.status || remote.headBlobSha !== file.headBlobSha) throw new Error(`${consumer.repository} remote diff metadata does not match ${file.path}`);
  }
  const evidence = { ...local, remoteFiles, remoteFilesDigest: contentDigest(remoteFiles) };
  delete evidence.digest;
  evidence.digest = payloadDigest(evidence);
  return validateDiffEvidence(evidence, consumer.allowed);
}

export function prepareConsumerWorkspace({ runner, github, consumer, branch, pinSha, contractVersion, upstreamUrl, baseDir, existingPullRequest = null, expectedHeadSha = null, requireExisting = false }) {
  const cwd = join(baseDir, consumer.key);
  runner.capture("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${consumer.repository}.git`, cwd], { stage: `clone ${consumer.key} consumer` });
  const existing = existingPullRequest ?? github.findPullRequestByHead(consumer.repository, branch);
  if (requireExisting && !existing) throw new Error(`${consumer.repository} sync requires its original open pull request`);
  runner.capture("git", ["fetch", "origin", "main", ...(existing ? [branch] : [])], { cwd });
  runner.capture("git", existing ? ["checkout", "-B", branch, `origin/${branch}`] : ["checkout", "-B", branch, "origin/main"], { cwd });
  const baseSha = runner.capture("git", ["rev-parse", "origin/main"], { cwd });
  const startingHeadSha = runner.capture("git", ["rev-parse", "HEAD"], { cwd });
  assertSha(baseSha, `${consumer.key} base SHA`);
  assertSha(startingHeadSha, `${consumer.key} starting SHA`);
  const lockedHeadSha = expectedHeadSha ?? existing?.headSha;
  if (lockedHeadSha && startingHeadSha !== lockedHeadSha) throw new Error(`${consumer.repository} checked out head changed before preparation`);
  runner.capture("git", ["merge-base", "--is-ancestor", baseSha, startingHeadSha], { cwd });
  const expected = regenerateExpected({ runner, consumer, baseDir, branch, startingHeadSha, baseSha, pinSha, hasExisting: Boolean(existing) });
  if (consumer.install) runner.capture(consumer.install[0], consumer.install[1], { cwd });
  executeConsumerUpdater(runner, consumer, cwd, pinSha);
  for (const [command, args, options = {}] of consumer.verify) runner.capture(command, args, { cwd: options.cwd ? join(cwd, options.cwd) : cwd });
  const changed = assertOwnedChanges(runner, cwd, consumer);
  if (changed.length) {
    runner.capture("git", ["add", "--all", "--", ...consumer.owned], { cwd });
    runner.capture("git", ["commit", "-m", `chore(ls): consume contract ${contractVersion}`], { cwd });
  }
  const headSha = runner.capture("git", ["rev-parse", "HEAD"], { cwd });
  const localEvidence = buildDiffEvidence({ runner, cwd, baseSha, headSha, allowed: consumer.allowed, expectedTreeSha: expected.treeSha, expectedPatchSha256: expected.patchSha256 });
  runner.capture("git", ["push", "origin", branch], { cwd });
  const title = `chore(ls): consume contract ${contractVersion}`;
  const body = manualBody(contractVersion, pinSha, upstreamUrl, localEvidence);
  const pr = existing
    ? github.updatePullRequest(consumer.repository, existing.number, { title, body, expectedHeadSha: headSha })
    : github.createPullRequest(consumer.repository, { branch, title, body, expectedHeadSha: headSha });
  const diffEvidence = completeRemoteEvidence(github, consumer, pr, localEvidence);
  return { repository: consumer.repository, pullRequest: pr.url, branch, headSha, diffEvidence };
}

function reportComments(github, upstream, consumers, report) {
  const upstreamRef = parsePullRequestUrl(upstream.pullRequest);
  const freshUpstream = github.getPullRequest(upstreamRef.repository, upstreamRef.number);
  const expectedUpstreamStatus = upstream.canonicalMergeSha ? "MERGED" : "OPEN";
  if (freshUpstream.state !== expectedUpstreamStatus || freshUpstream.baseBranch !== "main" || freshUpstream.headSha !== upstream.candidateHeadSha ||
      (upstream.canonicalMergeSha && freshUpstream.mergeSha !== upstream.canonicalMergeSha)) {
    throw new Error("upstream PR changed before preparation reports were written");
  }
  for (const consumer of Object.values(consumers)) {
    const ref = parsePullRequestUrl(consumer.pullRequest);
    const fresh = github.getPullRequest(ref.repository, ref.number);
    if (fresh.state !== "OPEN" || fresh.baseBranch !== "main" || fresh.headSha !== consumer.headSha) {
      throw new Error(`${consumer.repository} changed before preparation reports were written`);
    }
  }
  github.supersedeLegacyComment(upstreamRef.repository, upstreamRef.number);
  github.upsertPreparationReport(upstreamRef.repository, upstreamRef.number, report);
  for (const consumer of Object.values(consumers)) {
    const ref = parsePullRequestUrl(consumer.pullRequest);
    github.upsertPreparationReport(ref.repository, ref.number, report);
  }
}

function prepareAtPin({ upstream, pinSha, root, runner, github, consumers = CONSUMERS, existingPullRequests = {}, requireExisting = false, auditEnvelope = null, keepWorkspaces = false }) {
  const manifest = JSON.parse(readFileSync(join(root, "contract/contract.json"), "utf8"));
  const branch = rolloutBranch(manifest.contract_version, upstream.candidateHeadSha);
  const baseDir = createRolloutWorkspace();
  let primaryError = null;
  try {
    const prepared = {};
    for (const consumer of consumers) {
      let existing = null;
      const url = existingPullRequests[consumer.key];
      if (url) {
        const ref = parsePullRequestUrl(url);
        if (ref.repository !== consumer.repository) throw new Error(`${consumer.key} PR belongs to the wrong repository`);
        const pr = github.getPullRequest(ref.repository, ref.number);
        if (pr.state !== "OPEN" || !pr.headBranch) throw new Error(`${consumer.key} PR must remain open`);
        existing = { ...pr, number: ref.number };
      }
      prepared[consumer.key] = prepareConsumerWorkspace({
        runner, github, consumer, branch: existing?.headBranch ?? branch, pinSha, contractVersion: manifest.contract_version,
        upstreamUrl: upstream.pullRequest, baseDir, existingPullRequest: existing, expectedHeadSha: existing?.headSha,
        requireExisting,
      });
      github.waitPullRequestChecks(consumer.repository, parsePullRequestUrl(prepared[consumer.key].pullRequest).number, prepared[consumer.key].headSha);
    }
    let report = validateReport({
      schemaVersion: 2, kind: "consumer-preparation",
      upstream: { repository: UPSTREAM_REPOSITORY, pullRequest: upstream.pullRequest, baseBranch: "main", candidateHeadSha: upstream.candidateHeadSha, pinSha, ...(upstream.canonicalMergeSha ? { canonicalMergeSha: upstream.canonicalMergeSha } : {}) },
      contractVersion: manifest.contract_version,
      consumers: prepared,
      audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
    });
    if (auditEnvelope) report = applyAuditReport(report, auditEnvelope);
    reportComments(github, report.upstream, prepared, report);
    return report;
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw primaryError;
  } finally {
    if (!keepWorkspaces) cleanupRolloutWorkspace(baseDir, primaryError ? { primaryError } : {});
  }
}

export function prepareConsumers({ upstreamUrl, root, runner, github, existingPullRequests = {}, auditEnvelope = null, keepWorkspaces = false }) {
  const ref = parsePullRequestUrl(upstreamUrl);
  if (ref.repository !== UPSTREAM_REPOSITORY) throw new Error(`upstream must use ${UPSTREAM_REPOSITORY}`);
  const pr = github.getPullRequest(ref.repository, ref.number);
  if (pr.state !== "OPEN" || pr.baseBranch !== "main" || pr.mergeable !== "MERGEABLE") throw new Error("upstream candidate must be open, mergeable, and target main");
  const localHead = runner.capture("git", ["rev-parse", "HEAD"], { cwd: root });
  if (localHead !== pr.headSha) throw new Error("local HEAD does not match the exact upstream PR candidate");
  return prepareAtPin({ upstream: { pullRequest: upstreamUrl, candidateHeadSha: pr.headSha }, pinSha: pr.headSha, root, runner, github, existingPullRequests, auditEnvelope, keepWorkspaces });
}

export function syncConsumers({ upstreamUrl, root, runner, github, auditEnvelope = null, keepWorkspaces = false }) {
  const ref = parsePullRequestUrl(upstreamUrl);
  if (ref.repository !== UPSTREAM_REPOSITORY) throw new Error(`upstream must use ${UPSTREAM_REPOSITORY}`);
  const previous = github.readPreparationReport(ref.repository, ref.number);
  const pr = github.getPullRequest(ref.repository, ref.number);
  if (pr.state !== "MERGED" || pr.baseBranch !== "main" || !SHA_RE.test(pr.mergeSha ?? "")) throw new Error("sync requires the original upstream PR merged into main");
  if (pr.headSha !== previous.upstream.candidateHeadSha) throw new Error("upstream PR candidate changed after preparation");
  if (!github.isCommitReachableFromMain(ref.repository, pr.mergeSha)) throw new Error("canonical merge SHA is not reachable from upstream main");
  return prepareAtPin({
    upstream: { pullRequest: upstreamUrl, candidateHeadSha: pr.headSha, canonicalMergeSha: pr.mergeSha }, pinSha: pr.mergeSha,
    root, runner, github, existingPullRequests: { backend: previous.consumers.backend.pullRequest, ide: previous.consumers.ide.pullRequest },
    requireExisting: true, auditEnvelope, keepWorkspaces,
  });
}
