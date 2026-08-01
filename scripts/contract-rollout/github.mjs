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

    getPullRequest(repository, number) {
      const pr = json([
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,headRefOid,mergeCommit,mergeable,statusCheckRollup",
      ], "GitHub pull request");
      return {
        number: pr.number,
        url: pr.url,
        state: pr.state,
        headSha: pr.headRefOid,
        mergeSha: pr.mergeCommit?.oid ?? null,
        mergeable: pr.mergeable,
        checks: normalizeChecks(pr.statusCheckRollup),
      };
    },

    listPullRequestChecks(repository, number) {
      return client.getPullRequest(repository, number).checks;
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
  };
  return client;
}
