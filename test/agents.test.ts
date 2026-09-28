import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRegistry, createEducationAgents } from '../server/agents.js';
import { MODEL_SCOPE } from '../server/llm.js';
import { classes, executeSkill } from '../server/semantic.js';

const env = { AZURE_OPENAI_ENDPOINT: 'https://education-test.openai.azure.com/' };
const input = { agentId: 'teacher-support' as const, classId: classes[0]!.id, request: 'Sugira apoio pedagógico.' };
const envelope = (value: unknown) => Response.json({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
});
const output = (ids: string[]) => ({
  summary: 'Revisar as evidências com a docente.',
  suggestions: ['Discutir estratégias de apoio.'],
  evidenceIds: ids,
  requiresTeacherReview: true,
});

test('both reference agents call Azure with authorized deterministic context and strict output', async () => {
  for (const agent of agentRegistry) {
    for (const classroom of classes) {
      const expected = executeSkill(agent.skillId, classroom.id);
      const ids = expected.results.map(row => row.evidenceId);
      let calls = 0;
      let tokens = 0;
      const agents = createEducationAgents(env, {
        credential: { async getToken(scope) {
          tokens++;
          assert.equal(scope, MODEL_SCOPE);
          return { token: 'test-token' };
        } },
        fetch: async (url, init) => {
          calls++;
          assert.equal(new URL(String(url)).hostname, 'education-test.openai.azure.com');
          assert.equal(init?.method, 'POST');
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
          const body = JSON.parse(String(init?.body));
          const supplied = JSON.parse(body.messages[1].content);
          assert.deepEqual(supplied.context, expected);
          assert.deepEqual(supplied.evidenceIds, ids);
          assert.equal(supplied.request, input.request);
          assert.equal(body.response_format.json_schema.strict, true);
          assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
          return envelope(output(ids));
        },
      });
      const result = await agents.invoke({ ...input, agentId: agent.agentId, classId: classroom.id });
      assert.deepEqual(result.response, output(ids));
      assert.deepEqual(result.context, expected);
      assert.deepEqual(result.path, ['Copilot nativo', 'MCP', agent.skillId, 'ontologia sintética', 'azure-openai', agent.agentId]);
      assert.deepEqual(result.agent, { ...agent, referenceOnly: true });
      assert.equal(result.readOnly, true);
      assert.equal(result.syntheticConnectors, true);
      assert.equal(calls, 1);
      assert.equal(tokens, 1);
      assert.ok(expected.results.every(row => row.provenance.classId === classroom.id));
    }
  }
});

test('missing configuration is explicit and forbidden classes and strict inputs never access Azure', async () => {
  let calls = 0;
  const options = {
    credential: { async getToken() { calls++; return { token: 'test' }; } },
    fetch: (async () => { calls++; throw new Error('Unexpected network'); }) as typeof fetch,
  };
  await assert.rejects(createEducationAgents({}, options).invoke(input), { code: 'AGENT_NOT_CONFIGURED' });
  const agents = createEducationAgents(env, options);
  await assert.rejects(agents.invoke({ ...input, classId: 'class-foreign' }), { code: 'CLASS_FORBIDDEN' });
  for (const invalid of [
    { ...input, agentId: 'unknown' }, { ...input, request: '' },
    { ...input, request: ' ' }, { ...input, request: 'x'.repeat(8001) },
    { ...input, request: 7 }, { ...input, classId: 'https://example.invalid' },
    ...['url', 'unknown', '__proto__', 'constructor'].map(key => ({ ...input, [key]: 'https://example.invalid' })),
  ]) {
    await assert.rejects(agents.invoke(invalid as typeof input));
  }
  assert.equal(calls, 0);
});

test('invalid evidence, cross-class evidence, unknown fields, review false and numeric text fail closed', async () => {
  for (const agent of agentRegistry) {
    const ids = executeSkill(agent.skillId, classes[0]!.id).results.map(row => row.evidenceId);
    const foreign = executeSkill(agent.skillId, classes[1]!.id).results.map(row => row.evidenceId);
    assert.ok(foreign.some(id => !ids.includes(id)));
    for (const response of [
      { ...output(ids), evidenceIds: ['unknown-evidence'] },
      { ...output(ids), evidenceIds: [foreign.find(id => !ids.includes(id))!] },
      { ...output(ids), evidenceIds: [] },
      { ...output(ids), unexpected: true },
      { ...output(ids), requiresTeacherReview: false },
      { ...output(ids), summary: 'Há 3 pendências.' },
      { ...output(ids), suggestions: ['Acertos de 50%.'] },
      { ...output(ids), summary: 42 },
      { ...output(ids), suggestions: [] },
    ]) {
      let calls = 0;
      const agents = createEducationAgents(env, {
        credential: { async getToken() { return { token: 'test' }; } },
        fetch: async () => { calls++; return envelope(response); },
      });
      await assert.rejects(agents.invoke({ ...input, agentId: agent.agentId }), { code: 'AGENT_INVALID_RESPONSE' });
      assert.equal(calls, 1);
    }
  }
});

test('Azure HTTP errors, malformed JSON and deadline failures never fall back', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const agents = createEducationAgents(env, {
      credential: { async getToken() { return { token: 'test' }; } },
      fetch: async () => { calls++; return new Response('upstream failure', { status }); },
    });
    await assert.rejects(agents.invoke(input), { code: 'MODEL_FAILED' });
    assert.equal(calls, 1);
  }
  await assert.rejects(createEducationAgents(env, {
    credential: { async getToken() { return { token: 'test' }; } },
    fetch: async () => new Response('not JSON'),
  }).invoke(input), { code: 'MODEL_FAILED' });
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const agents = createEducationAgents(env, {
    timeoutMs: 20,
    credential: { async getToken() { return { token: 'test' }; } },
    fetch: async (_url, init) => {
      calls++;
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(agents.invoke(input), { code: 'MODEL_FAILED' });
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});
