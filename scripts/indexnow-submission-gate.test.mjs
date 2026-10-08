import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { submissionAllowed } from './indexnow-submission-gate.mjs';
const payload = { host: 'onceexec.com', key: 'e7446e8ebe87241334541be52e68eacd', keyLocation: 'https://onceexec.com/e7446e8ebe87241334541be52e68eacd.txt', urlList: ['https://onceexec.com/'] };
const manual = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', payload };
test('PR and main push cannot submit even a valid payload', () => {
  for (const eventName of ['pull_request', 'push', 'schedule', 'repository_dispatch', 'workflow_run', undefined]) assert.equal(submissionAllowed({ ...manual, eventName }), false);
});
test('explicit manual main dispatch can submit', () => assert.equal(submissionAllowed(manual), true));
test('missing or non-main ref blocks', () => { for (const ref of [undefined, 'refs/heads/feature', 'refs/tags/v1']) assert.equal(submissionAllowed({ ...manual, ref }), false); });
test('missing or malformed payload blocks', () => {
  for (const candidate of [undefined, {}, { ...payload, key: '' }, { ...payload, host: 'other' }, { ...payload, keyLocation: 'https://other/key' }, { ...payload, urlList: [] }, { ...payload, urlList: Array(10001).fill(payload.urlList[0]) }]) assert.equal(submissionAllowed({ ...manual, payload: candidate }), false);
});
test('noncanonical and credential-bearing URLs block', () => {
  for (const url of ['http://onceexec.com/', 'https://other/', 'https://secret@onceexec.com/', 'bad', null]) assert.equal(submissionAllowed({ ...manual, payload: { ...payload, urlList: [url] } }), false);
});
test('workflow has no automatic push and submission is guarded; validation has no secrets or POST', () => {
  const workflow = readFileSync(new URL('../.github/workflows/indexnow.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /^  (push|schedule|workflow_run|repository_dispatch|release):/m);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /submit:\s*\n\s*if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
  const validation = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  submit:'));
  assert.doesNotMatch(validation, /secrets\.|curl|POST|id-token: write/);
  assert.match(validation, /node --test scripts\/indexnow-submission-gate.test.mjs/);
  assert.match(workflow, /node scripts\/indexnow-submission-gate.mjs\s+HTTP_CODE=/);
});
