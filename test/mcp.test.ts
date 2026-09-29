import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createAuth } from '../server/auth.js';
import { agentRegistry, createEducationAgents, type EducationAgents } from '../server/agents.js';
import { mountMcp } from '../server/mcp.js';
import { classes, executeSkill, skills } from '../server/semantic.js';
import { recordModelUsage } from '../server/cost-meter.js';

const MCP_KEY = 'mcp-test-only-separate-key';
const DEMO_KEY = 'browser-test-only-key';
const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } },
};
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const call = (args: unknown, name = 'execute_skill') => ({
  jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args },
});
const valid = { skillId: skills[0]!.id, classId: classes[0]!.id };
const toolNames = ['execute_skill', 'describe_ontology', 'list_classes', 'list_skills', 'invoke_education_agent'];

test('opt-in MCP receipts use tool-call scope and preserve successful and failed operation usage', async t => {
  const h = await harness(t, { COST_METERING_ENABLED: 'true' });
  const success = (await rpc(await h.send(call({}, 'list_skills')))).result;
  const receipt = success._meta['horizonte/costReceipt'];
  assert.equal(receipt.capture.scope, 'tool-call');
  assert.equal(receipt.capture.outcome, 'succeeded');
  assert.equal(receipt.billingRecord, false);
  assert.doesNotMatch(JSON.stringify(receipt), /mcp-test-only|browser-test-only|teacher-marina/);
  const failure = (await rpc(await h.send(call({
    agentId: 'teacher-support', classId: valid.classId, request: 'PRIVATE_REQUEST',
  }, 'invoke_education_agent')))).result;
  assert.equal(failure.isError, true);
  assert.equal(failure._meta['horizonte/costReceipt'].capture.outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(failure._meta), /PRIVATE_REQUEST/);

  const agents: EducationAgents = { async invoke() {
    recordModelUsage({
      model: 'gpt-5.4-mini', source: 'provider-usage', outcome: 'failed', durationMs: 1,
      inputTokens: 1000, cachedInputTokens: 200, outputTokens: 400, reasoningOutputTokens: 25,
    });
    throw new Error('PRIVATE_PROVIDER_ERROR');
  } };
  const billed = await harness(t, { COST_METERING_ENABLED: 'true' }, agents);
  const result = (await rpc(await billed.send(call({
    agentId: 'teacher-support', classId: valid.classId, request: 'PRIVATE_REQUEST',
  }, 'invoke_education_agent')))).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta['horizonte/costReceipt'].capture.modelCalls[0].inputTokens, 1000);
  assert.ok(result._meta['horizonte/costReceipt'].totals.knownSubtotal > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_ERROR|PRIVATE_REQUEST/);
});

async function harness(t: TestContext, overrides: NodeJS.ProcessEnv = {}, agents?: EducationAgents) {
  const env = { NODE_ENV: 'test', DEMO_ACCESS_KEY: DEMO_KEY, MCP_ACCESS_KEY: MCP_KEY, ...overrides };
  const app = express();
  app.set('trust proxy', false);
  mountMcp(app, env, { agents });
  // Exercise real browser credentials without depending on the separately implemented LLM.
  const auth = createAuth({ NODE_ENV: 'test', DEMO_ACCESS_KEY: DEMO_KEY });
  app.get('/api/session', (req, res) => { res.json(auth.session(req, res)); });
  app.post('/api/login', auth.mutation, express.json(), (req, res) => {
    res.json(auth.login(req, res, req.body.accessKey));
  });
  app.get('/api/private', auth.requireSession, (_req, res) => { res.json({ authenticated: true }); });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (body: unknown, overrides: Record<string, string | null> = {}) => {
    const headers = new Headers({
      authorization: `Bearer ${MCP_KEY}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return fetch(`${origin}/mcp`, {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
  return { origin, send };
}

async function apiError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.error.code, code);
  const text = JSON.stringify(body);
  for (const secret of [MCP_KEY, DEMO_KEY, 'teacher-marina', 'class-7a', 'class-7b']) {
    assert.ok(!text.includes(secret), `Response leaked ${secret}`);
  }
  return body;
}

async function rpc(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0');
  return body;
}

test('HTTP initialize and discovery are authenticated, stateless and read-only', async t => {
  const h = await harness(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const init = await rpc(await h.send(initialize));
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, initialize.params.protocolVersion);
    assert.deepEqual(Object.keys(init.result.capabilities), ['tools']);
  }
  const notification = await h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  assert.equal(notification.headers.get('mcp-session-id'), null);
  const discovery = await rpc(await h.send(list));
  assert.deepEqual(discovery.result.tools.map((item: { name: string }) => item.name), toolNames);
  for (const item of discovery.result.tools) {
    assert.equal(item.inputSchema.additionalProperties, false);
    assert.equal(item.annotations.readOnlyHint, true);
  }
  const tool = discovery.result.tools[0];
  assert.equal(tool.name, 'execute_skill');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['classId', 'skillId']);
  assert.deepEqual(tool.inputSchema.required.sort(), ['classId', 'skillId']);
  assert.deepEqual(tool.inputSchema.properties.skillId.enum, skills.map(skill => skill.id));
});

test('HTTP discovery calls expose only authorized classes and strict tool arguments', async t => {
  const h = await harness(t);
  const ontology = (await rpc(await h.send(call({}, 'describe_ontology')))).result;
  assert.equal(ontology.structuredContent.engine, 'custom-semantic-engine');
  assert.equal(ontology.structuredContent.nativeFabric, false);
  const classroomList = (await rpc(await h.send(call({}, 'list_classes')))).result;
  assert.deepEqual(classroomList.structuredContent.classes, classes);
  const catalog = (await rpc(await h.send(call({}, 'list_skills')))).result;
  assert.deepEqual(catalog.structuredContent.skills.map((skill: { id: string }) => skill.id), skills.map(skill => skill.id));
  assert.deepEqual(catalog.structuredContent.agents, agentRegistry);
  for (const result of [ontology, classroomList, catalog]) {
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.readOnly, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(!JSON.stringify(result).includes('teacher-other'));
  }
  for (const name of toolNames) {
    const args = name === 'execute_skill' ? valid : name === 'invoke_education_agent'
      ? { agentId: 'teacher-support', classId: valid.classId, request: 'Sugira apoio.' } : {};
    for (const key of ['unknown', '__proto__', 'constructor', 'url']) {
      const result = (await rpc(await h.send(call({ ...args, [key]: 'https://example.invalid' }, name)))).result;
      assert.equal(result.isError, true, `${name}: ${key}`);
      assert.equal(result.structuredContent, undefined);
    }
  }
  const unavailable = (await rpc(await h.send(call({
    agentId: 'teacher-support', classId: valid.classId, request: 'Sugira apoio.',
  }, 'invoke_education_agent')))).result;
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /AGENT_NOT_CONFIGURED/);
});

test('HTTP invokes real mocked Azure agents with class isolation and no unauthorized network access', async t => {
  let calls = 0;
  const agents = createEducationAgents({ AZURE_OPENAI_ENDPOINT: 'https://education-test.openai.azure.com/' }, {
    credential: { async getToken() { return { token: 'test-only-token' }; } },
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.messages[1].content);
      return Response.json({ choices: [{
        finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
          summary: 'Revisar evidências.', suggestions: ['Conversar com a docente.'],
          evidenceIds: context.evidenceIds, requiresTeacherReview: true,
        }) },
      }] });
    },
  });
  const h = await harness(t, {}, agents);
  for (const agent of agentRegistry) {
    for (const classroom of classes) {
      const result = (await rpc(await h.send(call({
        agentId: agent.agentId, classId: classroom.id, request: 'Sugira apoio.',
      }, 'invoke_education_agent')))).result;
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent.context, executeSkill(agent.skillId, classroom.id));
      assert.equal(result.structuredContent.response.requiresTeacherReview, true);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
    for (const args of [
      { agentId: agent.agentId, classId: 'class-foreign', request: 'Sugira apoio.' },
      { agentId: agent.agentId, classId: valid.classId, request: 'Sugira apoio.', url: 'https://example.invalid' },
    ]) {
      const before = calls;
      const result = (await rpc(await h.send(call(args, 'invoke_education_agent')))).result;
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(calls, before);
    }
  }
  assert.equal(calls, agentRegistry.length * classes.length);
});

test('all semantic skills use the same execution, isolate both owned classes and are repeatable', async t => {
  const h = await harness(t);
  await rpc(await h.send(initialize));
  assert.equal(classes.length, 2);
  for (const skill of skills) {
    const results = await Promise.all(classes.map(async classroom => {
      const args = { skillId: skill.id, classId: classroom.id };
      const result = (await rpc(await h.send(call(args)))).result;
      assert.notEqual(result.isError, true);
      const expected = executeSkill(skill.id, classroom.id);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      for (const row of result.structuredContent.results) {
        assert.equal(row.provenance.classId, classroom.id);
        assert.equal(row.provenance.readOnly, true);
        assert.equal(row.provenance.simulated, true);
        if (row.record.classId) assert.equal(row.record.classId, classroom.id);
        assert.notEqual(row.record.teacherId, 'teacher-other');
      }
      const repeated = (await rpc(await h.send(call(args), {
        'mcp-session-id': 'arbitrary-client-session-does-not-select-a-class',
      }))).result;
      assert.deepEqual(repeated, result);
      assert.equal('actions' in result.structuredContent, false);
      return result;
    }));
    assert.notDeepEqual(results[0], results[1]);
  }
});

test('each HTTP response closes its own fresh server and transport, including protocol errors', async t => {
  const closeServer = t.mock.method(McpServer.prototype, 'close');
  const closeTransport = t.mock.method(StreamableHTTPServerTransport.prototype, 'close');
  const h = await harness(t);
  for (const message of [initialize, initialize, list, call(valid), { invalid: true }]) {
    const response = await h.send(message);
    await response.arrayBuffer();
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closeServer.mock.callCount(), 5);
  const servers = new Set(closeServer.mock.calls.map(call => call.this));
  const transports = new Set(closeTransport.mock.calls.map(call => call.this));
  assert.equal(servers.size, 5);
  assert.equal(transports.size, 5);
});

test('SDK rejects unknown input keys rather than stripping them, and enforces class ownership', async t => {
  const h = await harness(t);
  await rpc(await h.send(initialize));
  const invalid: unknown[] = [
    {}, { skillId: valid.skillId }, { classId: valid.classId },
    { ...valid, skillId: 'approve-action' }, { ...valid, classId: 'class-foreign' },
    { ...valid, classId: '' }, { ...valid, classId: 7 }, { ...valid, classId: 'a'.repeat(257) },
    { ...valid, classId: 'https://example.invalid' }, { ...valid, classId: '..\\dataset.json' },
    { ...valid, classId: 'SELECT * FROM classroom' }, { ...valid, classId: '<script>alert(1)</script>' },
    ...['teacherId', 'url', 'script', 'sql', 'path', 'content', 'approve', 'toolSpec', '__proto__', 'constructor']
      .map(key => ({ ...valid, [key]: { value: 'must-not-be-ignored' } })),
  ];
  for (const args of invalid) {
    const body = await rpc(await h.send(call(args)));
    assert.equal(body.id, 3);
    assert.equal(body.result.isError, true, JSON.stringify(args));
    assert.equal(body.result.structuredContent, undefined);
    assert.ok(body.result.content.every((item: { type: string }) => item.type === 'text'));
  }
  for (const name of ['approve_action', 'write_record', 'store', 'get_teacher_context']) {
    assert.equal((await rpc(await h.send(call(valid, name)))).result.isError, true);
  }
  const foreign = (await rpc(await h.send(call({ ...valid, classId: 'class-foreign' })))).result;
  assert.match(foreign.content[0].text, /Turma não autorizada/);
  assert.notEqual((await rpc(await h.send(call(valid)))).result.isError, true);
});

test('no cloud discovery accepts missing bearer, the DEMO key, query keys or browser cookies', async t => {
  const h = await harness(t);
  const sessionResponse = await fetch(`${h.origin}/api/session`);
  const anonymousCookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
  const session = await sessionResponse.json();
  const loginResponse = await fetch(`${h.origin}/api/login`, {
    method: 'POST',
    headers: {
      cookie: anonymousCookie, origin: h.origin, 'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ accessKey: DEMO_KEY }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!;
  const login = await loginResponse.json();
  assert.equal((await fetch(`${h.origin}/api/private`, { headers: { cookie } })).status, 200);
  for (const message of [initialize, list, call(valid)]) {
    for (const authorization of [null, 'Bearer wrong', `Bearer ${DEMO_KEY}`, `Basic ${MCP_KEY}`, 'Bearer']) {
      const response = await h.send(message, {
        authorization, cookie, 'x-csrf-token': login.csrfToken, origin: h.origin,
      });
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      await apiError(response, 401, 'MCP_UNAUTHORIZED');
    }
  }
  await apiError(await fetch(`${h.origin}/mcp?access_token=${MCP_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(initialize),
  }), 401, 'MCP_UNAUTHORIZED');
  await apiError(await h.send('{secret-unparseable', { authorization: null }), 401, 'MCP_UNAUTHORIZED');
  await rpc(await h.send(initialize, { origin: h.origin }));
});

test('missing, blank or shared MCP keys fail closed without blocking browser startup', async t => {
  for (const key of [undefined, '', ' \n ', DEMO_KEY, ` ${DEMO_KEY} `]) {
    const h = await harness(t, { MCP_ACCESS_KEY: key });
    const session = await fetch(`${h.origin}/api/session`);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, false);
    for (const message of [initialize, list]) {
      await apiError(await h.send(message), 503, 'MCP_NOT_CONFIGURED');
    }
  }
});

test('GET, DELETE and other unsupported methods return 405 without discovery', async t => {
  const h = await harness(t);
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    for (const headers of [new Headers(), new Headers({ authorization: `Bearer ${MCP_KEY}` })]) {
      const response = await fetch(`${h.origin}/mcp`, { method, headers });
      assert.equal(response.headers.get('allow'), 'POST');
      assert.equal(response.headers.get('mcp-session-id'), null);
      await apiError(response, 405, 'METHOD_NOT_ALLOWED');
    }
  }
});

test('Origin is optional for native clients and exact-match validated when sent', async t => {
  const h = await harness(t, { PUBLIC_ORIGIN: 'https://school.example' });
  await rpc(await h.send(initialize));
  await rpc(await h.send(initialize, { origin: 'https://school.example' }));
  for (const origin of ['null', 'https://evil.example', 'https://school.example.evil', 'https://school.example/', '']) {
    await apiError(await h.send(initialize, { origin }), 403, 'ORIGIN_FORBIDDEN');
  }
  const local = await harness(t);
  await rpc(await local.send(initialize, { origin: local.origin }));
  await apiError(await local.send(initialize, { origin: 'https://evil.example' }), 403, 'ORIGIN_FORBIDDEN');
  await apiError(await local.send(initialize, {
    origin: 'http://rebound.example', host: 'rebound.example',
  }), 403, 'ORIGIN_FORBIDDEN');
  for (const env of [
    { PUBLIC_ORIGIN: 'https://school.example/path' },
    { PUBLIC_ORIGIN: 'https://user:password@school.example' },
    { NODE_ENV: 'production', PUBLIC_ORIGIN: undefined },
    { NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://school.example' },
  ]) {
    const invalid = await harness(t, env);
    await apiError(await invalid.send(initialize), 503, 'MCP_NOT_CONFIGURED');
  }
});

test('bounded JSON parsing returns sanitized ApiError and protocol failures stay JSON-RPC', async t => {
  const h = await harness(t);
  await apiError(await h.send(`{"secret":"${MCP_KEY}"`), 400, 'INVALID_JSON');
  await apiError(await h.send('null'), 400, 'INVALID_JSON');
  await apiError(await h.send({ padding: 'x'.repeat(17 * 1024) }), 413, 'BODY_TOO_LARGE');
  await apiError(await h.send(initialize, { 'content-type': 'text/plain' }), 415, 'JSON_REQUIRED');
  await apiError(await h.send(initialize, { 'content-encoding': 'gzip' }), 415, 'UNSUPPORTED_ENCODING');
  const malformed = await h.send({ jsonrpc: '2.0', id: 1, method: 9 });
  assert.equal(malformed.status, 400);
  const error = await malformed.json();
  assert.equal(error.jsonrpc, '2.0');
  assert.equal(typeof error.error.code, 'number');
  const unsupported = await rpc(await h.send({ jsonrpc: '2.0', id: 8, method: 'resources/list' }));
  assert.equal(unsupported.error.code, -32601);
  const task = call(valid);
  const taskResult = await rpc(await h.send({ ...task, params: { ...task.params, task: { ttl: 1000 } } }));
  assert.equal(taskResult.error.code, -32603);
  assert.match(taskResult.error.message, /task/i);
  assert.equal(taskResult.result, undefined);
  await rpc(await h.send(initialize));
});

test('rate limiting applies to authenticated tool discovery', async t => {
  const h = await harness(t);
  for (let request = 0; request < 120; request++) {
    const response = await h.send(initialize);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const response = await h.send(initialize);
  assert.ok(response.headers.has('retry-after'));
  await apiError(response, 429, 'MCP_RATE_LIMITED');
});

test('STDIO entrypoint is import-guarded and speaks only protocol without cloud keys', { timeout: 20_000 }, async t => {
  await import('../server/mcp-stdio.js');
  const child = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('../server/mcp-stdio.ts', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DEMO_ACCESS_KEY: '', MCP_ACCESS_KEY: '', PUBLIC_ORIGIN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const reader = createInterface({ input: child.stdout });
  t.after(() => reader.close());
  const stdout: string[] = [];
  let stderr = '';
  reader.on('line', line => { stdout.push(line); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const send = async (message: unknown) => {
    const response = once(reader, 'line');
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const [line] = await response;
    return JSON.parse(line as string);
  };
  const init = await send(initialize);
  assert.equal(init.result.serverInfo.name, 'horizonte-semantic');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const discovery = await send(list);
  assert.deepEqual(discovery.result.tools.map((tool: { name: string }) => tool.name), toolNames);
  assert.equal(discovery.result.tools[0].annotations.readOnlyHint, true);
  for (const classroom of classes) {
    const result = await send(call({ ...valid, classId: classroom.id }));
    assert.deepEqual(result.result.structuredContent, executeSkill(valid.skillId, classroom.id));
  }
  assert.equal((await send(call({ ...valid, teacherId: 'teacher-other' }))).result.isError, true);
  assert.equal((await send(call({ ...valid, ['__proto__']: {} }))).result.isError, true);
  assert.equal((await send(call({ ...valid, classId: 'class-foreign' }))).result.isError, true);
  assert.equal((await send(call(valid, 'approve_action'))).result.isError, true);
  child.stdin.end();
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout.length, 8);
  for (const line of stdout) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal(stderr, '');
});
