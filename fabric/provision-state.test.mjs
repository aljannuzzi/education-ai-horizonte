import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryState, eligibleCapacity, operationUrl } from './provision-state.mjs';

test('preflight eligibility excludes PPU, free trials, paused capacities and F1', () => {
  for (const sku of ['PP3', 'FT1', 'F1', 'P0', 'A4', undefined]) {
    assert.equal(eligibleCapacity({ sku, state: 'Active' }), false);
  }
  for (const sku of ['F2', 'F64', 'F1024', 'P1', 'P3']) {
    assert.equal(eligibleCapacity({ sku, state: 'Active' }), true);
    assert.equal(eligibleCapacity({ sku, state: 'Paused' }), false);
  }
});

test('an explicitly selected active trial can be attempted without accepting PPU or paused capacity', () => {
  assert.equal(eligibleCapacity({ sku: 'FT1', state: 'Active' }, { allowTrial: true }), true);
  assert.equal(eligibleCapacity({ sku: 'FT1', state: 'Paused' }, { allowTrial: true }), false);
  assert.equal(eligibleCapacity({ sku: 'PP3', state: 'Active' }, { allowTrial: true }), false);
  assert.equal(eligibleCapacity({ sku: 'FT1', state: 'Active' }, { allowTrial: 'true' }), false);
});

test('long-running operations use the documented Fabric operation ID without forwarding auth to another host', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const canonical = `https://api.fabric.microsoft.com/v1/operations/${id}`;
  assert.equal(operationUrl('https://alternate.example/operation', id), canonical);
  assert.equal(operationUrl(canonical), canonical);
  assert.throws(() => operationUrl('https://alternate.example/operation'), /UnsafeFabricOperation/);
  assert.throws(() => operationUrl(`${canonical}?token=invalid`), /UnsafeFabricOperation/);
});

test('recovery preserves resource IDs and unresolved operation URLs without mutation', () => {
  const previous = { provider: 'fabric', resources: { workspaceId: '11111111-1111-4111-8111-111111111111' },
    operations: [{ location: 'https://api.fabric.microsoft.com/v1/operations/22222222-2222-4222-8222-222222222222', status: 'Running' }] };
  const snapshot = structuredClone(previous);
  const recovered = recoveryState(previous);
  assert.deepEqual(recovered.resources, previous.resources);
  assert.deepEqual(recovered.operations, previous.operations);
  assert.equal(recovered.unresolved, true);
  recovered.resources.workspaceId = 'changed';
  assert.deepEqual(previous, snapshot);
  assert.equal(recoveryState({ ...previous, operations: [{ ...previous.operations[0], status: 'Succeeded' }] }).unresolved, false);
});

test('corrupt or unsafe recovery state is rejected', () => {
  for (const state of [null, {}, { provider: 'fabric', resources: { unknown: 'x' }, operations: [] },
    { provider: 'fabric', resources: {}, operations: [{ location: 'https://example.org', status: 'Running' }] }]) {
    assert.throws(() => recoveryState(state));
  }
});
