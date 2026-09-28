import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { BlockBlobClient } from '@azure/storage-blob';
import type { ActionDraft } from '../shared/contracts.js';
import {
  createMemoryStore, createStore, decideAction, editAction, emptyState, StoreError,
  type State,
} from '../server/store.js';

function draft(id = 'action-1'): ActionDraft {
  return {
    id, version: 1, title: 'Registro de aula', kind: 'diary-draft', target: 'Diário simulado',
    content: 'Conteúdo inicial', status: 'pending', createdAt: '2026-09-28T19:00:00.000Z',
    evidenceIds: ['evidence-1'], simulated: true,
  };
}

function seeded(): State {
  const state = emptyState();
  state.actions.push(draft());
  return state;
}

const hasError = (status: number, code?: string) => (error: unknown) =>
  error instanceof StoreError && error.status === status && (code === undefined || error.code === code);

test('empty stores have no enabled rules and do not share mutable state', async () => {
  const first = emptyState();
  first.rules.push({
    id: 'rule-1', kind: 'diary-pending', classId: 'class-1', name: 'Diário',
    description: 'Verificar pendências', enabled: false,
  });
  assert.deepEqual(emptyState().rules, []);
  assert.deepEqual(await createMemoryStore().read(), emptyState());
});

test('memory clones input, reads, mutation arguments and returned values', async () => {
  const initial = seeded();
  const store = createMemoryStore(initial);
  initial.actions[0]!.content = 'Alteração externa';
  const snapshot = await store.read();
  snapshot.actions[0]!.content = 'Outra alteração';
  let leaked: State | undefined;
  const action = await store.mutate((state) => {
    leaked = state;
    return state.actions[0]!;
  });
  action.content = 'Retorno modificado';
  leaked!.actions[0]!.content = 'Argumento modificado';
  assert.equal((await store.read()).actions[0]!.content, 'Conteúdo inicial');
});

test('memory transactions roll back thrown errors, invalid schemas and async callbacks', async () => {
  const store = createMemoryStore(seeded());
  await assert.rejects(store.mutate((state) => {
    state.actions.length = 0;
    throw new Error('abort');
  }), /abort/);
  await assert.rejects(store.mutate((state) => {
    state.actions[0]!.version = 0;
  }), hasError(500, 'INVALID_STATE'));
  await assert.rejects(store.mutate(async (state) => {
    state.actions.length = 0;
  }), hasError(400, 'ASYNC_MUTATION'));
  assert.deepEqual(await store.read(), seeded());
});

test('editing increments version; stale edit and approval never change state', async () => {
  const store = createMemoryStore(seeded());
  const edited = await editAction(store, 'action-1', 'Texto revisado', 1);
  assert.equal(edited.version, 2);
  assert.equal(edited.content, 'Texto revisado');
  const before = await store.read();
  await assert.rejects(editAction(store, 'action-1', 'Texto obsoleto', 1), hasError(409));
  await assert.rejects(decideAction(store, 'action-1', 1, 'approved'), hasError(409));
  assert.deepEqual(await store.read(), before);
});

test('approval commits exact version, outbox and audit atomically; replay is idempotent', async () => {
  const store = createMemoryStore(seeded());
  await editAction(store, 'action-1', 'Versão aprovada', 1);
  const approved = await decideAction(store, 'action-1', 2, 'approved');
  assert.equal(approved.version, 2);
  assert.equal(approved.status, 'approved');
  const before = await store.read();
  assert.deepEqual(before.outbox, [{
    actionId: 'action-1', version: 2, target: approved.target, content: 'Versão aprovada', at: approved.approvedAt,
  }]);
  assert.equal(before.audit.filter((event) => event.type === 'action.approved').length, 1);
  assert.deepEqual(await decideAction(store, 'action-1', 2, 'approved'), approved);
  await assert.rejects(decideAction(store, 'action-1', 1, 'approved'), hasError(409));
  await assert.rejects(decideAction(store, 'action-1', 2, 'rejected'), hasError(409));
  await assert.rejects(editAction(store, 'action-1', 'Mudança proibida', 2), hasError(409));
  assert.deepEqual(await store.read(), before);
});

test('rejection is replayable, never creates outbox, and cannot become approval', async () => {
  const store = createMemoryStore(seeded());
  const rejected = await decideAction(store, 'action-1', 1, 'rejected');
  const before = await store.read();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.approvedAt, undefined);
  assert.deepEqual(before.outbox, []);
  assert.equal(before.audit.length, 1);
  assert.deepEqual(await decideAction(store, 'action-1', 1, 'rejected'), rejected);
  await assert.rejects(decideAction(store, 'action-1', 1, 'approved'), hasError(409));
  await assert.rejects(editAction(store, 'action-1', 'Texto', 1), hasError(409));
  assert.deepEqual(await store.read(), before);
});

test('concurrent edits and opposite decisions have exactly one winner', async () => {
  const store = createMemoryStore(seeded());
  const edits = await Promise.allSettled([
    editAction(store, 'action-1', 'Primeiro', 1), editAction(store, 'action-1', 'Segundo', 1),
  ]);
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  const decisions = await Promise.allSettled([
    decideAction(store, 'action-1', 2, 'approved'), decideAction(store, 'action-1', 2, 'rejected'),
  ]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await store.read()).outbox.length, 1);
});

test('invalid requests and missing actions fail explicitly', async () => {
  const store = createMemoryStore(seeded());
  await assert.rejects(editAction(store, 'action-1', '  ', 1), hasError(400));
  await assert.rejects(decideAction(store, 'action-1', 1.5, 'approved'), hasError(400));
  await assert.rejects(decideAction(store, 'missing', 1, 'approved'), hasError(404));
  assert.deepEqual(await store.read(), seeded());
});

test('strict schema rejects unknown fields, duplicate IDs and inconsistent approvals', () => {
  const invalid: unknown[] = [
    { ...seeded(), extra: true },
    { ...seeded(), schemaVersion: 2 },
    { ...seeded(), actions: [draft(), draft()] },
    { ...seeded(), actions: [{ ...draft(), simulated: false }] },
    { ...seeded(), actions: [{ ...draft(), createdAt: 'yesterday' }] },
    { ...seeded(), actions: [{ ...draft(), status: 'approved' }] },
    { ...seeded(), outbox: [{ actionId: 'action-1', version: 1, target: 'x', content: 'x', at: draft().createdAt }] },
  ];
  for (const state of invalid) {
    assert.throws(() => createMemoryStore(state as State), hasError(500, 'INVALID_STATE'));
  }
});

test('bounded history preserves approvals; capacity overflow rolls back rather than losing data', async () => {
  const store = createMemoryStore(seeded());
  await decideAction(store, 'action-1', 1, 'approved');
  await store.mutate((state) => {
    state.dedupe.push('rule-1:2026-09-28');
    for (let index = 0; index < 600; index++) {
      state.audit.push({ id: `audit-${index}`, at: draft().createdAt, actor: 'test', type: 'test', detail: 'Teste' });
      state.runs.push({ id: `run-${index}`, at: draft().createdAt, source: 'manual', summary: 'Teste', actionIds: [] });
    }
  });
  const before = await store.read();
  assert.equal(before.audit.length, 500);
  assert.equal(before.runs.length, 100);
  assert.equal(before.outbox.length, 1);
  assert.equal(before.audit.filter((event) => event.type === 'action.approved').length, 1);
  await assert.rejects(store.mutate((state) => {
    for (let index = 0; index < 250; index++) state.actions.push(draft(`new-${index}`));
  }), hasError(507, 'STATE_CAPACITY'));
  await assert.rejects(store.mutate((state) => {
    state.actions = [];
    state.outbox = [];
  }), hasError(409, 'APPROVAL_IMMUTABLE'));
  await assert.rejects(store.mutate((state) => { state.dedupe = []; }), hasError(409, 'DEDUPE_IMMUTABLE'));
  await assert.rejects(store.mutate((state) => {
    state.audit = state.audit.filter((event) => event.type !== 'action.approved');
  }), hasError(409, 'APPROVAL_IMMUTABLE'));
  assert.deepEqual(await store.read(), before);
});

test('local persistence survives new store instances and serializes shared-path writers', async (t) => {
  const directory = resolve('test', `.store-test-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'nested', 'state.json');
  const store = createStore({ STATE_PATH: path });
  assert.equal(store.kind, 'local');
  assert.deepEqual(await store.read(), emptyState());
  await store.mutate((state) => { state.actions.push(draft()); });
  const restarted = createStore({ STATE_PATH: path });
  assert.deepEqual(await restarted.read(), seeded());
  const edits = await Promise.allSettled([
    editAction(store, 'action-1', 'Persistido', 1), editAction(restarted, 'action-1', 'Concorrente', 1),
  ]);
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  await decideAction(restarted, 'action-1', 2, 'approved');
  assert.deepEqual(await createStore({ STATE_PATH: path }).read(), await store.read());
  assert.equal((await store.read()).outbox.length, 1);
  assert.deepEqual(await readdir(resolve(directory, 'nested')), ['state.json']);
});

test('failed local transactions preserve previous bytes and release the writer lock', async (t) => {
  const directory = resolve('test', `.store-test-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'state.json');
  const store = createStore({ STATE_PATH: path });
  await store.mutate((state) => { state.actions.push(draft()); });
  const before = await readFile(path, 'utf8');
  await assert.rejects(store.mutate((state) => {
    state.actions[0]!.version = 0;
  }), hasError(500, 'INVALID_STATE'));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await readdir(directory), ['state.json']);
  await editAction(store, 'action-1', 'Transação seguinte', 1);
  assert.equal((await store.read()).actions[0]!.version, 2);
});

test('local corrupted JSON and schema are never overwritten', async (t) => {
  const directory = resolve('test', `.store-test-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'state.json');
  const store = createStore({ STATE_PATH: path });
  for (const raw of ['{corrupt', JSON.stringify({ ...emptyState(), schemaVersion: 42 }), '{}']) {
    await writeFile(path, raw);
    await assert.rejects(store.read(), hasError(500, 'INVALID_STATE'));
    await assert.rejects(store.mutate((state) => { state.actions.push(draft()); }), hasError(500, 'INVALID_STATE'));
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.deepEqual(await readdir(directory), ['state.json']);
  }
});

test('local writer lock fails closed without changing persisted data', async (t) => {
  const directory = resolve('test', `.store-test-${randomUUID()}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'state.json');
  await writeFile(path, JSON.stringify(seeded()));
  await writeFile(`${path}.lock`, 'another writer');
  const store = createStore({ STATE_PATH: path });
  await assert.rejects(editAction(store, 'action-1', 'Não persistir', 1), hasError(409));
  assert.deepEqual(await store.read(), seeded());
  assert.equal(await readFile(`${path}.lock`, 'utf8'), 'another writer');
});

test('incomplete Azure configuration never silently selects local storage', () => {
  assert.throws(() => createStore({ AZURE_STORAGE_ACCOUNT: 'demostorage' }), hasError(500, 'STORE_CONFIG'));
  assert.throws(() => createStore({ AZURE_STORAGE_CONTAINER: 'demo-state' }), hasError(500, 'STORE_CONFIG'));
  assert.throws(() => createStore({ AZURE_STORAGE_ACCOUNT: ' ' }), hasError(500, 'STORE_CONFIG'));
  assert.throws(() => createStore({ STATE_PATH: '' }), hasError(500, 'STORE_CONFIG'));
});

test('Azure uses conditional creation, rejects corruption/forbidden and reports CAS conflicts', async (t) => {
  const { Readable } = await import('node:stream');
  const store = createStore({ AZURE_STORAGE_ACCOUNT: 'demostorage', AZURE_STORAGE_CONTAINER: 'demo-state' });
  let failure: unknown = { statusCode: 404, code: 'BlobNotFound' };
  let body = JSON.stringify(emptyState());
  let uploadFailure: unknown;
  let uploads = 0;
  let conditions: unknown;
  t.mock.method(BlockBlobClient.prototype, 'download', async () => {
    if (failure) throw failure;
    return { etag: '"etag-1"', readableStreamBody: Readable.from([body]) };
  });
  t.mock.method(BlockBlobClient.prototype, 'upload', async (
    content: string, _length: number, options: { conditions: unknown },
  ) => {
    uploads++;
    conditions = options.conditions;
    if (uploadFailure) throw uploadFailure;
    body = content;
    return { etag: '"etag-2"' };
  });
  assert.equal(store.kind, 'azure-blob');
  assert.deepEqual(await store.read(), emptyState());
  await store.mutate((state) => { state.actions.push(draft()); });
  assert.deepEqual(conditions, { ifNoneMatch: '*' });
  failure = undefined;
  await editAction(store, 'action-1', 'Edição Azure', 1);
  assert.deepEqual(conditions, { ifMatch: '"etag-1"' });
  const before = body;
  for (const statusCode of [409, 412]) {
    uploadFailure = { statusCode };
    await assert.rejects(decideAction(store, 'action-1', 2, 'approved'), hasError(409));
    assert.equal(body, before);
  }
  uploadFailure = undefined;
  const previousUploads = uploads;
  body = '{invalid';
  await assert.rejects(store.read(), hasError(500, 'INVALID_STATE'));
  await assert.rejects(store.mutate(() => undefined), hasError(500, 'INVALID_STATE'));
  body = JSON.stringify({ ...emptyState(), schemaVersion: 42 });
  await assert.rejects(store.mutate(() => undefined), hasError(500, 'INVALID_STATE'));
  for (const error of [{ statusCode: 403 }, { statusCode: 500 }, { statusCode: 404, code: 'ContainerNotFound' }]) {
    failure = error;
    await assert.rejects(store.read(), hasError(503, 'STORE_UNAVAILABLE'));
    await assert.rejects(store.mutate(() => undefined), hasError(503, 'STORE_UNAVAILABLE'));
  }
  assert.equal(uploads, previousUploads);
});
