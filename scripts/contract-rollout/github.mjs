import { createHash } from "node:crypto";

import { parseJsonOutput } from "./command.mjs";
import { validateRolloutRecord } from "./core.mjs";

export const ROLLOUT_COMMENT_MARKER = "<!-- lunaverse-contract-rollout:v1 -->";
const RECORD_START = "<!-- rollout-record-json";
const RECORD_END = "rollout-record-json -->";

export function parsePullRequestUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(String(url));
  if (!match) throw new Error(`Expected a canonical GitHub pull request URL, received: ${url}`);
  return { repository: match[1], number: Number(match[2]) };
}

export function renderRolloutComment(record) {
  const value = validateRolloutRecord(record);
  return [
    ROLLOUT_COMMENT_MARKER,
    "## Lunaverse Script contract rollout",
    "",
    `State: **${value.state}**  `,
    `Contract: **${value.contractVersion} (${value.changeClass})**  `,
    `Backend audit: **${value.audit.status}** — ${value.audit.blockers} blocker(s), ${value.audit.repairRecommended} repair recommendation(s).`,
    value.audit.remediation === "manual_review_only"
      ? "Repair policy: **manual review only**; this rollout never modifies stored content."
      : "Repair policy: audit pending; stored content remains read-only.",
    "",
    "This record is reconstructed and revalidated by `contractctl`; the comment itself is not an authorization token.",
    "",
    RECORD_START,
    JSON.stringify(value, null, 2),
    RECORD_END,
  ].join("\n");
}

export function parseRolloutComment(body) {
  if (!String(body).includes(ROLLOUT_COMMENT_MARKER)) return null;
  const start = String(body).indexOf(RECORD_START);
  const end = String(body).indexOf(RECORD_END, start + RECORD_START.length);
  if (start < 0 || end < 0) throw new Error("rollout comment is missing its machine-readable record");
  const raw = String(body).slice(start + RECORD_START.length, end).trim();
  return validateRolloutRecord(parseJsonOutput(raw, "rollout comment"));
}

function normalizeChecks(items = []) {
  return items.map((item) => {
    if (item.__typename === "StatusContext") {
      const state = String(item.state ?? "").toLowerCase();
      return {
        name: item.context,
        status: state === "pending" ? "pending" : "completed",
        conclusion: state === "pending" ? null : state,
        url: item.targetUrl ?? null,
      };
    }
    return {
      name: item.name,
      status: String(item.status ?? "").toLowerCase(),
      conclusion: item.conclusion ? String(item.conclusion).toLowerCase() : null,
      url: item.detailsUrl ?? null,
    };
  });
}

export function createGitHubClient(runner) {
  const json = (args, label) => parseJsonOutput(runner.capture("gh", args), label);
  const listComments = (repository, number) =>
    json(["api", `repos/${repository}/issues/${number}/comments`, "--paginate"], "GitHub comments");

  const client = {
    getAuthenticatedActor() {
      return json(["api", "user"], "GitHub user").login;
    },

    getBranchSha(repository, branch = "main") {
      const value = json(["api", `repos/${repository}/commits/${branch}`], "GitHub branch commit");
      if (!/^[0-9a-f]{40}$/.test(value.sha ?? "")) throw new Error(`${repository}:${branch} did not resolve a full SHA`);
      return value.sha;
    },

    getTreeDigest(repository, revision) {
      const value = json(["api", `repos/${repository}/git/commits/${revision}`], "GitHub commit");
      const treeSha = value.tree?.sha;
      if (!/^[0-9a-f]{40}$/.test(treeSha ?? "")) throw new Error(`${repository}:${revision} did not resolve an exact Git tree`);
      return `sha256:${createHash("sha256").update(treeSha).digest("hex")}`;
    },

    getPullRequest(repository, number) {
      const pr = json([
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit,mergeable,statusCheckRollup",
      ], "GitHub pull request");
      return {
        number: pr.number,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft === true,
        headBranch: pr.headRefName ?? null,
        baseBranch: pr.baseRefName ?? null,
        headSha: pr.headRefOid,
        mergeSha: pr.mergeCommit?.oid ?? null,
        mergeable: pr.mergeable,
        checks: normalizeChecks(pr.statusCheckRollup),
      };
    },

    findPullRequestByHead(repository, branch) {
      const pulls = json([
        "pr", "list", "--repo", repository, "--state", "open", "--head", branch,
        "--json", "number,url,headRefOid,headRefName", "--limit", "2",
      ], "GitHub pull requests");
      if (pulls.length > 1) throw new Error(`multiple open pull requests use ${repository}:${branch}`);
      if (!pulls[0]) return null;
      return { number: pulls[0].number, url: pulls[0].url, headSha: pulls[0].headRefOid, headBranch: pulls[0].headRefName };
    },

    createPullRequest(repository, { branch, base, title, body, expectedHeadSha }) {
      const url = runner.capture("gh", ["pr", "create", "--repo", repository, "--head", branch, "--base", base, "--title", title, "--body", body]);
      const parsed = parsePullRequestUrl(url.trim());
      const pr = client.getPullRequest(repository, parsed.number);
      if (pr.headSha !== expectedHeadSha) throw new Error(`created PR head ${pr.headSha} does not match pushed ${expectedHeadSha}`);
      return pr;
    },

    updatePullRequest(repository, number, { title, body, expectedHeadSha }) {
      const before = client.getPullRequest(repository, number);
      if (before.headSha !== expectedHeadSha) throw new Error(`PR head ${before.headSha} does not match pushed ${expectedHeadSha}`);
      runner.capture("gh", ["pr", "edit", String(number), "--repo", repository, "--title", title, "--body", body]);
      const after = client.getPullRequest(repository, number);
      if (after.headSha !== expectedHeadSha) throw new Error("PR head changed while its description was updated");
      return after;
    },

    markPullRequestReady(repository, number, expectedHeadSha) {
      const before = client.getPullRequest(repository, number);
      if (before.headSha !== expectedHeadSha) throw new Error(`draft PR head ${before.headSha} does not match expected ${expectedHeadSha}`);
      if (!before.isDraft) return before;
      runner.run("gh", ["pr", "ready", String(number), "--repo", repository]);
      const after = client.getPullRequest(repository, number);
      if (after.headSha !== expectedHeadSha || after.isDraft) throw new Error("pull request ready transition could not be verified");
      return after;
    },

    listPullRequestChecks(repository, number) {
      return client.getPullRequest(repository, number).checks;
    },

    getPullRequestFiles(repository, number) {
      const rows = json(["api", `repos/${repository}/pulls/${number}/files`, "--paginate"], "GitHub pull request files");
      const paths = [];
      for (const row of rows) {
        if (typeof row.filename === "string") paths.push(row.filename);
        if (typeof row.previous_filename === "string") paths.push(row.previous_filename);
      }
      return [...new Set(paths)].sort();
    },

    waitPullRequestChecks(repository, number, expectedHeadSha, timeoutMs = 30 * 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pr = client.getPullRequest(repository, number);
        if (pr.headSha !== expectedHeadSha) throw new Error(`${repository} PR head changed while checks were running`);
        const checks = pr.checks;
        const failed = checks.find((check) => check.status === "completed" && check.conclusion !== "success");
        if (failed) throw new Error(`${repository} check failed: ${failed.name}`);
        if (checks.length > 0 && checks.every((check) => check.status === "completed" && check.conclusion === "success")) return pr;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      }
      throw new Error(`${repository} pull request checks timed out`);
    },

    readRolloutRecord(repository, number) {
      const marked = listComments(repository, number).filter((comment) => String(comment.body).includes(ROLLOUT_COMMENT_MARKER));
      if (marked.length !== 1) throw new Error(`Expected exactly one rollout comment, found ${marked.length}`);
      return parseRolloutComment(marked[0].body);
    },

    upsertRolloutComment(repository, number, record) {
      const body = renderRolloutComment(record);
      const marked = listComments(repository, number).filter((comment) => String(comment.body).includes(ROLLOUT_COMMENT_MARKER));
      if (marked.length > 1) throw new Error(`Refusing to update ${marked.length} rollout comments`);
      if (marked.length === 1) {
        runner.capture("gh", [
          "api",
          "--method",
          "PATCH",
          `repos/${repository}/issues/comments/${marked[0].id}`,
          "-f",
          `body=${body}`,
        ]);
      } else {
        runner.capture("gh", [
          "api",
          "--method",
          "POST",
          `repos/${repository}/issues/${number}/comments`,
          "-f",
          `body=${body}`,
        ]);
      }
      const verified = listComments(repository, number).filter((comment) => String(comment.body).includes(ROLLOUT_COMMENT_MARKER));
      if (verified.length !== 1) throw new Error("rollout comment write could not be verified");
      const actual = parseRolloutComment(verified[0].body);
      if (JSON.stringify(actual) !== JSON.stringify(validateRolloutRecord(record))) {
        throw new Error("rollout comment read-after-write mismatch");
      }
      return actual;
    },

    mergePullRequest(repository, number, expectedHeadSha, method = "squash") {
      if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) throw new Error("expectedHeadSha must be a full SHA");
      if (!new Set(["merge", "squash", "rebase"]).has(method)) throw new Error(`unsupported merge method: ${method}`);
      runner.run("gh", [
        "pr",
        "merge",
        String(number),
        "--repo",
        repository,
        `--${method}`,
        "--match-head-commit",
        expectedHeadSha,
      ]);
      const merged = client.getPullRequest(repository, number);
      if (merged.state !== "MERGED" || !merged.mergeSha) throw new Error("pull request merge could not be verified");
      return merged;
    },

    dispatchWorkflow(repository, workflow, ref, inputs = {}) {
      const args = ["workflow", "run", workflow, "--repo", repository, "--ref", ref];
      for (const [key, value] of Object.entries(inputs)) args.push("-f", `${key}=${value}`);
      runner.run("gh", args);
    },

    findWorkflowRun(repository, workflow, { createdAfter, expectedHeadSha } = {}) {
      const runs = json([
        "run", "list", "--repo", repository, "--workflow", workflow, "--event", "workflow_dispatch",
        "--limit", "20", "--json", "databaseId,headSha,headBranch,status,conclusion,createdAt,url",
      ], "GitHub workflow runs").filter((run) => {
        if (expectedHeadSha && run.headSha !== expectedHeadSha) return false;
        if (createdAfter && new Date(run.createdAt) < new Date(createdAfter)) return false;
        return true;
      });
      if (runs.length !== 1) throw new Error(`Expected exactly one matching ${repository}/${workflow} run, found ${runs.length}`);
      return runs[0];
    },

    watchWorkflowRun(repository, runId) {
      runner.run("gh", ["run", "watch", String(runId), "--repo", repository]);
      const run = json(["run", "view", String(runId), "--repo", repository, "--json", "databaseId,headSha,status,conclusion,url"], "GitHub workflow run");
      if (run.status !== "completed") throw new Error(`workflow run ${runId} is not complete`);
      return run;
    },

    waitForWorkflowRun(repository, workflow, options = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const deadline = Date.now() + timeoutMs;
      let lastError;
      while (Date.now() < deadline) {
        try {
          return client.findWorkflowRun(repository, workflow, options);
        } catch (error) {
          lastError = error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
        }
      }
      throw new Error(`workflow dispatch did not become visible: ${lastError?.message ?? "timeout"}`);
    },

    downloadArtifact(repository, runId, artifactName, directory) {
      runner.run("gh", ["run", "download", String(runId), "--repo", repository, "--name", artifactName, "--dir", directory]);
    },
  };
  return client;
}
