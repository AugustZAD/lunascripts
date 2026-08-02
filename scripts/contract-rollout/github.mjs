import { parseJsonOutput } from "./command.mjs";
import { contentDigest, validatePreparationReport } from "./core.mjs";
import { gunzipSync, gzipSync } from "node:zlib";

export const PREPARATION_COMMENT_MARKER = "<!-- lunaverse-consumer-preparation:v2 -->";
export const LEGACY_COMMENT_MARKER = "<!-- lunaverse-contract-rollout:v1 -->";
const RECORD_START = "<!-- preparation-report-json";
const RECORD_END = "preparation-report-json -->";
const FINDING_MARKER = "lunaverse-consumer-findings:v2";

export function parsePullRequestUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(String(url));
  if (!match) throw new Error(`expected a canonical GitHub pull request URL, received: ${url}`);
  return { repository: match[1], number: Number(match[2]) };
}

function normalizeChecks(items = []) {
  return items.map((item) => item.__typename === "StatusContext" ? {
    name: item.context,
    status: String(item.state ?? "").toLowerCase() === "pending" ? "pending" : "completed",
    conclusion: String(item.state ?? "").toLowerCase() === "pending" ? null : String(item.state ?? "").toLowerCase(),
    url: item.targetUrl ?? null,
  } : {
    name: item.name,
    status: String(item.status ?? "").toLowerCase(),
    conclusion: item.conclusion ? String(item.conclusion).toLowerCase() : null,
    url: item.detailsUrl ?? null,
  });
}

function findingLine(finding) {
  const issues = (finding.issues ?? []).map((issue) => `${issue.path ?? "(root)"}: ${issue.message ?? "manual review"}`).join("; ");
  return `- \`${finding.novelId ?? "?"}/${finding.episodeId ?? "?"}\` — ${finding.status ?? "review"}${issues ? ` — manual suggestions: ${issues}` : ""}\n  - Full sanitized finding: \`${JSON.stringify(finding)}\``;
}

export function renderPreparationReport(report) {
  const value = validatePreparationReport(report);
  const encoded = gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");
  const lines = [
    PREPARATION_COMMENT_MARKER,
    "## Lunaverse Script consumer preparation",
    "",
    `Contract: **${value.contractVersion}**`,
    `Pinned upstream: \`${value.upstream.pinSha}\``,
    `Backend PR: ${value.consumers.backend.pullRequest} @ \`${value.consumers.backend.headSha}\``,
    `IDE PR: ${value.consumers.ide.pullRequest} @ \`${value.consumers.ide.headSha}\``,
    `Read-only audit: **${value.audit.status}** — ${value.audit.blockers.length} blocker(s), ${value.audit.repairRecommendations.length} manual repair recommendation(s).`,
    "",
    "Production content is read-only. Every repair remains a human action. Backend merge, production release, verification, and IDE merge are separate manual steps.",
    "",
    "Complete sanitized findings and manual suggestions are published in the numbered companion comments.",
    "",
    `Findings digest: \`${value.audit.findingsDigest ?? "pending"}\``,
    `Report digest: \`${contentDigest(value)}\``,
    "",
    RECORD_START,
    encoded,
    RECORD_END,
  ];
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 64_000) throw new Error("preparation report exceeds the GitHub comment safety limit");
  return body;
}

export function parsePreparationReport(body) {
  if (!String(body).includes(PREPARATION_COMMENT_MARKER)) return null;
  const start = String(body).indexOf(RECORD_START);
  const end = String(body).indexOf(RECORD_END, start + RECORD_START.length);
  if (start < 0 || end < 0) throw new Error("preparation comment has no machine-readable report");
  const encoded = String(body).slice(start + RECORD_START.length, end).trim();
  try {
    return validatePreparationReport(JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")));
  } catch (error) {
    throw new Error(`preparation comment payload is invalid: ${error.message}`);
  }
}

export function renderFindingComments(report) {
  const value = validatePreparationReport(report);
  if (!value.audit.findings.length) return [];
  const chunks = [];
  let lines = [];
  const flush = () => {
    const index = chunks.length + 1;
    chunks.push([`<!-- ${FINDING_MARKER}:${index} -->`, `## Sanitized audit findings — part ${index}`, "", `Digest: \`${value.audit.findingsDigest}\``, "", ...lines].join("\n"));
    lines = [];
  };
  for (const finding of value.audit.findings) {
    const line = findingLine(finding);
    const probe = [`<!-- ${FINDING_MARKER}:${chunks.length + 1} -->`, "## Sanitized audit findings", "", ...lines, line].join("\n");
    if (Buffer.byteLength(probe) > 50_000 && lines.length) flush();
    lines.push(line);
  }
  if (lines.length) flush();
  return chunks;
}

export function createGitHubClient(runner) {
  const json = (args, label, options) => parseJsonOutput(runner.capture("gh", args, options), label);
  const paged = (args, label) => {
    const pages = json([...args, "--paginate", "--slurp"], label);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error(`${label} pagination response is malformed`);
    return pages.flat();
  };
  const listComments = (repository, number) => paged(["api", `repos/${repository}/issues/${number}/comments?per_page=100`], "GitHub comments");

  const client = {
    getPullRequest(repository, number, commandOptions) {
      const pr = json(["pr", "view", String(number), "--repo", repository, "--json",
        "number,url,state,isDraft,headRefName,baseRefName,baseRefOid,headRefOid,mergeCommit,mergeable,statusCheckRollup"], "GitHub pull request", commandOptions);
      return {
        number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft === true,
        headBranch: pr.headRefName ?? null, baseBranch: pr.baseRefName ?? null,
        baseSha: pr.baseRefOid ?? null, headSha: pr.headRefOid, mergeSha: pr.mergeCommit?.oid ?? null,
        mergeable: pr.mergeable, checks: normalizeChecks(pr.statusCheckRollup),
      };
    },

    findPullRequestByHead(repository, branch) {
      const pulls = json(["pr", "list", "--repo", repository, "--state", "open", "--head", branch,
        "--json", "number,url,headRefOid,headRefName", "--limit", "2"], "GitHub pull requests");
      if (pulls.length > 1) throw new Error(`multiple open pull requests use ${repository}:${branch}`);
      return pulls[0] ? { number: pulls[0].number, url: pulls[0].url, headSha: pulls[0].headRefOid, headBranch: pulls[0].headRefName } : null;
    },

    createPullRequest(repository, { branch, title, body, expectedHeadSha }) {
      const url = runner.capture("gh", ["pr", "create", "--repo", repository, "--head", branch, "--base", "main", "--title", title, "--body", body]);
      const parsed = parsePullRequestUrl(url.trim());
      const pr = client.getPullRequest(repository, parsed.number);
      if (pr.headSha !== expectedHeadSha || pr.state !== "OPEN") throw new Error("created consumer PR did not preserve its exact pushed head");
      return pr;
    },

    updatePullRequest(repository, number, { title, body, expectedHeadSha }) {
      const before = client.getPullRequest(repository, number);
      if (before.state !== "OPEN" || before.headSha !== expectedHeadSha) throw new Error("consumer PR changed before metadata update");
      runner.capture("gh", ["pr", "edit", String(number), "--repo", repository, "--title", title, "--body", body]);
      const after = client.getPullRequest(repository, number);
      if (after.state !== "OPEN" || after.headSha !== expectedHeadSha) throw new Error("consumer PR changed during metadata update");
      return after;
    },

    getPullRequestFiles(repository, number) {
      return paged(["api", `repos/${repository}/pulls/${number}/files?per_page=100`], "GitHub pull request files").map((row) => ({
        path: row.filename,
        previousPath: row.previous_filename ?? null,
        status: row.status,
        headBlobSha: row.sha,
      }));
    },

    isCommitReachableFromMain(repository, sha) {
      const comparison = json(["api", `repos/${repository}/compare/${sha}...main`], "GitHub comparison");
      return comparison.merge_base_commit?.sha === sha && new Set(["ahead", "identical"]).has(comparison.status);
    },

    waitPullRequestChecks(repository, number, expectedHeadSha, timeoutMs = 30 * 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pr = client.getPullRequest(repository, number, { timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())), stage: `poll ${repository} consumer checks` });
        if (pr.headSha !== expectedHeadSha) throw new Error(`${repository} PR head changed while checks were running`);
        const failed = pr.checks.find((check) => check.status === "completed" && check.conclusion !== "success");
        if (failed) throw new Error(`${repository} check failed: ${failed.name}`);
        if (pr.checks.length && pr.checks.every((check) => check.status === "completed" && check.conclusion === "success")) return pr;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10_000, Math.max(0, deadline - Date.now())));
      }
      throw new Error(`${repository} pull request checks timed out`);
    },

    readPreparationReport(repository, number) {
      const comments = listComments(repository, number).filter((comment) => String(comment.body).includes(PREPARATION_COMMENT_MARKER));
      if (comments.length !== 1) throw new Error(`expected exactly one preparation report, found ${comments.length}`);
      return parsePreparationReport(comments[0].body);
    },

    upsertPreparationReport(repository, number, report) {
      const body = renderPreparationReport(report);
      const allComments = listComments(repository, number);
      const comments = allComments.filter((comment) => String(comment.body).includes(PREPARATION_COMMENT_MARKER));
      if (comments.length > 1) throw new Error("multiple preparation reports are unsafe");
      const args = comments[0]
        ? ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${comments[0].id}`, "-f", `body=${body}`]
        : ["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${body}`];
      runner.capture("gh", args);
      const findingBodies = renderFindingComments(report);
      const findingComments = allComments.filter((comment) => new RegExp(`<!-- ${FINDING_MARKER}:\\d+ -->`).test(String(comment.body)));
      for (let index = 0; index < findingBodies.length; index++) {
        const existing = findingComments.find((comment) => String(comment.body).includes(`<!-- ${FINDING_MARKER}:${index + 1} -->`));
        runner.capture("gh", existing
          ? ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "-f", `body=${findingBodies[index]}`]
          : ["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${findingBodies[index]}`]);
      }
      for (const extra of findingComments.filter((comment) => {
        const index = Number(String(comment.body).match(new RegExp(`<!-- ${FINDING_MARKER}:(\\d+) -->`))?.[1]);
        return index > findingBodies.length;
      })) {
        runner.capture("gh", ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${extra.id}`, "-f",
          `body=<!-- ${FINDING_MARKER}:superseded -->\nSuperseded by a shorter sanitized findings report.`]);
      }
      return report;
    },

    supersedeLegacyComment(repository, number) {
      const comments = listComments(repository, number).filter((comment) => String(comment.body).includes(LEGACY_COMMENT_MARKER));
      if (comments.length > 1) throw new Error("multiple legacy comments require human review");
      if (comments[0]) runner.capture("gh", ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${comments[0].id}`, "-f",
        `body=${LEGACY_COMMENT_MARKER}\nSuperseded by the preparation-only consumer report. This historical comment is not executable.`]);
    },

    dispatchReadOnlyAudit(branch) {
      runner.run("gh", ["workflow", "run", "lunascripts-contract-audit.yml", "--repo", "cdotlock/lunaverse-backend", "--ref", branch]);
    },
  };
  return client;
}
