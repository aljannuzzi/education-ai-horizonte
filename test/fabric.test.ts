import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFabricClient, FABRIC_SCOPE, FabricError, FABRIC_MAX_QUESTION_LENGTH,
  type FabricConfig, type FabricDependencies, type FabricSession, type FabricTool,
} from '../server/fabric.js';

const config: FabricConfig = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  dataAgentId: '22222222-2222-2222-2222-222222222222',
  ontologyId: '33333333-3333-3333-3333-333333333333',
  auth: 'token-provider',
};
const endpoint = `https://api.fabric.microsoft.com/v1/mcp/workspaces/${config.workspaceId}/dataagents/${config.dataAgentId}/agent`;
const token = 'private-token-value';
const tool: FabricTool = {
  name: 'published_agent_42',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function harness(overrides: Partial<FabricSession> = {}, settings: FabricConfig = config) {
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  const session: FabricSession = {
    async connect() { calls.push('connect'); },
    async listTools() { calls.push('list'); return { tools: [tool] }; },
    async callTool(name, args) {
      calls.push('call');
      assert.equal(name, tool.name);
      assert.deepEqual(args, { prompt: 'Question?' });
      return { content: [{ type: 'text', text: 'Answer' }] };
    },
    async close() { calls.push('close'); },
    ...overrides,
  };
  const deps: FabricDependencies = {
    async tokenProvider(scope, abort) {
      calls.push('token'); assert.equal(scope, FABRIC_SCOPE); signal = abort; return token;
    },
    createSession(options) {
      assert.equal(options.endpoint, endpoint);
      assert.equal(options.token, token);
      return session;
    },
  };
  return { client: createFabricClient(settings, deps), calls, deps, get signal() { return signal; } };
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof FabricError);
  assert.equal(error.code, expected);
  assert.ok(!String(error).includes(token));
  assert.equal(error.cause, undefined);
  return true;
};

test('native embedded CSV is preserved as data without resource URLs or UI metadata', async () => {
  const h = harness({
    async callTool() {
      return { content: [
        { type: 'text', text: 'A grounded answer.' },
        { type: 'resource', resource: {
          uri: `https://private.example/source?token=${token}`,
          mimeType: 'text/csv', text: 'lesson_id,space_status\na-water,unavailable',
          _meta: { token, outputTemplate: '<script>not executable</script>' },
        } },
      ] };
    },
  });
  const result = await h.client.query('Question?');
  assert.match(result.answer, /a-water,unavailable/);
  assert.equal(result.content.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /private\.example|not executable|private-token-value/);
});

test('embedded HTML, remote-only links and oversized source payloads fail closed', async () => {
  for (const resource of [
    { uri: 'https://example.test/data', mimeType: 'text/html', text: '<script>bad()</script>' },
    { uri: 'https://example.test/data', mimeType: 'text/csv' },
    { uri: 'data:source', mimeType: 'text/csv', text: 'x'.repeat(64_001) },
  ]) {
    const h = harness({ async callTool() { return { content: [{ type: 'resource', resource }] }; } });
    await assert.rejects(h.client.query('Question?'), code('INVALID_RESULT'));
  }
});

test('configuration is explicit, strict, ID-only, and does not perform authentication', () => {
  for (const invalid of [
    undefined, {}, { ...config, workspaceId: '' }, { ...config, ontologyId: 'fake' },
    { ...config, dataAgentId: '../escape' }, { ...config, endpoint: 'https://evil.example' },
    { ...config, auth: 'managed-identity' }, { ...config, auth: 'default' },
    { ...config, timeoutMs: 0 }, { ...config, timeoutMs: 120_001 },
    { ...config, timeoutMs: NaN }, { ...config, nativeOntologyAttested: 'yes' },
    { ...config, tool: { name: 'x', inputProperty: '__proto__' } },
  ]) {
    assert.throws(() => createFabricClient(invalid as FabricConfig, { tokenProvider: async () => token }), code('INVALID_CONFIG'));
  }
  assert.throws(() => createFabricClient(config), code('INVALID_CONFIG'));
  assert.equal(createFabricClient({ ...config, auth: 'azure-cli' }).health().availability, 'not-checked');
});

test('exact endpoint/scope, discovery, provenance, health and cleanup without ontology verification', async () => {
  const h = harness({}, { ...config, nativeOntologyAttested: true });
  assert.equal(h.client.health().availability, 'not-checked');
  const result = await h.client.query('Question?');
  assert.deepEqual(h.calls, ['token', 'connect', 'list', 'call', 'close']);
  assert.equal(result.answer, 'Answer');
  assert.equal(result.source, 'fabric');
  assert.equal(result.provider, 'fabric');
  assert.equal(result.endpoint, endpoint);
  assert.deepEqual(result.nativeOntology, { status: 'unverified', operatorAttested: true });
  assert.equal(result.ontologyId, config.ontologyId);
  assert.deepEqual(result.tool, { name: tool.name, inputProperty: 'prompt' });
  assert.equal(h.client.health().availability, 'available');
  assert.equal(h.signal?.aborted, true);
});

test('question bounds are checked before auth or transport', async () => {
  const h = harness();
  for (const question of ['', ' \n', 'a'.repeat(FABRIC_MAX_QUESTION_LENGTH + 1), '\0', null]) {
    await assert.rejects(h.client.query(question as string), code('INVALID_QUESTION'));
  }
  assert.deepEqual(h.calls, []);
  const max = harness({ async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; } });
  await max.client.query('a'.repeat(FABRIC_MAX_QUESTION_LENGTH));
});

test('ambiguous, absent, write, unannotated and unsupported schema tools fail closed', async () => {
  const schemas = [
    { ...tool.inputSchema as object, required: ['other'] },
    { type: 'object', properties: { prompt: { type: 'number' } } },
    { type: 'object', properties: { prompt: { type: 'string', pattern: '.*' } } },
    { type: 'object', properties: { prompt: { type: 'string' }, other: { type: 'string' } } },
    { type: 'object', properties: { prompt: { type: 'string', maxLength: 2 } } },
    { type: 'object', properties: { prompt: { type: 'string', enum: ['other'] } } },
    { ...tool.inputSchema as object, oneOf: [] },
  ];
  const cases: FabricTool[][] = [
    [], [tool, { ...tool, name: 'second' }], [tool, tool],
    [{ ...tool, annotations: undefined }],
    [{ ...tool, annotations: { readOnlyHint: false } }],
    [{ ...tool, annotations: { readOnlyHint: true, destructiveHint: true } }],
    ...schemas.map(inputSchema => [{ ...tool, inputSchema }]),
  ];
  for (const tools of cases) {
    const h = harness({ async listTools() { return { tools }; } });
    await assert.rejects(h.client.query('Question?'), code('TOOL_UNSUPPORTED'));
    assert.ok(!h.calls.includes('call'));
    assert.equal(h.calls.at(-1), 'close');
  }
});

test('configured exact tool/property and read-only attestation; explicit write hint still rejected', async () => {
  const settings = { ...config, tool: { name: tool.name, inputProperty: 'prompt', readOnlyAttested: true } };
  const h = harness({ async listTools() { return { tools: [{ ...tool, annotations: undefined }, { ...tool, name: 'other' }] }; } }, settings);
  await h.client.query('Question?');
  for (const selection of [{ ...settings.tool, name: 'unknown' }, { ...settings.tool, inputProperty: 'unknown' }]) {
    await assert.rejects(harness({}, { ...config, tool: selection }).client.query('Question?'), code('TOOL_UNSUPPORTED'));
  }
  await assert.rejects(harness({
    async listTools() { return { tools: [{ ...tool, annotations: { readOnlyHint: false } }] }; },
  }, settings).client.query('Question?'), code('TOOL_UNSUPPORTED'));
});

test('discovery consumes all pages before choosing and rejects repeated cursors', async () => {
  let pages = 0;
  const h = harness({ async listTools() {
    return ++pages === 1 ? { tools: [tool], nextCursor: 'next' } : { tools: [{ ...tool, name: 'another' }] };
  } });
  await assert.rejects(h.client.query('Question?'), code('TOOL_UNSUPPORTED'));
  assert.equal(pages, 2);
  const loop = harness({ async listTools() { return { tools: [], nextCursor: 'loop' }; } });
  await assert.rejects(loop.client.query('Question?'), code('TOOL_UNSUPPORTED'));
});

test('all operation phases time out and abort, including providers ignoring cancellation', async () => {
  const hang = () => new Promise<never>(() => {});
  for (const phase of ['token', 'connect', 'listTools', 'callTool'] as const) {
    const h = harness(phase === 'token' ? {} : { [phase]: hang }, { ...config, timeoutMs: 20 });
    const client = phase === 'token'
      ? createFabricClient({ ...config, timeoutMs: 20 }, { ...h.deps, tokenProvider: hang }) : h.client;
    await assert.rejects(client.query('Question?'), code('TIMEOUT'));
    assert.equal(client.health().lastError, 'TIMEOUT');
    if (phase !== 'token') {
      assert.equal(h.signal?.aborted, true);
      assert.equal(h.calls.at(-1), 'close');
    }
  }
});

test('external cancellation avoids auth when already aborted and closes active session', async () => {
  const h = harness();
  await assert.rejects(h.client.query('Question?', { signal: AbortSignal.abort(token) }), code('CANCELLED'));
  assert.deepEqual(h.calls, []);
  const controller = new AbortController();
  const active = harness({ async callTool() { controller.abort(token); return new Promise(() => {}); } });
  await assert.rejects(active.client.query('Question?', { signal: controller.signal }), code('CANCELLED'));
  assert.equal(active.calls.at(-1), 'close');
});

test('authentication and MCP errors are bounded and never cause a fallback', async () => {
  const h = harness();
  const auth = createFabricClient(config, { ...h.deps, tokenProvider: async () => { throw new Error(token); } });
  await assert.rejects(auth.query('Question?'), code('AUTH_FAILED'));
  assert.deepEqual(h.calls, []);
  for (const method of ['connect', 'listTools', 'callTool'] as const) {
    const failure = harness({ async [method]() { throw new Error(`secret ${token}`); } });
    await assert.rejects(failure.client.query('Question?'), code('MCP_ERROR'));
    assert.equal(failure.calls.at(-1), 'close');
    assert.equal(failure.client.health().availability, 'unavailable');
  }
});

test('tool errors, non-text and oversized results are rejected; response secrets/metadata removed', async () => {
  for (const result of [
    { isError: true, content: [{ type: 'text', text: token }] },
    { content: [{ type: 'image', data: token }] },
    { content: [{ type: 'text', text: 'x'.repeat(64_001) }] },
    { content: [] },
  ]) {
    const h = harness({ async callTool() { return result; } });
    await assert.rejects(h.client.query('Question?'), code(result.isError ? 'TOOL_ERROR' : 'INVALID_RESULT'));
  }
  const h = harness({ async callTool() {
    return {
      content: [{ type: 'text', text: `Answer ${token} Bearer another-secret`, _meta: { token } }],
      structuredContent: { count: 3, nested: { authorization: token, text: token }, _meta: { token } },
      _meta: { headers: { authorization: token } },
    };
  } });
  const result = await h.client.query('Question?');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes('another-secret'));
  assert.ok(!JSON.stringify(result).includes('_meta'));
  assert.deepEqual(result.structuredContent, { count: 3, nested: { text: '[redacted]' } });
});

test('cleanup failures and hangs cannot replace results or block indefinitely', async () => {
  for (const close of [
    async () => { throw new Error(token); },
    () => new Promise<void>(() => {}),
  ]) {
    const start = Date.now();
    assert.equal((await harness({ close }).client.query('Question?')).answer, 'Answer');
    assert.ok(Date.now() - start < 2_000);
  }
});

test('real SDK honors extended deadline and uses initialize/list/call with exact token and no redirects', async t => {
  const methods: string[] = [];
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    delays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  });
  const client = createFabricClient({ ...config, timeoutMs: 120_000 }, {
    tokenProvider: async scope => { assert.equal(scope, FABRIC_SCOPE); return token; },
    fetch: async (url, init) => {
      assert.equal(String(url), endpoint);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'error');
      if (init?.method === 'GET') return new Response('', { status: 405 });
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      if (request.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (request.method === 'initialize') {
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fabric', version: '1' } };
      } else if (request.method === 'tools/list') result = { tools: [tool] };
      else {
        assert.equal(request.method, 'tools/call');
        assert.deepEqual(request.params, { name: tool.name, arguments: { prompt: 'Question?' } });
        result = { content: [{ type: 'text', text: 'Native answer' }] };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal((await client.query('Question?')).answer, 'Native answer');
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(delays.includes(60_000), false);
  assert.ok(delays.filter(delay => delay === 120_000).length >= 4);
});

test('real SDK HTTP errors expose only status, not response body or headers', async () => {
  for (const status of [301, 401, 403, 404, 405, 429, 500]) {
    const client = createFabricClient(config, {
      tokenProvider: async () => token,
      fetch: async () => new Response(token, { status, headers: { location: 'https://evil.example', authorization: token } }),
    });
    await assert.rejects(client.query('Question?'), error => {
      code('HTTP_ERROR')(error);
      assert.equal((error as FabricError).httpStatus, status);
      return true;
    });
  }
});

test('a token resolving after timeout cannot start a transport', async () => {
  let resolveToken: (value: string) => void = () => {};
  let created = false;
  const client = createFabricClient({ ...config, timeoutMs: 10 }, {
    tokenProvider: () => new Promise(resolve => { resolveToken = resolve; }),
    createSession: () => { created = true; throw new Error('must not connect'); },
  });
  await assert.rejects(client.query('Question?'), code('TIMEOUT'));
  resolveToken(token);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, false);
});

test('native HTTP network failure and stalled fetch are sanitized and cancelled', async () => {
  let signal: AbortSignal | null | undefined;
  const stalled = createFabricClient({ ...config, timeoutMs: 20 }, {
    tokenProvider: async () => token,
    fetch: async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(stalled.query('Question?'), code('TIMEOUT'));
  assert.equal(signal?.aborted, true);
  const failure = createFabricClient(config, {
    tokenProvider: async () => token,
    fetch: async () => { throw new Error(`Authorization: Bearer ${token}`); },
  });
  await assert.rejects(failure.query('Question?'), code('MCP_ERROR'));
});
