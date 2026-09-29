import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createApp, type Reasoner } from '../server/app.js';
import { classes } from '../server/semantic.js';
import { createMemoryStore, type StateStore } from '../server/store.js';
import type { SessionInfo, Workspace } from '../shared/contracts.js';
import { createEmptyCapture } from '../shared/cost-engine.js';
import { recordModelUsage } from '../server/cost-meter.js';
import type { ModelUsage, QuestionCostReceipt } from '../shared/cost-contracts.js';

const ACCESS_KEY = 'http-test-only-access-key-not-a-real-credential';
const MCP_KEY = 'http-test-only-separate-mcp-key-not-a-real-credential';
const noModel: Reasoner = {
  configured: false,
  async route() { throw new Error('An unconfigured model must never be called'); },
};
const classroom = classes[0]!.id;
const chat = { message: 'Prepare uma aula sobre água', classId: classroom, mode: 'home', guided: true };
const costUsage: ModelUsage = {
  model: 'gpt-5.4-mini', source: 'provider-usage', outcome: 'succeeded', durationMs: 10,
  inputTokens: 1000, cachedInputTokens: 200, outputTokens: 400, reasoningOutputTokens: 25,
};

test('cost endpoints require authentication and CSRF and never attest operator captures', async t => {
  const h = await harness(t, { env: { COST_METERING_ENABLED: 'true' } });
  assert.equal((await h.send('/api/costs/config')).status, 401);
  for (const path of ['/api/costs/estimate', '/api/costs/probe']) {
    assert.equal((await h.send(path, 'POST', {})).status, 401);
  }
  await h.login();
  const capture = createEmptyCapture('cowork-fabric-iq', 'operator-question');
  capture.origin = 'application-metered';
  assert.equal((await h.send('/api/costs/estimate', 'POST', { capture }, { 'x-csrf-token': null })).status, 403);
  assert.equal((await h.send('/api/costs/probe', 'POST', {}, { origin: 'https://example.invalid' })).status, 403);
  const response = await h.send('/api/costs/estimate', 'POST', { capture });
  assert.equal(response.status, 200);
  const receipt = await response.json() as QuestionCostReceipt;
  assert.equal(receipt.capture.origin, 'operator-entered');
  assert.equal(receipt.billingRecord, false);
  assert.equal(receipt.totals.knownSubtotal, null);
  assert.equal((await h.send('/api/costs/estimate', 'POST', { capture: { ...capture, prompt: 'private input' } })).status, 400);
  assert.equal((await h.send('/api/costs/estimate', 'POST', { capture, pricing: {} })).status, 400);
  assert.equal((await (await h.send('/api/costs/config')).json()).enabled, true);
});

test('chat attaches metered quantities without prompt content and includes header correlation', async t => {
  const h = await harness(t, {
    env: { COST_METERING_ENABLED: 'true' },
    model: { configured: true, async route() {
      recordModelUsage(costUsage);
      return { intent: 'lesson', plan: 'PRIVATE_MODEL_PLAN' };
    } },
  });
  await h.login();
  const response = await h.send('/api/chat', 'POST', { ...chat, guided: false, message: 'PRIVATE_QUESTION' });
  assert.equal(response.status, 200, await response.clone().text());
  const { costReceipt: receipt } = await response.json() as Workspace;
  assert.ok(receipt);
  assert.equal(response.headers.get('x-question-id'), receipt.questionId);
  assert.equal(receipt.capture.scope, 'question');
  assert.equal(receipt.capture.outcome, 'succeeded');
  assert.deepEqual(receipt.capture.modelCalls, [costUsage]);
  assert.ok(Math.abs(receipt.totals.knownSubtotal! - 0.002415) < 1e-12);
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_|http-test-only|csrfToken/);
});

test('model and persistence failures retain measured consumption without disclosing error detail', async t => {
  for (const failure of ['model', 'store']) {
    const store = createMemoryStore();
    if (failure === 'store') store.mutate = async () => { throw new Error('PRIVATE_STORE_FAILURE'); };
    const h = await harness(t, {
      store, env: { COST_METERING_ENABLED: 'true' },
      model: { configured: true, async route() {
        recordModelUsage({ ...costUsage, outcome: failure === 'model' ? 'failed' : 'succeeded' });
        if (failure === 'model') throw new Error('PRIVATE_MODEL_FAILURE');
        return { intent: 'lesson', plan: 'private plan' };
      } },
    });
    await h.login();
    const response = await h.send('/api/chat', 'POST', { ...chat, guided: false });
    assert.equal(response.status, failure === 'model' ? 502 : 500);
    const body = await response.json();
    assert.equal(body.costReceipt.capture.outcome, 'failed');
    assert.equal(body.costReceipt.capture.modelCalls[0].inputTokens, 1000);
    assert.ok(body.costReceipt.totals.knownSubtotal > 0);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_/);
  }
});

test('cost probe is opt-in, fixed-input, bounded and independent of school persistence', async t => {
  let calls = 0;
  const store = createMemoryStore();
  store.mutate = async () => { throw new Error('probe must not persist drafts'); };
  const model: Reasoner = { configured: true, async route(input) {
    calls++;
    assert.equal(input.classId, 'class-7a');
    assert.match(input.message, /sintética/);
    recordModelUsage(costUsage);
    return { intent: 'diary', plan: 'not returned' };
  } };
  const disabled = await harness(t, { model, store });
  await disabled.login();
  assert.equal((await disabled.send('/api/costs/probe', 'POST', {})).status, 503);
  assert.equal(calls, 0);
  const h = await harness(t, { model, store, env: { COST_METERING_ENABLED: 'true' } });
  await h.login();
  assert.equal((await h.send('/api/costs/probe', 'POST', { prompt: 'not accepted' })).status, 400);
  const response = await h.send('/api/costs/probe', 'POST', {});
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['costReceipt', 'diagnosticOnly']);
  assert.equal(body.diagnosticOnly, true);
  assert.equal(body.costReceipt.capture.modelCalls.length, 1);
  assert.equal(calls, 1);
});

async function harness(t: TestContext, options: {
  model?: Reasoner; env?: NodeJS.ProcessEnv; store?: StateStore;
} = {}) {
  const store = options.store ?? createMemoryStore();
  const app = createApp({
    env: { NODE_ENV: 'test', DEMO_ACCESS_KEY: ACCESS_KEY, MCP_ACCESS_KEY: MCP_KEY, ...options.env },
    store, model: options.model ?? noModel,
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  let csrf = '';
  const send = async (
    path: string, method = 'GET', body?: unknown, overrides: Record<string, string | null> = {},
  ) => {
    const headers = new Headers({ accept: 'application/json' });
    if (cookie) headers.set('cookie', cookie);
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set('origin', options.env?.PUBLIC_ORIGIN ?? origin);
      headers.set('x-csrf-token', csrf);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const session = async () => {
    const response = await send('/api/session');
    assert.equal(response.status, 200);
    const info = await response.json() as SessionInfo;
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    csrf = info.csrfToken!;
    return { response, info };
  };
  const login = async () => {
    await session();
    const response = await send('/api/login', 'POST', { accessKey: ACCESS_KEY });
    assert.equal(response.status, 200, await response.clone().text());
    const info = await response.json() as SessionInfo;
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    csrf = info.csrfToken!;
    return { response, info };
  };
  return { app, store, origin, send, session, login, credentials: () => ({ cookie, csrf }) };
}

async function error(response: Response, status: number, code?: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  if (code) assert.equal(body.error.code, code);
  return body;
}

test('configuration fails closed and importing index never opens a listener', async () => {
  for (const key of [undefined, '', ' \n ']) {
    assert.throws(() => createApp({ env: { DEMO_ACCESS_KEY: key }, store: createMemoryStore(), model: noModel }), /DEMO_ACCESS_KEY/);
  }
  for (const origin of [undefined, 'http://school.example', 'https://school.example/path', 'https://user:pass@school.example', 'null']) {
    assert.throws(() => createApp({
      env: { NODE_ENV: 'production', DEMO_ACCESS_KEY: ACCESS_KEY, PUBLIC_ORIGIN: origin },
      store: createMemoryStore(), model: noModel,
    }), /PUBLIC_ORIGIN/);
  }
  const entry = await import('../server/index.js');
  assert.equal(entry.createApp, createApp);
});

test('minimal health and anonymous session reveal no private dataset or secrets', async t => {
  const h = await harness(t);
  const health = await h.send('/healthz');
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('set-cookie'), null);
  const { response, info } = await h.session();
  assert.deepEqual(Object.keys(info).sort(), ['authenticated', 'csrfToken']);
  assert.equal(info.authenticated, false);
  assert.match(info.csrfToken!, /^[a-f0-9]{64}$/);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=1800/);
  for (const path of ['/api/bootstrap', '/api/actions', '/api/autopilot', '/api/audit']) {
    const response = await h.send(path);
    const body = await error(response, 401, 'AUTH_REQUIRED');
    assert.doesNotMatch(JSON.stringify(body), /teacher|classroom|csrfToken|stack/);
  }
  for (const path of ['/api/chat', '/api/autopilot/run', '/api/actions/unknown/approve']) {
    await error(await h.send(path, 'POST', {}), 401, 'AUTH_REQUIRED');
  }
});

test('login requires pre-session, exact origin and CSRF; rotates session and compares keys safely', async t => {
  const h = await harness(t);
  await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY }), 403, 'CSRF_INVALID');
  const initial = await h.session();
  const before = h.credentials();
  for (const overrides of [
    { origin: null }, { origin: 'null' }, { origin: 'https://attacker.example' },
    { origin: `${h.origin}.attacker.example` },
  ]) {
    await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY }, overrides), 403, 'ORIGIN_FORBIDDEN');
  }
  await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY }, { 'x-csrf-token': null }), 403, 'CSRF_INVALID');
  await error(await h.send('/api/login', 'POST', { accessKey: 'x' }), 401, 'LOGIN_FAILED');
  await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY.slice(0, -1) }), 401, 'LOGIN_FAILED');
  const { response, info } = await h.login();
  assert.equal(info.authenticated, true);
  assert.notEqual(info.csrfToken, initial.info.csrfToken);
  assert.notEqual(h.credentials().cookie, before.cookie);
  assert.match(response.headers.get('set-cookie')!, /Max-Age=28800/);
  const session = await h.send('/api/session');
  assert.equal(session.headers.get('set-cookie'), null);
  assert.equal((await session.json()).authenticated, true);
  await error(await h.send('/api/chat', 'POST', chat, { 'x-csrf-token': before.csrf }), 403, 'CSRF_INVALID');
  assert.equal((await h.send('/api/bootstrap')).status, 200);
});

test('production cookies are Secure and configured origin does not trust forwarded host', async t => {
  const h = await harness(t, { env: { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://school.example' } });
  const { response } = await h.login();
  assert.match(response.headers.get('set-cookie')!, /;\s*Secure/);
  assert.match(response.headers.get('strict-transport-security')!, /max-age=/);
  await error(await h.send('/api/chat', 'POST', chat, {
    origin: h.origin, 'x-forwarded-host': 'school.example', 'x-forwarded-proto': 'https',
  }), 403, 'ORIGIN_FORBIDDEN');
  assert.equal((await h.send('/api/chat', 'POST', chat)).status, 200);
});

test('signed cookies reject tampering, duplicates, expiry and logout replay', async t => {
  const h = await harness(t);
  await h.login();
  const original = h.credentials();
  const [name, value] = original.cookie.split('=');
  const [payload, signature] = value!.split('.');
  const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  assert.ok(decoded.exp > decoded.iat && decoded.exp - decoded.iat <= 8 * 60 * 60);
  const modified = Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 1000000 })).toString('base64url');
  for (const cookie of [
    `${name}=${modified}.${signature}`, `${name}=garbage`,
    `${name}=${payload}.${signature!.slice(0, -1)}!`, `${original.cookie}; ${original.cookie}`,
    `${name}=${'x'.repeat(1100)}`,
  ]) {
    await error(await h.send('/api/bootstrap', 'GET', undefined, { cookie }), 401, 'AUTH_REQUIRED');
  }
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 9 * 60 * 60 * 1000);
  await error(await h.send('/api/bootstrap'), 401, 'AUTH_REQUIRED');
  t.mock.restoreAll();
  await error(await h.send('/api/logout', 'POST', {}, { origin: null }), 403);
  await error(await h.send('/api/logout', 'POST', {}, { 'x-csrf-token': null }), 403);
  const logout = await h.send('/api/logout', 'POST', {});
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  await error(await h.send('/api/bootstrap', 'GET', undefined, { cookie: original.cookie }), 401);
});

test('every mutation validates CSRF and origin before work; cross-session CSRF is rejected', async t => {
  const h = await harness(t);
  await h.login();
  for (const [path, method, body] of [
    ['/api/chat', 'POST', chat], ['/api/logout', 'POST', {}],
    ['/api/actions/unknown', 'PATCH', { version: 1, content: 'x' }],
    ['/api/actions/unknown/approve', 'POST', { version: 1 }],
    ['/api/actions/unknown/reject', 'POST', { version: 1 }],
    ['/api/autopilot/rules', 'POST', { name: 'Regra', kind: 'week-prep', classId: classroom, enabled: true }],
    ['/api/autopilot/rules/unknown', 'PATCH', { enabled: true }], ['/api/autopilot/run', 'POST', {}],
  ] as const) {
    await error(await h.send(path, method, body, { origin: 'https://attacker.example' }), 403, 'ORIGIN_FORBIDDEN');
    await error(await h.send(path, method, body, { 'x-csrf-token': null }), 403, 'CSRF_INVALID');
  }
  const other = await fetch(`${h.origin}/api/session`);
  const foreign = await other.json();
  await error(await h.send('/api/chat', 'POST', chat, { 'x-csrf-token': foreign.csrfToken }), 403);
  assert.equal((await h.store.read()).audit.length, 0);
});

test('bounded JSON parser and strict schemas never echo malicious input', async t => {
  const h = await harness(t);
  await h.login();
  const secret = 'DO_NOT_ECHO_PRIVATE_TEXT';
  for (const body of [
    { ...chat, teacherId: secret }, { ...chat, url: 'https://attacker.example' },
    { ...chat, mode: secret }, { ...chat, guided: 'true' },
    { ...chat, message: 'x'.repeat(8001) }, { ...chat, message: '  ' },
    [], null,
  ]) {
    const response = await h.send('/api/chat', 'POST', body);
    const result = await error(response, 400, 'INVALID_BODY');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  await error(await h.send('/api/logout', 'POST', { unexpected: secret }), 400);
  await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY, teacherId: secret }), 400);
  await error(await h.send('/api/actions/x/approve', 'POST', { version: 1, content: secret }), 400);
  await error(await h.send('/api/actions/x', 'PATCH', { version: '1', content: secret }), 400);
  await error(await h.send('/api/autopilot/run', 'POST', { source: 'schedule' }), 400);
  await error(await h.send('/api/chat', 'POST', chat, { 'content-type': 'text/plain' }), 415);
  await error(await h.send('/api/chat', 'POST', chat, { 'content-encoding': 'gzip' }), 415);
  const credentials = h.credentials();
  for (const body of ['{broken JSON with secret', '{"message":"' + 'x'.repeat(140_000) + '"}']) {
    const response = await fetch(`${h.origin}/api/chat`, {
      method: 'POST', headers: {
        cookie: credentials.cookie, origin: h.origin, 'x-csrf-token': credentials.csrf,
        'content-type': 'application/json',
      }, body,
    });
    await error(response, body.length > 140_000 ? 413 : 400);
  }
  assert.deepEqual((await h.store.read()).actions, []);
});

test('ownership is checked before calling the model; no client can inject routing or tool parameters', async t => {
  let calls = 0;
  const h = await harness(t, { model: {
    configured: true, async route() { calls++; return { intent: 'lesson', plan: '' }; },
  } });
  await h.login();
  await error(await h.send('/api/chat', 'POST', { ...chat, classId: 'not-owned', guided: false }), 403, 'CLASS_FORBIDDEN');
  for (const extra of [{ intent: 'diary' }, { toolSpec: {} }, { model: 'guided' }, { plan: 'run code' }]) {
    await error(await h.send('/api/chat', 'POST', { ...chat, ...extra, guided: false }), 400);
  }
  assert.equal(calls, 0);
  const state = await h.store.read();
  assert.equal(state.actions.length, 0);
  assert.equal(state.audit.length, 0);
});

test('bootstrap explicitly requires guided mode when the model is not configured', async t => {
  const h = await harness(t);
  await h.login();
  const bootstrap = await (await h.send('/api/bootstrap')).json();
  assert.equal(bootstrap.capabilities.model, 'guided');
  assert.ok(bootstrap.capabilities.notices.some((notice: string) => notice.includes('guided: true')));
  await error(await h.send('/api/chat', 'POST', { ...chat, guided: false }), 503, 'MODEL_NOT_CONFIGURED');
  const { guided: _guided, ...withoutGuided } = chat;
  await error(await h.send('/api/chat', 'POST', withoutGuided), 503, 'MODEL_NOT_CONFIGURED');
  assert.equal((await h.store.read()).audit.length, 0);
  const response = await h.send('/api/chat', 'POST', chat);
  assert.equal(response.status, 200);
  const workspace = await response.json();
  assert.equal(workspace.model, 'guided');
  assert.equal(workspace.intent, 'lesson');
  assert.ok(workspace.actions.length > 0);
  assert.deepEqual((await h.store.read()).actions, workspace.actions);
});

test('guided intention follows the message, never the UI mode, and supports both classes', async t => {
  const h = await harness(t);
  await h.login();
  assert.ok(classes.length >= 2);
  const workspaces: Workspace[] = [];
  for (const current of classes.slice(0, 2)) {
    const response = await h.send('/api/chat', 'POST', {
      ...chat, classId: current.id, mode: 'code', message: 'Verifique as pendências do diário',
    });
    assert.equal(response.status, 200);
    const workspace = await response.json() as Workspace;
    assert.equal(workspace.mode, 'code');
    assert.equal(workspace.intent, 'diary');
    assert.ok(workspace.widgets.every(widget => widget.type !== 'tool'));
    assert.ok(workspace.evidence.every(evidence => evidence.id.startsWith(`ev:${current.id}:`)));
    workspaces.push(workspace);
  }
  assert.notDeepEqual(workspaces[0]!.widgets, workspaces[1]!.widgets);
  const tool = await h.send('/api/chat', 'POST', {
    ...chat, mode: 'home', message: 'Configure a ferramenta fraction-lab',
  });
  assert.equal(tool.status, 200);
  const workspace = await tool.json();
  assert.equal(workspace.intent, 'tool');
  assert.equal(workspace.mode, 'home');
  assert.equal(workspace.widgets.find((widget: { type: string }) => widget.type === 'tool').tool.kind, 'fraction-lab');
  await error(await h.send('/api/chat', 'POST', {
    ...chat, message: 'Configure a ferramenta fraction-lab 1/0',
  }), 400, 'INVALID_BODY');
});

test('live model routing is used as supplied; no plan text or private request is persisted', async t => {
  const privateText = 'PRIVATE_MODEL_PLAN_NOT_FOR_CLIENT';
  const requests: unknown[] = [];
  const h = await harness(t, { model: {
    configured: true, async route(request) {
      requests.push(request);
      return { intent: 'metrics', plan: privateText };
    },
  } });
  await h.login();
  const response = await h.send('/api/chat', 'POST', { ...chat, mode: 'code', guided: false });
  assert.equal(response.status, 200);
  const workspace = await response.json() as Workspace;
  assert.equal(requests.length, 1);
  assert.equal(workspace.intent, 'metrics');
  assert.equal(workspace.mode, 'code');
  assert.equal(workspace.model, 'azure-openai');
  assert.match(workspace.modelNotice, /chamada real ao Azure OpenAI/);
  assert.ok(!JSON.stringify(workspace).includes(privateText));
  const state = await h.store.read();
  assert.equal(state.audit.length, 1);
  assert.ok(!JSON.stringify(state).includes(privateText));
  assert.ok(!JSON.stringify(state.audit).includes(chat.message));
  assert.equal((await (await h.send('/api/bootstrap')).json()).capabilities.model, 'azure-openai');
});

test('model failures and malformed live routing are explicit 502 with no drafts or audit', async t => {
  const secret = 'MODEL_TOKEN_cookie=DO_NOT_LEAK';
  for (const route of [
    async () => { throw new Error(secret); },
    async () => ({ intent: 'tool', plan: '' }),
    async () => ({ intent: 'not-an-intent', plan: secret }),
    async () => ({ intent: 'lesson', plan: 'x'.repeat(16001) }),
    async () => ({ intent: 'tool', plan: '', toolSpec: { kind: 'execute-code', script: secret } }),
  ]) {
    const h = await harness(t, { model: { configured: true, route } as Reasoner });
    await h.login();
    const response = await h.send('/api/chat', 'POST', { ...chat, guided: false });
    const body = await error(response, 502, 'MODEL_FAILED');
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.deepEqual((await h.store.read()).actions, []);
    assert.deepEqual((await h.store.read()).audit, []);
  }
});

test('failed persistence never returns a successful workspace or leaves partial drafts', async t => {
  const underlying = createMemoryStore();
  const store: StateStore = {
    kind: 'local', read: underlying.read,
    mutate(fn) {
      return underlying.mutate(state => {
        fn(state);
        throw new Error(`${ACCESS_KEY}; private backend cookie`);
      });
    },
  };
  const h = await harness(t, { store });
  await h.login();
  const body = await error(await h.send('/api/chat', 'POST', chat), 500, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(body).includes(ACCESS_KEY));
  assert.ok(!JSON.stringify(body).includes('cookie'));
  assert.equal((await underlying.read()).actions.length, 0);
  assert.equal((await underlying.read()).audit.length, 0);
});

test('action editing, stale approval, replay and rejection preserve exact simulated versions', async t => {
  const h = await harness(t);
  await h.login();
  const workspace = await (await h.send('/api/chat', 'POST', chat)).json() as Workspace;
  const action = workspace.actions[0]!;
  const patch = await h.send(`/api/actions/${action.id}`, 'PATCH', { content: 'Revisão humana', version: action.version });
  assert.equal(patch.status, 200);
  const updated = await patch.json();
  assert.equal(updated.version, action.version + 1);
  await error(await h.send(`/api/actions/${action.id}/approve`, 'POST', { version: action.version }), 409, 'CONFLICT');
  await error(await h.send(`/api/actions/${action.id}`, 'PATCH', { content: 'Edição obsoleta', version: action.version }), 409);
  assert.equal((await h.store.read()).outbox.length, 0);
  const approved = await h.send(`/api/actions/${action.id}/approve`, 'POST', { version: updated.version });
  assert.equal(approved.status, 200);
  const approval = await approved.json();
  assert.equal(approval.status, 'approved');
  const beforeReplay = await h.store.read();
  assert.equal(beforeReplay.outbox.length, 1);
  assert.equal(beforeReplay.outbox[0]!.content, 'Revisão humana');
  assert.equal(beforeReplay.outbox[0]!.version, updated.version);
  const replay = await h.send(`/api/actions/${action.id}/approve`, 'POST', { version: updated.version });
  assert.deepEqual(await replay.json(), approval);
  assert.deepEqual(await h.store.read(), beforeReplay);
  await error(await h.send(`/api/actions/${action.id}/reject`, 'POST', { version: updated.version }), 409);
  await error(await h.send(`/api/actions/${action.id}`, 'PATCH', { content: 'Proibido', version: updated.version }), 409);
  const second = await (await h.send('/api/chat', 'POST', chat)).json() as Workspace;
  const rejectPath = `/api/actions/${second.actions[0]!.id}/reject`;
  const rejection = await h.send(rejectPath, 'POST', { version: 1 });
  assert.equal((await rejection.json()).status, 'rejected');
  const before = await h.store.read();
  assert.equal((await h.send(rejectPath, 'POST', { version: 1 })).status, 200);
  assert.deepEqual(await h.store.read(), before);
  assert.equal(before.outbox.length, 1);
  const events = await (await h.send('/api/audit')).json();
  assert.equal(events.events.filter((event: { type: string }) => event.type === 'action.approved').length, 1);
  const all = await (await h.send('/api/actions')).json();
  assert.deepEqual(all.actions, before.actions);
  await error(await h.send('/api/actions/missing/approve', 'POST', { version: 1 }), 404, 'ACTION_NOT_FOUND');
});

test('autopilot is opt-in, ownership validated, strict and deduplicated without an external send', async t => {
  const h = await harness(t);
  await h.login();
  assert.deepEqual((await (await h.send('/api/autopilot')).json()).rules, []);
  const input = { name: 'Preparar semana', kind: 'week-prep', classId: classroom, enabled: false };
  await error(await h.send('/api/autopilot/rules', 'POST', { ...input, classId: 'not-owned' }), 403);
  await error(await h.send('/api/autopilot/rules', 'POST', { ...input, script: 'execute()' }), 400);
  const response = await h.send('/api/autopilot/rules', 'POST', input);
  assert.equal(response.status, 201);
  const rule = await response.json();
  assert.equal(rule.enabled, false);
  assert.equal((await h.send('/api/autopilot/run', 'POST', {})).status, 200);
  assert.equal((await h.store.read()).actions.length, 0);
  await error(await h.send(`/api/autopilot/rules/${rule.id}`, 'PATCH', { enabled: true, classId: 'not-owned' }), 400);
  assert.equal((await h.send(`/api/autopilot/rules/${rule.id}`, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await h.send('/api/autopilot/run', 'POST', {})).status, 200);
  const first = await h.store.read();
  assert.ok(first.actions.length > 0);
  assert.ok(first.actions.every(action => action.status === 'pending'));
  assert.equal((await h.send('/api/autopilot/run', 'POST', {})).status, 200);
  const second = await h.store.read();
  assert.equal(second.actions.length, first.actions.length);
  assert.deepEqual(second.dedupe, first.dedupe);
  assert.equal(second.outbox.length, 0);
  assert.ok(second.audit.length > 0);
});

test('security headers allow only inline scripts from the built index', async t => {
  let html = '';
  try {
    html = await readFile(new URL('../dist/web/index.html', import.meta.url), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const h = await harness(t);
  const response = await h.send('/healthz');
  const policy = response.headers.get('content-security-policy')!;
  const scriptDirective = policy.split(';').find(value => value.trim().startsWith('script-src'))!;
  assert.ok(!scriptDirective.includes('unsafe-inline'));
  assert.ok(!scriptDirective.includes('unsafe-eval'));
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => `'sha256-${createHash('sha256').update(match[1]!.replace(/\r\n?/g, '\n')).digest('base64')}'`);
  assert.equal(scriptDirective.trim(), ["script-src 'self'", ...new Set(hashes)].join(' '));
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('CSP hashes are read once from the trusted index and remain immutable across requests', async t => {
  const first = '\r\nwindow.theme = "dark";\r\n';
  const second = 'window.themeReady = true;';
  let html = `<script>${first}</script><script type="module">${second}</script><script>${second}</script>`
    + '<script src="/external.js">neverAuthorizeThis()</script>';
  const read = t.mock.method(fs, 'readFileSync', (path: unknown, encoding: unknown) => {
    assert.equal(path, fileURLToPath(new URL('../dist/web/index.html', import.meta.url)));
    assert.equal(encoding, 'utf8');
    return html;
  });
  const h = await harness(t);
  const expected = [first.replace(/\r\n/g, '\n'), second]
    .map(script => `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  html = '<script>injectedAfterBoot()</script>';
  for (const [path, method, body] of [
    ['/healthz?index=untrusted.html', 'GET', undefined],
    ['/api/unknown', 'POST', { html }],
    ['/untrusted.html', 'GET', undefined],
  ] as const) {
    const response = await h.send(path, method, body, { 'x-script-hash': 'injected' });
    const directive = response.headers.get('content-security-policy')!.split(';')[1]!.trim();
    assert.equal(directive, ["script-src 'self'", ...expected].join(' '));
    await response.arrayBuffer();
  }
  assert.equal(read.mock.callCount(), 1);
});

test('CSP denies inline scripts when the build index is absent at boot', async t => {
  const read = t.mock.method(fs, 'readFileSync', () => {
    throw Object.assign(new Error('No build index'), { code: 'ENOENT' });
  });
  const h = await harness(t);
  read.mock.restore();
  const response = await h.send('/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy')!.split(';')[1]!.trim(), "script-src 'self'");
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await h.send('/api/session')).status, 200);
});

test('unknown API and MCP paths are JSON 404, never an SPA or dataset', async t => {
  const h = await harness(t);
  for (const path of ['/api', '/api/not-a-route', '/api/session/unknown', '/mcp/unknown', '/%61pi/unknown', '/mcp%2funknown']) {
    for (const method of ['GET', 'POST', 'PATCH']) {
      await error(await h.send(path, method, method === 'GET' ? undefined : {}, { accept: 'text/html' }), 404);
    }
  }
  for (const path of ['/server/auth.ts', '/.env', '/missing.js']) {
    await error(await h.send(path, 'GET', undefined, { accept: 'text/html' }), 404);
  }
});

test('built web index, assets and SPA routes are served without exposing reserved namespaces', async t => {
  let html: string;
  try {
    html = await readFile(new URL('../dist/web/index.html', import.meta.url), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    t.skip('Requires an existing dist/web build; this HTTP test does not write outside server/test.');
    return;
  }
  const h = await harness(t);
  for (const path of ['/', '/turmas/planejamento']) {
    const response = await h.send(path, 'GET', undefined, { accept: 'text/html' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const script = html.match(/<script[^>]+src="([^"]+)"/)![1]!;
  const asset = await h.send(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.equal((await h.send('/api/unknown', 'GET', undefined, { accept: 'text/html' })).status, 404);
  assert.equal((await h.send('/mcp/unknown', 'GET', undefined, { accept: 'text/html' })).status, 404);
});

test('MCP uses a separate bearer and remains exempt from cookie, origin and CSRF checks', async t => {
  const h = await harness(t);
  await h.login();
  const message = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '1.0.0' },
  } };
  const headers = { accept: 'application/json, text/event-stream', origin: null, 'x-csrf-token': null };
  assert.equal((await h.send('/mcp', 'POST', message, headers)).status, 401);
  assert.equal((await h.send('/mcp', 'POST', message, { ...headers, authorization: `Bearer ${ACCESS_KEY}` })).status, 401);
  const response = await h.send('/mcp', 'POST', message, {
    ...headers, cookie: null, authorization: `Bearer ${MCP_KEY}`,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.text();
  assert.ok(body.includes('protocolVersion'));
  assert.ok(!body.includes(MCP_KEY));
  assert.equal(response.headers.get('set-cookie'), null);
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await h.send('/mcp', method, undefined, { authorization: `Bearer ${MCP_KEY}` })).status, 405);
  }
});

test('login and API requests have independent bounded rate limits that ignore spoofed forwarding', async t => {
  const h = await harness(t);
  await h.session();
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await h.send('/api/login', 'POST', { accessKey: 'wrong' }, { 'x-forwarded-for': `203.0.113.${attempt}` });
    assert.equal(response.status, 401);
  }
  await error(await h.send('/api/login', 'POST', { accessKey: ACCESS_KEY }), 429, 'LOGIN_RATE_LIMITED');
  assert.equal((await h.send('/api/session')).status, 200);
  let limited: Response | undefined;
  for (let count = 0; count < 241; count++) {
    const response = await h.send('/api/session');
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.ok(limited);
  await error(limited, 429, 'RATE_LIMITED');
  const health = await h.send('/healthz');
  assert.equal(health.status, 200);
});
