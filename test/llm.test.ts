import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DefaultAzureCredential } from '@azure/identity';
import { z } from 'zod';
import type { ChatRequest } from '../shared/contracts.js';
import type { QuestionCostReceipt } from '../shared/cost-contracts.js';
import { withCostMeter } from '../server/cost-meter.js';
import { createApp } from '../server/app.js';
import { createJsonModel, createReasoner, MODEL_NAME, MODEL_SCOPE, ModelError, routingSchema } from '../server/llm.js';
import { classes, defaultToolSpec } from '../server/semantic.js';
import { createMemoryStore } from '../server/store.js';

const env = {
  AZURE_OPENAI_ENDPOINT: 'https://synthetic-example.openai.azure.com/',
  AZURE_OPENAI_DEPLOYMENT: 'teacher-reasoning',
  AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
};
const request: ChatRequest = {
  message: 'O laboratorio ficou indisponivel. Como mantenho minha aula?',
  classId: classes[0]!.id, mode: 'code',
};
const route = {
  intent: 'lesson', parameters: { tool: null }, plan: { steps: ['consultar-ontologia', 'preparar-proposta'] },
};
const credential = { async getToken() { return { token: 'synthetic-test-token' }; } };
function completion(value: unknown = route, finish_reason = 'stop') {
  return Response.json({
    choices: [{ finish_reason, message: { role: 'assistant', content: JSON.stringify(value), refusal: null } }],
  });
}
const failed = (error: unknown) => error instanceof ModelError && error.status === 502 && error.code === 'MODEL_FAILED';

const tokenUsage = {
  prompt_tokens: 120, completion_tokens: 40,
  prompt_tokens_details: { cached_tokens: 30 },
  completion_tokens_details: { reasoning_tokens: 15 },
};
const nullTokens = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null };
function metered(run: () => Promise<unknown>, receipts: QuestionCostReceipt[]) {
  return withCostMeter({
    path: 'azure-mcp', scope: 'question', env: { COST_METERING_ENABLED: 'true' },
    onReceipt: receipt => { receipts.push(receipt); },
  }, run);
}
function usageResponse(usage: unknown, content = JSON.stringify(route), choices?: unknown) {
  return Response.json({
    model: 'gpt-5.4-mini-2026-03-17', usage,
    choices: choices ?? [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }, { headers: { 'x-request-id': 'request_1.test-2' } });
}

test('HTTP metering preserves exact provider usage and passthrough, including cache and reasoning subsets', async () => {
  const receipts: QuestionCostReceipt[] = [];
  const model = createJsonModel(env, { credential, fetch: async () => usageResponse(tokenUsage) });
  assert.deepEqual(await metered(() => model.complete('Synthetic', {}, {}), receipts), route);
  assert.equal(receipts.length, 1);
  const calls = receipts[0]!.capture.modelCalls;
  assert.equal(calls.length, 1);
  assert.ok(Number.isFinite(calls[0]!.durationMs) && calls[0]!.durationMs >= 0);
  assert.deepEqual(calls[0], {
    model: MODEL_NAME, outcome: 'succeeded', source: 'provider-usage', durationMs: calls[0]!.durationMs,
    inputTokens: 120, outputTokens: 40, cachedInputTokens: 30, reasoningOutputTokens: 15,
    requestId: 'request_1.test-2',
  });
});

test('usage is captured before choices validation and malformed nested JSON failures', async () => {
  for (const response of [
    () => usageResponse(tokenUsage, '{}', []),
    () => usageResponse(tokenUsage, '{invalid'),
  ]) {
    const receipts: QuestionCostReceipt[] = [];
    let sends = 0;
    const model = createJsonModel(env, { credential, fetch: async () => { sends++; return response(); } });
    await assert.rejects(metered(() => model.complete('Synthetic', {}, {}), receipts), failed);
    assert.equal(sends, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.capture.modelCalls.length, 1);
    assert.equal(receipts[0]!.capture.modelCalls[0]!.outcome, 'failed');
    const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = receipts[0]!.capture.modelCalls[0]!;
    assert.deepEqual({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens },
      { inputTokens: 120, outputTokens: 40, cachedInputTokens: 30, reasoningOutputTokens: 15 });
  }
});

test('missing and invalid provider counts remain null; details cannot exceed valid parents', async () => {
  for (const [usage, expected] of [
    [undefined, nullTokens], [null, nullTokens], [[], nullTokens],
    [{ prompt_tokens: '12', completion_tokens: -1 }, nullTokens],
    [{ prompt_tokens: 1.5, completion_tokens: 1_000_000_001 }, nullTokens],
    [{ prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: null,
      prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }, nullTokens],
    [{ ...tokenUsage, prompt_tokens_details: { cached_tokens: 121 }, completion_tokens_details: { reasoning_tokens: 41 } },
      { ...nullTokens, inputTokens: 120, outputTokens: 40 }],
    [{ ...tokenUsage, prompt_tokens_details: { cached_tokens: -1 }, completion_tokens_details: { reasoning_tokens: '2' } },
      { ...nullTokens, inputTokens: 120, outputTokens: 40 }],
    [{ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 } },
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 }],
  ] as const) {
    const receipts: QuestionCostReceipt[] = [];
    const model = createJsonModel(env, { credential, fetch: async () => usageResponse(usage) });
    await metered(() => model.complete('Synthetic', {}, {}), receipts);
    const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = receipts[0]!.capture.modelCalls[0]!;
    assert.deepEqual({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens }, expected);
  }
});

test('HTTP errors preserve available usage; absent usage remains unknown and request IDs are validated', async () => {
  for (const [response, requestId, counts] of [
    [() => Response.json({ usage: tokenUsage, error: 'PRIVATE_ERROR' }, { status: 429, headers: { 'x-request-id': 'unsafe/id', 'apim-request-id': 'safe-id' } }), 'safe-id',
      { inputTokens: 120, outputTokens: 40, cachedInputTokens: 30, reasoningOutputTokens: 15 }],
    [() => new Response(null, { status: 503, headers: { 'x-request-id': 'x'.repeat(129), 'apim-request-id': 'unsafe id' } }), undefined, nullTokens],
    [() => { throw new Error('SECRET_NETWORK'); }, undefined, nullTokens],
  ] as const) {
    const receipts: QuestionCostReceipt[] = [];
    let sends = 0;
    const model = createJsonModel(env, { credential, fetch: () => { sends++; return Promise.resolve(response()); } });
    await assert.rejects(metered(() => model.complete('Synthetic', {}, {}), receipts), failed);
    assert.equal(sends, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.capture.modelCalls.length, 1);
    const call = receipts[0]!.capture.modelCalls[0]!;
    assert.deepEqual(call, { ...counts, model: 'unreported-model', source: 'provider-usage',
      outcome: 'failed', durationMs: call.durationMs, ...(requestId ? { requestId } : {}) });
    assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE_ERROR|SECRET_NETWORK/);
  }
});

test('pricing uses provider model identity, never the requested deployment assumption', async () => {
  for (const provider of ['gpt-4.1-2025-04-14', 'gpt-5.4-mini-2099-01-01', undefined, 'invalid model value']) {
    const receipts: QuestionCostReceipt[] = [];
    const model = createJsonModel(env, { credential, fetch: async () => Response.json({
      model: provider, usage: tokenUsage,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    }) });
    await metered(() => model.complete('Synthetic', {}, {}), receipts);
    const receipt = receipts[0]!;
    assert.equal(receipt.capture.modelCalls[0]!.model,
      provider === undefined || provider === 'invalid model value' ? 'unreported-model' : provider);
    assert.equal(receipt.lines.find(line => line.component === 'azure-openai')!.amount, null);
  }
});

test('token and body preparation failures record no HTTP calls', async () => {
  let sends = 0;
  for (const getToken of [async () => null, async () => ({ token: '' }),
    async () => { throw new Error('SECRET_TOKEN'); }, credential.getToken]) {
    const receipts: QuestionCostReceipt[] = [];
    const model = createJsonModel(env, { credential: { getToken }, fetch: async () => { sends++; return completion(); } });
    await assert.rejects(metered(() => model.complete('Synthetic', 1n, {}), receipts), failed);
    assert.deepEqual(receipts[0]!.capture.modelCalls, []);
  }
  assert.equal(sends, 0);
});

test('late send and stream resolution after abort cannot mutate finalized usage or add calls', async () => {
  for (const phase of ['send', 'stream'] as const) {
    const receipts: QuestionCostReceipt[] = [];
    let resolveSend!: (response: Response) => void;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | null | undefined;
    let sends = 0;
    const model = createJsonModel(env, { credential, timeoutMs: 30, fetch: async (_url, init) => {
      sends++;
      signal = init?.signal;
      return phase === 'send' ? new Promise<Response>(resolve => { resolveSend = resolve; })
        : new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    } });
    await assert.rejects(metered(() => model.complete('Synthetic', {}, {}), receipts), failed);
    assert.equal(signal?.aborted, true);
    assert.equal(sends, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.capture.modelCalls.length, 1);
    const before = structuredClone(receipts);
    if (phase === 'send') resolveSend(usageResponse(tokenUsage));
    else {
      stream.enqueue(new TextEncoder().encode(JSON.stringify({
        usage: tokenUsage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
      })));
      stream.close();
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(receipts, before);
    assert.equal(receipts[0]!.capture.modelCalls[0]!.inputTokens, null);
    assert.equal(receipts[0]!.capture.modelCalls[0]!.outcome, 'failed');
  }
});

test('model is explicitly unavailable without endpoint and invalid or partial configuration never falls back', async () => {
  const model = createReasoner({});
  assert.equal(model.configured, false);
  await assert.rejects(model.route(request), (error: unknown) =>
    error instanceof ModelError && error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  for (const config of [
    { AZURE_OPENAI_ENDPOINT: '' }, { AZURE_OPENAI_DEPLOYMENT: 'orphan' },
    { AZURE_OPENAI_API_VERSION: env.AZURE_OPENAI_API_VERSION },
    { ...env, AZURE_OPENAI_ENDPOINT: 'http://synthetic-example.openai.azure.com' },
    { ...env, AZURE_OPENAI_ENDPOINT: 'https://synthetic-example.openai.azure.com.attacker.example' },
    { ...env, AZURE_OPENAI_ENDPOINT: 'https://user:pass@synthetic-example.openai.azure.com/' },
    { ...env, AZURE_OPENAI_ENDPOINT: `${env.AZURE_OPENAI_ENDPOINT}?key=secret` },
    { ...env, AZURE_OPENAI_ENDPOINT: `${env.AZURE_OPENAI_ENDPOINT}custom/path` },
    { ...env, AZURE_OPENAI_DEPLOYMENT: '../other' },
    { ...env, AZURE_OPENAI_API_VERSION: 'bad&key=secret' },
  ]) {
    assert.throws(() => createReasoner(config), (error: unknown) =>
      error instanceof ModelError && error.code === 'MODEL_CONFIG');
  }
});

test('live request uses DefaultAzureCredential cognitive scope, deployment, strict JSON schema and completion tokens', async t => {
  const calls: { url: string; options: RequestInit }[] = [];
  const tokens: unknown[] = [];
  t.mock.method(DefaultAzureCredential.prototype, 'getToken', async (scope: unknown, options: unknown) => {
    tokens.push({ scope, options });
    return { token: 'synthetic-managed-token', expiresOnTimestamp: Date.now() + 60_000 };
  });
  const model = createReasoner({ ...env, AZURE_OPENAI_API_KEY: 'must-not-use-this' }, {
    fetch: async (url, options) => {
      calls.push({ url: String(url), options: options! });
      return completion();
    },
  });
  const result = await model.route(request);
  assert.equal(result.intent, 'lesson');
  assert.equal(result.toolSpec, undefined);
  assert.deepEqual(JSON.parse(result.plan), route.plan);
  assert.equal(tokens.length, 1);
  assert.equal((tokens[0] as { scope: string }).scope, MODEL_SCOPE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${env.AZURE_OPENAI_ENDPOINT}openai/deployments/teacher-reasoning/chat/completions?api-version=2025-04-01-preview`);
  const options = calls[0]!.options;
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  const headers = new Headers(options.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-managed-token');
  assert.equal(headers.get('api-key'), null);
  assert.equal(headers.get('cookie'), null);
  const body = JSON.parse(String(options.body));
  assert.equal(body.model, MODEL_NAME);
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(body.response_format.json_schema.schema.properties.parameters.additionalProperties, false);
  assert.equal(body.response_format.json_schema.schema.properties.plan.additionalProperties, false);
  assert.deepEqual(body.response_format.json_schema.schema.required.sort(), ['intent', 'parameters', 'plan']);
  assert.doesNotMatch(String(options.body), /must-not-use-this|synthetic-managed-token|teacherId|Cookie/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { message: request.message, mode: 'code' });
});

test('all live intents are selected by validated model output, not mode or keyword inference', async () => {
  for (const intent of ['brief', 'lesson', 'diary', 'learning', 'writing', 'metrics', 'tool'] as const) {
    const tool = intent === 'tool' ? defaultToolSpec('fraction-lab') : null;
    const model = createReasoner(env, {
      credential, fetch: async () => completion({ ...route, intent, parameters: { tool } }),
    });
    const result = await model.route({ ...request, mode: 'autopilot' });
    assert.equal(result.intent, intent);
    assert.deepEqual(result.toolSpec, tool ?? undefined);
  }
});

test('Azure 400 invalid regex regression: omit only Unicode property patterns and retain local validation', async () => {
  const { $schema: _dialect, ...original } = z.toJSONSchema(routingSchema, { target: 'draft-7' });
  const expected = structuredClone(original);
  const title = (schema: any) => schema.properties.parameters.properties.tool.anyOf[0].properties.title;
  const pattern = title(original).pattern;
  assert.match(pattern, /\\p\{L\}/);
  delete title(expected).pattern;
  let calls = 0;
  let value: unknown = route;
  const azure: typeof fetch = async (_url, init) => {
    calls++;
    const schema = JSON.parse(String(init?.body)).response_format.json_schema.schema;
    if (title(schema).pattern) {
      return Response.json({ error: { code: null,
        message: `Invalid schema for response_format 'teacher_route': ${JSON.stringify(pattern)} is not a 'regex'.`,
      } }, { status: 400 });
    }
    assert.deepEqual(schema, expected);
    return completion(value);
  };
  // Reproduce the real upstream rejection with the unmodified Zod schema.
  assert.equal((await azure(env.AZURE_OPENAI_ENDPOINT, {
    body: JSON.stringify({ response_format: { json_schema: { schema: original } } }),
  })).status, 400);
  const model = createReasoner(env, { credential, fetch: azure });
  assert.equal((await model.route(request)).intent, 'lesson');
  for (const text of ['Aula de frações', 'https://attacker.example', '<script>', 'x'.repeat(101)]) {
    value = { ...route, intent: 'tool', parameters: { tool: { ...defaultToolSpec('fraction-lab'), title: text } } };
    if (text === 'Aula de frações') assert.equal((await model.route(request)).toolSpec?.title, text);
    else await assert.rejects(model.route(request), failed);
  }
  assert.equal(title(original).pattern, pattern);
  assert.equal(calls, 6);
});

test('shared model adapts nested schemas without mutating input or removing compatible patterns', async () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['pattern', 'rows'],
    properties: {
      pattern: { type: 'string', pattern: '^[A-Z]+$', minLength: 1, maxLength: 10 },
      rows: { type: 'array', minItems: 1, maxItems: 3,
        items: { anyOf: [{ type: 'string', pattern: '^\\p{L}+$' }, { type: 'null' }] } },
    },
  };
  const before = structuredClone(schema);
  const expected = structuredClone(schema);
  delete (expected.properties.rows.items.anyOf[0] as { pattern?: string }).pattern;
  const model = createJsonModel(env, { credential, fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).response_format.json_schema.schema, expected);
    return completion({});
  } });
  await model.complete('Synthetic test', {}, schema);
  assert.deepEqual(schema, before);
});

test('model validates ownership and request shape before any token or network request', async () => {
  let calls = 0;
  const model = createReasoner(env, {
    credential: { async getToken() { calls++; return { token: 'x' }; } },
    fetch: async () => { calls++; return completion(); },
  });
  for (const input of [
    { ...request, classId: 'foreign-class' }, { ...request, teacherId: 'another-teacher' },
    { ...request, message: '' }, { ...request, guided: true },
  ]) await assert.rejects(model.route(input));
  assert.equal(calls, 0);
});

test('model accepts only safe bounded declarative tools and schema-controlled plans', async () => {
  const tool = defaultToolSpec('fraction-lab');
  for (const value of [
    { ...route, extra: 'ignored?' },
    { ...route, intent: 'approve' },
    { ...route, parameters: { tool, url: 'https://attacker.example' } },
    { ...route, parameters: { tool } },
    { ...route, intent: 'tool' },
    { ...route, plan: { steps: ['execute-code'] } },
    { ...route, plan: { steps: [], evidence: 'invented' } },
    { ...route, plan: 'A turma aprendeu 99%' },
    ...[
      { ...tool, kind: 'execute-code' }, { ...tool, script: 'fetch("secret")' },
      { ...tool, title: 'https://attacker.example' }, { ...tool, title: '<script>' },
      { ...tool, durationMinutes: 0 }, { ...tool, stationCount: 99 },
      { ...tool, numerator: 4, denominator: 2 },
    ].map(invalid => ({ ...route, intent: 'tool', parameters: { tool: invalid } })),
  ]) {
    assert.equal(routingSchema.safeParse(value).success, false);
    const model = createReasoner(env, { credential, fetch: async () => completion(value) });
    await assert.rejects(model.route(request), failed);
  }
});

test('HTTP statuses, refusals, truncated output, malformed JSON and oversized responses fail 502 without fallback', async () => {
  const responses = [
    () => Response.json({ error: 'SECRET_UPSTREAM_BODY' }, { status: 401 }),
    () => Response.json({ error: 'SECRET_UPSTREAM_BODY' }, { status: 429 }),
    () => Response.json({ error: 'SECRET_UPSTREAM_BODY' }, { status: 503 }),
    () => completion(route, 'length'),
    () => completion(route, 'content_filter'),
    () => Response.json({ choices: [] }),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', refusal: 'No' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{invalid' } }] }),
    () => new Response('{invalid', { status: 200 }),
    () => new Response('x'.repeat(130 * 1024), { status: 200 }),
    () => { throw new Error('SECRET_NETWORK_ERROR'); },
  ];
  for (const response of responses) {
    let calls = 0;
    const model = createReasoner(env, { credential, fetch: async () => { calls++; return response(); } });
    await assert.rejects(model.route(request), error => {
      assert.ok(failed(error));
      assert.doesNotMatch(String(error), /SECRET_/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('HTTP diagnostics retain only status and a fixed internal code, never the Azure body', async () => {
  for (const status of [400, 401, 429, 503]) {
    const model = createReasoner(env, {
      credential, fetch: async () => Response.json({
        error: { code: 'SECRET_UPSTREAM_CODE', message: 'SECRET_UPSTREAM_MESSAGE' },
      }, { status }),
    });
    await assert.rejects(model.route(request), error => {
      assert.ok(error instanceof ModelError);
      assert.ok(failed(error));
      assert.deepEqual(error.cause, { code: 'MODEL_HTTP_ERROR', httpStatus: status });
      assert.doesNotMatch(JSON.stringify(error), /cause|httpStatus|SECRET_/);
      assert.doesNotMatch(String(error), /SECRET_/);
      return true;
    });
  }
});

test('token failure is sanitized and never sends an unauthenticated model request', async () => {
  let sends = 0;
  for (const getToken of [
    async () => null,
    async () => ({ token: '' }),
    async () => { throw new Error('secret credential stack'); },
  ]) {
    const model = createReasoner(env, {
      credential: { getToken }, fetch: async () => { sends++; return completion(); },
    });
    await assert.rejects(model.route(request), failed);
  }
  assert.equal(sends, 0);
});

test('one deadline bounds token acquisition, HTTP and response streams, including providers ignoring abort', async () => {
  let sends = 0;
  const never = new Promise<never>(() => undefined);
  const slowToken = createReasoner(env, {
    timeoutMs: 30, credential: { getToken: async () => never },
    fetch: async () => { sends++; return completion(); },
  });
  await assert.rejects(slowToken.route(request), failed);
  assert.equal(sends, 0);
  let httpSignal: AbortSignal | null | undefined;
  const slowHttp = createReasoner(env, {
    timeoutMs: 30, credential, fetch: async (_url, options) => {
      httpSignal = options?.signal;
      return never;
    },
  });
  await assert.rejects(slowHttp.route(request), failed);
  assert.equal(httpSignal?.aborted, true);
  let streamSignal: AbortSignal | null | undefined;
  const slowStream = createReasoner(env, {
    timeoutMs: 30, credential, fetch: async (_url, options) => {
      streamSignal = options?.signal;
      return new Response(new ReadableStream({ start() {} }));
    },
  });
  await assert.rejects(slowStream.route(request), failed);
  assert.equal(streamSignal?.aborted, true);
});

test('real reasoner pipeline returns explicit HTTP failure, bypasses model only for guided:true and never forwards cookie', async t => {
  const store = createMemoryStore();
  let calls = 0;
  let failModel = true;
  const model = createReasoner(env, {
    credential,
    fetch: async (_url, options) => {
      calls++;
      assert.equal(new Headers(options?.headers).get('cookie'), null);
      return failModel ? Response.json({ error: 'secret Azure detail' }, { status: 500 }) : completion();
    },
  });
  const key = 'test-only-synthetic-browser-key';
  const server = createApp({ env: { DEMO_ACCESS_KEY: key }, store, model }).listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const anonymous = await fetch(`${origin}/api/session`);
  let cookie = anonymous.headers.get('set-cookie')!.split(';')[0]!;
  let csrf = (await anonymous.json()).csrfToken as string;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const login = await post('/api/login', { accessKey: key });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  csrf = (await login.json()).csrfToken;
  const failure = await post('/api/chat', request);
  assert.equal(failure.status, 502);
  assert.equal((await failure.json()).error.code, 'MODEL_FAILED');
  assert.equal((await store.read()).actions.length, 0);
  assert.equal((await store.read()).audit.length, 0);
  const guided = await post('/api/chat', { ...request, guided: true });
  assert.equal(guided.status, 200);
  const guidedWorkspace = await guided.json();
  assert.equal(guidedWorkspace.model, 'guided');
  assert.equal(guidedWorkspace.intent, 'lesson');
  assert.equal(calls, 1);
  failModel = false;
  const live = await post('/api/chat', request);
  assert.equal(live.status, 200);
  const liveWorkspace = await live.json();
  assert.equal(liveWorkspace.model, 'azure-openai');
  assert.match(liveWorkspace.modelNotice, /gpt-5\.4-mini/);
  assert.equal(liveWorkspace.intent, 'lesson');
  assert.deepEqual(liveWorkspace.evidence, guidedWorkspace.evidence);
  assert.deepEqual(liveWorkspace.widgets, guidedWorkspace.widgets);
  assert.equal((await store.read()).outbox.length, 0);
  assert.equal(calls, 2);
});
