/** State-machine fixture only. E0, discrimination, and sandbox tests use real preparation. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '../exitcode-core.mjs';
import { captureEvaluatorAssets, evaluatorEnvironment } from '../exitcode-evaluator.mjs';

export function preparedFixture(io, { nodeId = 'G1', passing = [] } = {}) {
  const { draft } = JSON.parse(fs.readFileSync(core.draftFile(io.cwd, nodeId), 'utf8'));
  const node = core.loadNodeState(io, nodeId), root = core.loadRoot(io, node.rootId);
  const candidateDigest = core.digestTree(io.cwd);
  const assetsDirectory = path.join(core.storePaths(io.cwd).assetsDir, `${nodeId}.prepared`);
  const outcomes = draft.criteria.map(c => ({ criterionId: c.id,
    status: c.type === 'regression' || passing.includes(c.id) ? 'PASS' : 'FAIL', reasons: [] }));
  node.prepared = {
    draftDigest: core.sha256Hex(core.stableStringify(draft)), candidateDigest,
    environment: evaluatorEnvironment(io.cwd),
    assets: captureEvaluatorAssets(io.cwd, draft, assetsDirectory), assetsDirectory,
    intentDigest: core.intentDigestOf(draft), evaluatorDigest: core.evaluatorDigestOf(draft),
    stages: [], warnings: [],
    baseline: { candidateDigest, outcomes, allPass: outcomes.every(o => o.status === 'PASS'), at: new Date(io.nowMs()).toISOString() },
  };
  node.preparedDigest = core.sha256Hex(core.stableStringify(node.prepared));
  node.phase = 'READY_FOR_APPROVAL';
  if (!node.parentId) {
    root.validatedBundleDigest = node.preparedDigest;
    root.reviewDigest = core.rootReviewDigest(root, draft);
    core.saveRoot(io, root);
  }
  core.saveNodeState(io, node);
  return node.prepared;
}
