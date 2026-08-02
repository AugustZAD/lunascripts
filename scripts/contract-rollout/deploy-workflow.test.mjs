import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/deploy-railway.yml", import.meta.url), "utf8");
const api = readFileSync(new URL("../../api_server.py", import.meta.url), "utf8");

test("Railway deploy binds and verifies one exact source revision", () => {
  assert.match(workflow, /TARGET_REVISION/);
  assert.match(workflow, /TARGET_DEPLOYMENT_ID/);
  assert.match(workflow, /deployment list/);
  assert.match(workflow, /\.revision == \$revision/);
  assert.match(api, /revision\.txt/);
});

test("active-target failure restores and verifies the captured deployment", () => {
  assert.ok(workflow.indexOf("PRE_ROLLOUT_DEPLOYMENT_ID") < workflow.indexOf("railway up"));
  assert.match(workflow, /usePreviousImageTag: true/);
  assert.match(workflow, /activeDeployments/);
  assert.match(workflow, /ROLLBACK_VERIFIED=1/);
  assert.match(workflow, /lunascripts-deployment-result\.json/);
});

test("merging main cannot auto-deploy and controller dispatch binds an approved revision", () => {
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /DEPLOY_APPROVED_CONTRACT_ROLLOUT/);
  assert.match(workflow, /inputs\.revision/);
  assert.match(workflow, /test "\$TARGET_REVISION" = "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /\n\s+environment:\s*production\s*$/m);
  assert.match(workflow, /secrets\.RAILWAY_API_TOKEN/);
  assert.doesNotMatch(workflow, /test '\$\{\{ inputs\.confirm \}\}'/);
});
