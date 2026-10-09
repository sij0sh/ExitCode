import assert from 'node:assert/strict';
import { baseline } from './test/suite.mjs';
import { parseReviewResponse, validateCritic } from './exitcode-quality.mjs';
import { reviewRegistry } from './test/adapter-review-cases.mjs';

baseline('review: model responses decode text and tool arguments and reject malformed or incomplete output', async () => {
  for (const mode of ['success', 'tool-call', 'markdown', 'prose', 'length-once', 'error', 'invalid-json',
    'malformed', 'tool-malformed', 'wrong-tool', 'length', 'reject-constrained', 'reject-all', 'unauthorized']) {
    const registry = reviewRegistry(mode);
    const response = await registry.streamSimple({}, { messages: [{ content: '{"phase":"critic"}' }] }, {}).result();
    const decode = () => validateCritic(parseReviewResponse(response));
    if (['success', 'tool-call', 'markdown', 'prose'].includes(mode)) assert.deepEqual(decode(), [], mode);
    else assert.throws(decode, undefined, mode);
  }
  const tool = argumentsValue => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'submit_review', arguments: argumentsValue }] });
  assert.deepEqual(parseReviewResponse(tool('{"concerns":[]}')), { concerns: [] });
  assert.throws(() => parseReviewResponse(tool('{broken')), { code: 'REVIEW_RESPONSE_INVALID' });
  assert.throws(() => parseReviewResponse(tool({ concerns: [], extra: 'x'.repeat(8193) })), { code: 'REVIEW_RESPONSE_INVALID' });
  assert.throws(() => parseReviewResponse({ stopReason: 'stop', content: [{ type: 'text', text: 'x'.repeat(8193) }] }), { code: 'REVIEW_RESPONSE_INVALID' });
  assert.throws(() => parseReviewResponse({ stopReason: 'aborted' }), { code: 'CANCELLED' });
  assert.throws(() => parseReviewResponse({ stopReason: 'length' }), { code: 'REVIEW_TOO_LARGE' });
});
