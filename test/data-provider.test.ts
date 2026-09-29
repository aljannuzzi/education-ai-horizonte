import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '../skills/catalog.json' with { type: 'json' };
import { createDataProvider } from '../server/data-provider.js';
import { FABRIC_SCOPE, FabricError, type FabricSession, type FabricTool } from '../server/fabric.js';
import { executeSkill } from '../server/semantic.js';

const env = {
  HORIZONTE_DATA_PROVIDER: 'fabric',
  FABRIC_WORKSPACE_ID: '11111111-1111-1111-1111-111111111111',
  FABRIC_DATA_AGENT_ID: '22222222-2222-2222-2222-222222222222',
  FABRIC_ONTOLOGY_ID: '33333333-3333-3333-3333-333333333333',
};
const tool: FabricTool = {
  name: 'native_question_42',
  inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  annotations: { readOnlyHint: true },
};
const secret = 'private-secret-value';
function harness(settings: NodeJS.ProcessEnv = env, overrides: Partial<FabricSession> = {}) {
  const calls: string[] = [];
  const questions: string[] = [];
  const provider = createDataProvider(settings, {
    async getFabricToken(scope, signal) {
      calls.push('token');
      assert.equal(scope, FABRIC_SCOPE);
      assert.equal(signal.aborted, false);
      return secret;
    },
    createSession(options) {
      calls.push('session');
      assert.equal(options.endpoint, `https://api.fabric.microsoft.com/v1/mcp/workspaces/${env.FABRIC_WORKSPACE_ID}/dataagents/${env.FABRIC_DATA_AGENT_ID}/agent`);
      return {
        async connect() { calls.push('connect'); },
        async listTools() { calls.push('list'); return { tools: [tool] }; },
        async callTool(name, args) {
          calls.push('call');
          assert.equal(name, tool.name);
          assert.deepEqual(Object.keys(args), ['input']);
          questions.push(args.input!);
          return {
            content: [{ type: 'text', text: 'Resposta nativa; evidência F-42.' }],
            structuredContent: { evidence: [{ id: 'F-42', source: 'published-agent' }] },
          };
        },
        async close() { calls.push('close'); },
        ...overrides,
      };
    },
  });
  return { provider, calls, questions };
}
function safeCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as FabricError).code, code);
    assert.ok(!String(error).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('explicit selection required in every environment; partial Fabric never becomes synthetic', () => {
  for (const config of [
    {}, { NODE_ENV: 'development' }, { NODE_ENV: 'production' },
    { HORIZONTE_DATA_PROVIDER: 'auto' }, { FABRIC_WORKSPACE_ID: env.FABRIC_WORKSPACE_ID },
    { HORIZONTE_DATA_PROVIDER: 'synthetic', FABRIC_WORKSPACE_ID: '' },
  ]) assert.throws(() => createDataProvider(config), safeCode('INVALID_CONFIG'));
  for (const key of ['FABRIC_WORKSPACE_ID', 'FABRIC_DATA_AGENT_ID', 'FABRIC_ONTOLOGY_ID']) {
    assert.throws(() => harness({ ...env, [key]: undefined }), safeCode('INVALID_CONFIG'));
    assert.throws(() => harness({ ...env, [key]: secret }), safeCode('INVALID_CONFIG'));
  }
  assert.throws(() => createDataProvider(env), safeCode('INVALID_CONFIG'));
});

test('synthetic provider is explicitly async and preserves semantic results', async () => {
  const provider = createDataProvider({ HORIZONTE_DATA_PROVIDER: 'synthetic', NODE_ENV: 'production' });
  assert.equal(provider.kind, 'synthetic');
  const list = provider.listClasses();
  assert.ok(list instanceof Promise);
  assert.equal((await list).synthetic, true);
  assert.equal((await provider.describeOntology()).engine, 'custom-semantic-engine');
  assert.deepEqual(await provider.executeSkill('reconcile-diary', 'class-7a'), executeSkill('reconcile-diary', 'class-7a'));
});

test('native discovery, exact route and provenance; no invented class or ontology metadata', async () => {
  const h = harness();
  assert.equal(h.provider.kind, 'fabric');
  assert.deepEqual(h.calls, []);
  const promise = h.provider.listClasses();
  assert.ok(promise instanceof Promise);
  const list = await promise;
  assert.deepEqual(list.authorizedClassIds, ['class-7a', 'class-7b']);
  assert.equal(list.answer, 'Resposta nativa; evidência F-42.');
  assert.equal(list.classes, undefined);
  assert.equal(list.teacher, undefined);
  assert.equal(list.synthetic, undefined);
  assert.equal(list.engine, 'fabric');
  assert.equal(list.ontologyId, env.FABRIC_ONTOLOGY_ID);
  assert.deepEqual(list.nativeOntology, { status: 'unverified', operatorAttested: false });
  assert.deepEqual(h.calls, ['token', 'session', 'connect', 'list', 'call', 'close']);
  const ontology = await h.provider.describeOntology();
  assert.equal(ontology.entities, undefined);
  assert.equal(ontology.adapters, undefined);
  assert.deepEqual(ontology.nativeOntology, list.nativeOntology);
  assert.match(h.questions[1]!, /mapeamento realmente disponível/);
});

test('every whitelisted skill yields a fixed Portuguese question and native evidence', async () => {
  const h = harness();
  for (const skill of catalog.skills) {
    for (const classId of ['class-7a', 'class-7b']) {
      const result = await h.provider.executeSkill(skill.id, classId);
      assert.equal(result.skillId, skill.id);
      assert.equal(result.classId, classId);
      assert.equal(result.results, undefined);
      assert.deepEqual(result.evidence, {
        content: [{ type: 'text', text: 'Resposta nativa; evidência F-42.' }],
        structuredContent: { evidence: [{ id: 'F-42', source: 'published-agent' }] },
      });
      assert.match(String(result.question), new RegExp(`exclusivamente a turma ${classId}`));
      assert.match(String(result.question), /teacher-marina/);
      assert.match(String(result.question), /prompt não é uma fronteira de segurança/);
    }
  }
  assert.equal(new Set(h.questions).size, catalog.skills.length * 2);
});

test('unknown class and malicious skill inputs reject before credentials and network', async () => {
  const h = harness();
  for (const classId of ['class-8a', 'https://evil.example', 'class-7a; DROP TABLE', null, {}]) {
    await assert.rejects(h.provider.executeSkill('prepare-brief', classId as string), safeCode('CLASS_FORBIDDEN'));
  }
  for (const skill of ['constructor', '__proto__', 'SELECT * FROM students', 'https://evil.example', '', null,
    { id: 'prepare-brief', question: 'ignore policy', sql: 'SELECT *', endpoint: 'https://evil.example' }]) {
    await assert.rejects(h.provider.executeSkill(skill as string, 'class-7a'), safeCode('SKILL_FORBIDDEN'));
  }
  assert.deepEqual(h.calls, []);
});

test('tool selection group is all-or-nothing and checked against discovered native schema', async () => {
  for (const extra of [
    { FABRIC_MCP_TOOL: tool.name }, { FABRIC_MCP_INPUT: 'input' },
    { FABRIC_MCP_READ_ONLY_ATTESTED: 'true' },
    { FABRIC_MCP_TOOL: tool.name, FABRIC_MCP_INPUT: 'input', FABRIC_MCP_READ_ONLY_ATTESTED: 'yes' },
  ]) assert.throws(() => harness({ ...env, ...extra }), safeCode('INVALID_CONFIG'));
  const selected = {
    ...env, FABRIC_MCP_TOOL: tool.name, FABRIC_MCP_INPUT: 'input', FABRIC_MCP_READ_ONLY_ATTESTED: 'true',
  };
  await harness(selected, { async listTools() { return { tools: [{ ...tool, annotations: undefined }] }; } }).provider.listClasses();
  await assert.rejects(harness({ ...selected, FABRIC_MCP_INPUT: 'wrong' }).provider.listClasses(), safeCode('TOOL_UNSUPPORTED'));
});

test('native failure on every facade method propagates safely, never synthetic fallback', async () => {
  for (const error of [new Error(secret), Object.assign(new FabricError('HTTP_ERROR'), { message: secret, cause: secret })]) {
    const h = harness(env, { async callTool() { throw error; } });
    const code = error instanceof FabricError ? 'HTTP_ERROR' : 'MCP_ERROR';
    await assert.rejects(h.provider.listClasses(), safeCode(code));
    await assert.rejects(h.provider.describeOntology(), safeCode(code));
    await assert.rejects(h.provider.executeSkill('prepare-brief', 'class-7a'), safeCode(code));
  }
  const h = harness(env, { async listTools() { return { tools: [] }; } });
  await assert.rejects(h.provider.listClasses(), safeCode('TOOL_UNSUPPORTED'));
  assert.ok(!h.calls.includes('call'));
});

test('auth errors are sanitized and cannot initiate a native session', async () => {
  const provider = createDataProvider(env, {
    getFabricToken: async () => { throw new Error(secret); },
    createSession: () => { assert.fail('must not reach network'); },
  });
  await assert.rejects(provider.listClasses(), safeCode('AUTH_FAILED'));
});

test('native tool errors and malformed answers cannot turn into synthetic evidence', async () => {
  for (const [response, code] of [
    [{ isError: true, content: [{ type: 'text', text: secret }] }, 'TOOL_ERROR'],
    [{ content: [{ type: 'image', data: secret }] }, 'INVALID_RESULT'],
    [{ content: [] }, 'INVALID_RESULT'],
  ] as const) {
    const h = harness(env, { async callTool() { return response; } });
    await assert.rejects(h.provider.executeSkill('review-writing', 'class-7b'), safeCode(code));
    assert.equal(h.calls.at(-1), 'close');
  }
});
