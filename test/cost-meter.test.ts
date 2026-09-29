import assert from 'node:assert/strict';
import test from 'node:test';
import { meteringEnabled, recordFabricOperation, recordModelUsage, withCostMeter } from '../server/cost-meter.js';
import type { ModelUsage, QuestionCostReceipt } from '../shared/cost-contracts.js';

const env = { COST_METERING_ENABLED: 'true' };
const usage: ModelUsage = {
  model: 'gpt-5.4-mini', outcome: 'succeeded', durationMs: 1, inputTokens: 100,
  cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, source: 'provider-usage',
};

test('metering is explicit and invalid configuration fails before operation without disclosing values', async () => {
  for (const value of [undefined, '', ' ', 'false']) assert.equal(meteringEnabled({ COST_METERING_ENABLED: value }), false);
  assert.equal(meteringEnabled(env), true);
  for (const value of ['TRUE', '1', 'secret-invalid']) {
    assert.throws(() => meteringEnabled({ COST_METERING_ENABLED: value }), error => {
      assert.doesNotMatch(String(error), /secret-invalid/);
      return true;
    });
  }
  for (const key of ['COST_CONTAINER_VCPU', 'COST_CONTAINER_MEMORY_GIB']) {
    for (const value of ['', ' ', '-1', '0', 'Infinity', 'NaN', '1garbage', '0x10', '1e309']) {
      let called = false;
      await assert.rejects(withCostMeter({ path: 'azure-mcp', env: { ...env, [key]: value } }, async () => { called = true; }));
      assert.equal(called, false);
    }
  }
});

test('disabled recording is a legitimate noop and results are unchanged', async () => {
  recordModelUsage(usage);
  recordFabricOperation();
  const output = { private: 'result' };
  assert.equal(await withCostMeter({
    path: 'azure-mcp', env: {}, onReceipt: () => assert.fail('disabled receipt'),
  }, async () => { recordModelUsage(usage); return output; }), output);
});

test('capture uses sanitized UUID, cloned metadata and wall-clock estimates, never inferred CU', async () => {
  let receipt!: QuestionCostReceipt;
  const original = { ...usage };
  const result = {};
  assert.equal(await withCostMeter({
    path: 'azure-mcp', scope: 'tool-call', questionId: 'private-prompt-not-an-id',
    env: { ...env, COST_CONTAINER_VCPU: '0.5', COST_CONTAINER_MEMORY_GIB: '1' },
    onReceipt: value => { receipt = value; },
  }, async () => {
    recordModelUsage(original);
    original.inputTokens = 900;
    recordFabricOperation();
    return result;
  }), result);
  assert.match(receipt.questionId, /^[a-f0-9-]{36}$/);
  assert.equal(receipt.capture.scope, 'tool-call');
  assert.equal(receipt.capture.origin, 'application-metered');
  assert.equal(receipt.capture.modelCalls[0]!.inputTokens, 100);
  assert.equal(receipt.capture.runtime.vcpu, 0.5);
  assert.equal(receipt.capture.runtime.memoryGiB, 1);
  assert.equal(receipt.capture.runtime.requests, 1);
  assert.equal(receipt.capture.runtime.basis, 'wall-clock-estimate');
  assert.ok(receipt.capture.runtime.durationMs! >= 0);
  assert.equal(receipt.capture.fabric.operations, 1);
  assert.equal(receipt.capture.fabric.cuSeconds, null);
  assert.equal(receipt.billingRecord, false);
  assert.doesNotMatch(JSON.stringify(receipt), /private-prompt/);
});

test('parallel captures isolate usage, and detached work cannot mutate an emitted receipt', async () => {
  const receipts: QuestionCostReceipt[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let late!: Promise<void>;
  await Promise.all([1, 2].map(async count => withCostMeter({
    path: 'azure-mcp', env, onReceipt: value => { receipts.push(value); },
  }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    recordModelUsage({ ...usage, inputTokens: count * 100 });
    for (let i = 0; i < count; i++) recordFabricOperation();
    if (count === 1) late = gate.then(() => { recordFabricOperation(); recordModelUsage(usage); });
  })));
  const snapshot = JSON.stringify(receipts);
  release();
  await late;
  assert.equal(JSON.stringify(receipts), snapshot);
  assert.equal(new Set(receipts.map(item => item.questionId)).size, 2);
  assert.deepEqual(receipts.map(item => item.capture.modelCalls.length), [1, 1]);
  assert.deepEqual(receipts.map(item => item.capture.fabric.operations).sort(), [1, 2]);
  assert.deepEqual(receipts.map(item => item.capture.modelCalls[0]!.inputTokens).sort(), [100, 200]);
});

test('failed tasks emit receipts and preserve original errors including thrown undefined', async () => {
  for (const failure of [new Error('private-operation-error'), undefined]) {
    let receipt!: QuestionCostReceipt;
    let caught = false;
    try {
      await withCostMeter({ path: 'azure-mcp', scope: 'task', env, onReceipt: value => { receipt = value; } },
        async () => { throw failure; });
    } catch (error) { caught = true; assert.equal(error, failure); }
    assert.equal(caught, true);
    assert.equal(receipt.capture.outcome, 'failed');
    assert.equal(receipt.capture.runtime.vcpu, null);
    assert.equal(receipt.capture.runtime.memoryGiB, null);
    assert.equal(receipt.capture.modelCalls.length, 0);
    assert.match(receipt.warnings.join(' '), /unknown/);
    assert.doesNotMatch(JSON.stringify(receipt), /private-operation-error/);
  }
});

test('nested captures fail explicitly without a second receipt', async () => {
  let emitted = 0;
  await assert.rejects(withCostMeter({ path: 'azure-mcp', env, onReceipt: () => { emitted++; } },
    () => withCostMeter({ path: 'local-guided', env, onReceipt: () => { emitted++; } }, async () => {})), /Nested cost capture/);
  assert.equal(emitted, 1);
});

test('receipt callback failures propagate; dual failures retain both identities', async () => {
  const callbackError = new Error('callback failed');
  const operationError = new Error('operation failed');
  const options = { path: 'azure-mcp' as const, env, onReceipt: () => { throw callbackError; } };
  await assert.rejects(withCostMeter(options, async () => 42), error => error === callbackError);
  await assert.rejects(withCostMeter(options, async () => { throw operationError; }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, callbackError]);
    return true;
  });
});

test('optional structured logs contain only metadata, never prompts, results or credentials', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: string) => { logs.push(value); });
  t.mock.method(console, 'log', () => assert.fail('Cost logging must not corrupt MCP STDIO output'));
  await withCostMeter({ path: 'azure-mcp', env }, async () => {});
  assert.equal(logs.length, 0);
  await withCostMeter({ path: 'azure-mcp', env: { ...env, COST_LOG_RECEIPTS: 'true' } }, async () => {
    recordModelUsage({ ...usage, requestId: 'unsafe header secret', prompt: 'SECRET_PROMPT', token: 'SECRET_TOKEN' } as ModelUsage);
    return 'SECRET_RESULT';
  });
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]!).event, 'horizonte.cost.receipt');
  assert.doesNotMatch(logs[0]!, /SECRET_|unsafe header/);
});
