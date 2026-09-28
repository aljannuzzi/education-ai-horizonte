import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { WatchRule } from '../shared/contracts.js';
import { createRule, createRuleSchema, getAutopilot, runAutopilot, updateRule } from '../server/autopilot.js';
import { runJob } from '../server/job.js';
import { createMemoryStore, createStore, decideAction, emptyState, StoreError, type StateStore } from '../server/store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const time = new Date('2026-09-28T09:30:00.000Z');
const ruleInput = (kind: WatchRule['kind'] = 'week-prep', classId = 'class-7a', enabled = true) => ({
  name: 'Preparação sintética', kind, classId, enabled,
});
const errorCode = (code: string) => (error: unknown) => error instanceof StoreError && error.code === code;

test('rules are explicit opt-in, strictly validated, owned and persistently audited', async () => {
  const store = createMemoryStore();
  const initial = await getAutopilot(store, {});
  assert.deepEqual(initial.rules, []);
  assert.deepEqual(initial.drafts, []);
  assert.equal(initial.schedule, '06:30 em dias uteis (America/Sao_Paulo)');
  assert.equal((await getAutopilot(store, { AUTOPILOT_SCHEDULE: '  07:00 em dias uteis (America/Sao_Paulo)  ' })).schedule,
    '07:00 em dias uteis (America/Sao_Paulo)');
  for (const invalid of [
    {}, { ...ruleInput(), name: '' }, { ...ruleInput(), name: 'x'.repeat(121) },
    { ...ruleInput(), enabled: 'true' }, { ...ruleInput(), kind: 'external-send' },
    { ...ruleInput(), teacherId: 'teacher-other' }, { ...ruleInput(), url: 'https://example.org' },
  ]) {
    assert.equal(createRuleSchema.safeParse(invalid).success, false);
    await assert.rejects(createRule(store, invalid), errorCode('INVALID_RULE'));
  }
  const { enabled: _enabled, ...withoutConsent } = ruleInput();
  await assert.rejects(createRule(store, withoutConsent), errorCode('INVALID_RULE'));
  await assert.rejects(createRule(store, ruleInput('week-prep', 'unknown')), { code: 'CLASS_FORBIDDEN' });
  assert.deepEqual(await store.read(), emptyState());
  const rule = await createRule(store, ruleInput('week-prep', 'class-7a', false));
  assert.equal(rule.enabled, false);
  assert.equal((await store.read()).audit[0]!.type, 'autopilot.rule.created');
  assert.equal((await updateRule(store, rule.id, { enabled: true })).enabled, true);
  const beforeReplay = await store.read();
  await updateRule(store, rule.id, { enabled: true });
  assert.deepEqual(await store.read(), beforeReplay);
  await assert.rejects(updateRule(store, 'unknown', { enabled: true }), errorCode('RULE_NOT_FOUND'));
  await assert.rejects(updateRule(store, rule.id, { enabled: false, classId: 'class-7b' } as { enabled: boolean }),
    errorCode('INVALID_RULE'));
  assert.equal((await getAutopilot(store)).rules[0]!.enabled, true);
});

test('only enabled stored rules run; all three kinds use deterministic owned semantic drafts without writes', async t => {
  const store = createMemoryStore();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network calls forbidden in deterministic preparation'); });
  await runAutopilot(store, 'manual', time);
  assert.deepEqual((await store.read()).actions, []);
  const disabled = await createRule(store, ruleInput('week-prep', 'class-7b', false));
  await createRule(store, ruleInput('diary-pending'));
  await createRule(store, ruleInput('learning-gap'));
  await createRule(store, ruleInput('week-prep'));
  const result = await runAutopilot(store, 'manual', time);
  const state = await store.read();
  assert.equal(state.rules.find(rule => rule.id === disabled.id)!.lastRunAt, undefined);
  assert.equal(state.dedupe.length, 3);
  assert.equal(state.actions.length, 5);
  assert.deepEqual(state.outbox, []);
  assert.equal(result.drafts.length, 5);
  assert.ok(result.drafts.every(draft => draft.status === 'pending' && draft.simulated && draft.createdAt === time.toISOString()));
  assert.ok(result.drafts.every(draft => draft.evidenceIds.length && draft.evidenceIds.every(id => id.startsWith('ev:class-7a:'))));
  assert.equal(result.drafts.filter(draft => draft.kind === 'diary-draft').length, 1);
  assert.equal(result.drafts.filter(draft => draft.kind === 'support-ticket').length, 2);
  assert.ok(result.drafts.some(draft => draft.content.includes('tiras do mesmo inteiro')));
  assert.ok(result.drafts.some(draft => draft.content.includes('Kit de envelopes da água')));
  assert.equal(state.audit.filter(event => event.type === 'autopilot.draft.prepared').length, 5);
  assert.deepEqual(state.runs.at(-1)!.actionIds, state.actions.map(action => action.id));
  assert.equal(state.runs.at(-1)!.source, 'manual');
});

test('daily dedupe uses the schedule timezone, not UTC, and is shared by manual and schedule sources', async () => {
  const store = createMemoryStore();
  const rule = await createRule(store, ruleInput('learning-gap'));
  const first = new Date('2026-09-29T02:59:59.999Z');
  await runAutopilot(store, 'manual', first);
  assert.deepEqual((await store.read()).dedupe, [`autopilot:${rule.id}:2026-09-28`]);
  await runAutopilot(store, 'schedule', new Date('2026-09-28T23:59:59.999Z'));
  assert.equal((await store.read()).actions.length, 1);
  await runAutopilot(store, 'schedule', new Date('2026-09-29T03:00:00.000Z'));
  const state = await store.read();
  assert.equal(state.actions.length, 2);
  assert.deepEqual(state.dedupe, [`autopilot:${rule.id}:2026-09-28`, `autopilot:${rule.id}:2026-09-29`]);
  assert.equal(state.rules[0]!.lastRunAt, '2026-09-29T03:00:00.000Z');
  assert.equal(state.runs.at(-1)!.source, 'schedule');
  assert.deepEqual(state.outbox, []);
});

test('concurrent runs prepare each rule/day exactly once and never duplicate outbox', async () => {
  const store = createMemoryStore();
  await createRule(store, ruleInput('week-prep', 'class-7a'));
  await createRule(store, ruleInput('learning-gap', 'class-7b'));
  await Promise.all(Array.from({ length: 12 }, (_, index) => runAutopilot(store, index % 2 ? 'manual' : 'schedule', time)));
  const state = await store.read();
  assert.equal(state.actions.length, 3);
  assert.equal(state.dedupe.length, 2);
  assert.equal(state.runs.flatMap(run => run.actionIds).length, 3);
  assert.equal(new Set(state.actions.map(action => action.id)).size, 3);
  assert.equal(state.audit.filter(event => event.type === 'autopilot.draft.prepared').length, 3);
  assert.deepEqual(state.outbox, []);
  const b = state.actions.filter(action => action.evidenceIds.every(id => id.startsWith('ev:class-7b:')));
  assert.equal(b.length, 1);
  assert.ok(b[0]!.content.includes('reta'));
});

test('disabled rules stay idle, toggling cannot bypass daily dedupe and decisions are not repeated', async () => {
  const store = createMemoryStore();
  const rule = await createRule(store, ruleInput('learning-gap', 'class-7a', false));
  await runAutopilot(store, 'schedule', time);
  assert.deepEqual((await store.read()).dedupe, []);
  await updateRule(store, rule.id, { enabled: true });
  await runAutopilot(store, 'schedule', time);
  const action = (await store.read()).actions[0]!;
  await decideAction(store, action.id, 1, 'approved');
  await updateRule(store, rule.id, { enabled: false });
  await updateRule(store, rule.id, { enabled: true });
  await runAutopilot(store, 'manual', time);
  const state = await store.read();
  assert.equal(state.actions.length, 1);
  assert.equal(state.outbox.length, 1);
  assert.equal((await getAutopilot(store)).drafts.length, 0);
  await updateRule(store, rule.id, { enabled: false });
  await runAutopilot(store, 'schedule', new Date('2026-09-29T09:30:00.000Z'));
  assert.equal((await store.read()).actions.length, 1);
});

test('ownership is revalidated at execution and failure rolls back drafts, audit, run and dedupe atomically', async () => {
  const store = createMemoryStore();
  await createRule(store, ruleInput());
  await store.mutate(state => {
    state.rules.push({
      id: 'foreign-rule', ...ruleInput('learning-gap', 'class-outside'),
      description: 'Regra sintética fora do vínculo',
    });
  });
  const before = await store.read();
  await assert.rejects(runAutopilot(store, 'schedule', time), { code: 'CLASS_FORBIDDEN' });
  assert.deepEqual(await store.read(), before);
  await assert.rejects(updateRule(store, 'foreign-rule', { enabled: true }), { code: 'CLASS_FORBIDDEN' });
  await assert.rejects(getAutopilot(store), { code: 'CLASS_FORBIDDEN' });
  assert.deepEqual(await store.read(), before);
  await store.mutate(state => { state.rules.find(rule => rule.id === 'foreign-rule')!.enabled = false; });
  const disabledBefore = await store.read();
  await assert.rejects(runAutopilot(store, 'schedule', time), { code: 'CLASS_FORBIDDEN' });
  assert.deepEqual(await store.read(), disabledBefore);
});

test('invalid inputs and failed storage propagate explicit errors without success-shaped fallback', async () => {
  const store = createMemoryStore();
  await assert.rejects(runAutopilot(store, 'manual', new Date('invalid')), errorCode('INVALID_RUN'));
  await assert.rejects(runAutopilot(store, 'external' as 'manual', time), errorCode('INVALID_RUN'));
  assert.deepEqual(await store.read(), emptyState());
  const failedStore: StateStore = {
    kind: 'local',
    read: async () => { throw new StoreError(503, 'STORE_UNAVAILABLE', 'Injected read failure'); },
    mutate: async () => { throw new StoreError(409, 'CONFLICT', 'Injected transaction conflict'); },
  };
  await assert.rejects(getAutopilot(failedStore), errorCode('STORE_UNAVAILABLE'));
  await assert.rejects(createRule(failedStore, ruleInput()), errorCode('CONFLICT'));
  await assert.rejects(runAutopilot(failedStore, 'schedule', time), errorCode('CONFLICT'));
  await assert.rejects(runJob({ store: failedStore, now: time }), errorCode('CONFLICT'));
});

test('state capacity failure cannot persist a partial rule execution or consume its dedupe key', async () => {
  const store = createMemoryStore();
  await createRule(store, ruleInput('learning-gap'));
  await runAutopilot(store, 'manual', time);
  await store.mutate(state => {
    const template = state.actions[0]!;
    while (state.actions.length < 250) state.actions.push({ ...template, id: randomUUID() });
  });
  const before = await store.read();
  await assert.rejects(runAutopilot(store, 'schedule', new Date('2026-09-29T09:30:00.000Z')), errorCode('STATE_CAPACITY'));
  assert.deepEqual(await store.read(), before);
});

test('pending drafts remain visible after bounded run history is pruned', async () => {
  const store = createMemoryStore();
  await createRule(store, ruleInput('learning-gap'));
  await runAutopilot(store, 'manual', time);
  const draftId = (await store.read()).actions[0]!.id;
  await store.mutate(state => {
    state.runs.length = 0;
    state.audit = state.audit.filter(event => event.type !== 'autopilot.draft.prepared');
  });
  assert.equal((await getAutopilot(store)).drafts[0]!.id, draftId);
});

test('scheduled helper persists source, opt-in rules and dedupe across fresh stores and concurrent writers', async () => {
  const dir = join(root, '.runtime', `autopilot-test-${randomUUID()}`);
  const env = { STATE_PATH: join(dir, 'state.json') };
  await mkdir(dir, { recursive: true });
  try {
    const first = createStore(env);
    await createRule(first, ruleInput('week-prep', 'class-7b'));
    await Promise.all([
      runJob({ env, now: time }),
      runJob({ env, now: time }),
      runAutopilot(createStore(env), 'manual', time),
    ]);
    const persisted = await createStore(env).read();
    assert.equal(persisted.actions.length, 2);
    assert.equal(persisted.dedupe.length, 1);
    assert.equal(persisted.runs.filter(run => run.source === 'schedule').length, 2);
    assert.ok(persisted.actions.every(action => action.evidenceIds.every(id => id.startsWith('ev:class-7b:'))));
    assert.deepEqual(persisted.outbox, []);
    assert.equal(JSON.parse(await readFile(env.STATE_PATH, 'utf8')).dedupe.length, 1);
    const fresh = await runJob({ env, now: time });
    assert.equal(fresh.drafts.length, 2);
    assert.equal(fresh.runs.at(-1)!.actionIds.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('job import is inert; entry failure exits nonzero with sanitized logs and preserves corrupt state', async () => {
  const dir = join(root, '.runtime', `job-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'state.json');
  const secret = 'SYNTHETIC_SECRET_MUST_NOT_BE_LOGGED';
  const env: NodeJS.ProcessEnv = { ...process.env, STATE_PATH: path, DEMO_ACCESS_KEY: secret };
  delete env.AZURE_STORAGE_ACCOUNT;
  delete env.AZURE_STORAGE_CONTAINER;
  try {
    const imported = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', "await import('./server/job.ts');"], {
      cwd: root, env, encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await writeFile(path, `{${secret}`);
    const failed = spawnSync(process.execPath, ['--import', 'tsx', 'server\\job.ts'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes('Falha na preparação agendada'));
    assert.ok(!(failed.stdout + failed.stderr).includes(secret));
    assert.ok(!failed.stderr.includes(path));
    assert.equal(await readFile(path, 'utf8'), `{${secret}`);
    await rm(path);
    const succeeded = spawnSync(process.execPath, ['--import', 'tsx', 'server\\job.ts'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(succeeded.status, 0, succeeded.stderr);
    const state = await createStore({ STATE_PATH: path }).read();
    assert.equal(state.runs[0]!.source, 'schedule');
    assert.deepEqual(state.actions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
