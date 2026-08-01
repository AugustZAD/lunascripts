import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStableRingFromHealth } from "./execution.mjs";
import { parsePullRequestUrl } from "./github.mjs";
import { CONSUMERS, prepareConsumerWorkspace } from "./preparation.mjs";

const UPSTREAM_REPO = "cdotlock/lunascripts";
const BACKEND_REPO = "cdotlock/lunaverse-backend";
const UPSTREAM_HEALTH = "https://moonshort-script-production.up.railway.app/health";
const PUBLIC_BACKEND_HEALTH = "https://app.moonshort.ai/api/health";
const REVIEWED_RINGS = ["app070902", "app070903", "app070905", "app071401", "app072101", "app072401"];

async function getJson(fetchFn, url) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function waitDispatched(github, repository, workflow, expectedHeadSha, started) {
  return github.waitForWorkflowRun(repository, workflow, { expectedHeadSha, createdAfter: started });
}

export function createExecutionActions({ github, runner, fetchFn = fetch }) {
  return {
    async mergeUpstream(ref) {
      const parsed = parsePullRequestUrl(ref.pullRequest);
      return github.mergePullRequest(parsed.repository, parsed.number, ref.headSha, "merge");
    },

    async refreshConsumerPins(record, canonicalSha) {
      if (github.getBranchSha(UPSTREAM_REPO, "main") !== canonicalSha) throw new Error("upstream canonical main does not match its merge result");
      const baseDir = mkdtempSync(join(tmpdir(), "lunascripts-canonical-repin-"));
      try {
        const result = {};
        for (const consumer of CONSUMERS) {
          const current = parsePullRequestUrl(record[consumer.key].pullRequest);
          const pr = github.getPullRequest(current.repository, current.number);
          if (!pr.headBranch) throw new Error(`${consumer.repository} PR has no head branch`);
          const updated = prepareConsumerWorkspace({
            runner, github, consumer, branch: pr.headBranch, upstreamSha: canonicalSha,
            contractVersion: record.contractVersion, upstreamUrl: record.upstream.pullRequest, baseDir,
          });
          if (parsePullRequestUrl(updated.pullRequest).number !== current.number) throw new Error(`${consumer.repository} canonical refresh created a different PR`);
          result[consumer.key] = updated;
        }
        return result;
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    },

    async waitConsumerChecks(backend, ide) {
      for (const ref of [backend, ide]) {
        const parsed = parsePullRequestUrl(ref.pullRequest);
        github.waitPullRequestChecks(parsed.repository, parsed.number, ref.headSha);
      }
    },

    async deployAndVerifyUpstream(revision) {
      const started = new Date(Date.now() - 5_000).toISOString();
      github.dispatchWorkflow(UPSTREAM_REPO, "deploy-railway.yml", "main");
      const run = waitDispatched(github, UPSTREAM_REPO, "deploy-railway.yml", revision, started);
      const completed = github.watchWorkflowRun(UPSTREAM_REPO, run.databaseId);
      if (completed.conclusion !== "success") throw new Error(`Lunaverse Scripts deployment failed: ${completed.url}`);
      const health = await getJson(fetchFn, UPSTREAM_HEALTH);
      if (health.status !== "ok" || health.revision !== revision) throw new Error("Lunaverse Scripts production revision mismatch");
      return { runId: run.databaseId, url: completed.url, revision };
    },

    async mergeBackend(ref) {
      const parsed = parsePullRequestUrl(ref.pullRequest);
      return github.mergePullRequest(parsed.repository, parsed.number, ref.headSha, "merge");
    },

    async resolveStableRing() {
      const publicHealth = await getJson(fetchFn, PUBLIC_BACKEND_HEALTH);
      const ringHealth = {};
      await Promise.all(REVIEWED_RINGS.map(async (ring) => {
        try {
          ringHealth[ring] = await getJson(fetchFn, `https://app-${ring}.up.railway.app/api/health`);
        } catch {
          // Deleted or unhealthy reviewed rings are not candidates.
        }
      }));
      return resolveStableRingFromHealth(publicHealth, ringHealth);
    },

    async deployBackend(revision, ring) {
      if (github.getBranchSha(BACKEND_REPO, "main") !== revision) throw new Error("Backend canonical main does not match its merge result");
      const started = new Date(Date.now() - 5_000).toISOString();
      github.dispatchWorkflow(BACKEND_REPO, "railway-shared-persistence-env-deploy.yml", "main", {
        confirm: "DEPLOY_REVIEWED_APP_RING",
        target_environment: ring.environment,
        revision,
      });
      const run = waitDispatched(github, BACKEND_REPO, "railway-shared-persistence-env-deploy.yml", revision, started);
      const completed = github.watchWorkflowRun(BACKEND_REPO, run.databaseId);
      const directory = mkdtempSync(join(tmpdir(), "backend-rollout-result-"));
      try {
        github.downloadArtifact(BACKEND_REPO, run.databaseId, `contract-rollout-${run.databaseId}`, directory);
        const result = JSON.parse(readFileSync(join(directory, "contract-rollout-result.json"), "utf8"));
        return { ...result, runId: run.databaseId, url: completed.url };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },

    async verifyProduction(revision, ring) {
      const [publicHealth, directHealth] = await Promise.all([
        getJson(fetchFn, PUBLIC_BACKEND_HEALTH),
        getJson(fetchFn, `https://app-${ring.environment}.up.railway.app/api/health`),
      ]);
      for (const [label, health] of [["public", publicHealth], ["direct", directHealth]]) {
        if (health?.data?.status !== "healthy" || health?.data?.queueConnectivity !== "ok" || health?.data?.revision !== revision) {
          throw new Error(`${label} Backend production smoke did not match ${revision}`);
        }
      }
    },

    async mergeIde(ref) {
      const parsed = parsePullRequestUrl(ref.pullRequest);
      return github.mergePullRequest(parsed.repository, parsed.number, ref.headSha, "merge");
    },
  };
}
