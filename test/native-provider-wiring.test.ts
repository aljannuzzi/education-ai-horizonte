import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSemanticMcpServer } from '../server/mcp.js';
import { createEducationAgents } from '../server/agents.js';
import { FabricError } from '../server/fabric.js';
import type { DataProvider } from '../server/data-provider.js';

test('MCP discovery and execution use the configured native provider rather than local data', async t => {
  const calls: string[] = [];
  const provider: DataProvider = {
    kind: 'fabric',
    async listClasses() { calls.push('classes'); return { source: 'fabric', answer: 'Native classes' }; },
    async describeOntology() { calls.push('ontology'); return { source: 'fabric', answer: 'Native bindings' }; },
    async executeSkill(skillId, classId) {
      calls.push(`${skillId}:${classId}`);
      throw new FabricError('AUTH_FAILED');
    },
  };
  const server = createSemanticMcpServer({ env: {}, dataProvider: provider });
  const client = new Client({ name: 'native-wiring-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { try { await client.close(); } finally { await server.close(); } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const classes = await client.callTool({ name: 'list_classes', arguments: {} });
  assert.equal(classes.structuredContent?.source, 'fabric');
  const ontology = await client.callTool({ name: 'describe_ontology', arguments: {} });
  assert.equal(ontology.structuredContent?.source, 'fabric');
  const unavailable = await client.callTool({
    name: 'execute_skill', arguments: { skillId: 'reconcile-diary', classId: 'class-7a' },
  });
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable), /FABRIC_AUTH_FAILED/);
  assert.doesNotMatch(JSON.stringify(unavailable), /Marina Costa|a-water/);
  assert.deepEqual(calls, ['classes', 'ontology', 'reconcile-diary:class-7a']);
});

test('specialists consume native query context and do not invent source-record identifiers', async () => {
  let received = false;
  const provider: DataProvider = {
    kind: 'fabric',
    async listClasses() { throw new Error('Not used'); },
    async describeOntology() { throw new Error('Not used'); },
    async executeSkill(skillId, classId) {
      assert.equal(skillId, 'reconcile-diary');
      assert.equal(classId, 'class-7a');
      return { source: 'fabric', answer: 'Native source evidence marker', nativeOntology: { status: 'unverified' } };
    },
  };
  const agents = createEducationAgents({
    AZURE_OPENAI_ENDPOINT: 'https://synthetic-test.openai.azure.com/',
  }, {
    dataProvider: provider,
    credential: { async getToken() { return { token: 'synthetic-test-token' }; } },
    fetch: async (_url, init) => {
      assert.equal(typeof init?.body, 'string');
      assert.match(String(init?.body), /Native source evidence marker/);
      assert.doesNotMatch(String(init?.body), /Marina Costa|horizonte_diary/);
      received = true;
      return Response.json({
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({
            summary: 'Confira a evidência antes de registrar.',
            suggestions: ['Revise a dependência de calendário.'],
            evidenceIds: ['fabric-query:reconcile-diary:class-7a'],
            requiresTeacherReview: true,
          }) },
        }],
      });
    },
  });
  const result = await agents.invoke({ agentId: 'teacher-support', classId: 'class-7a', request: 'Ajude na triagem.' });
  assert.equal(received, true);
  assert.equal(result.evidenceReferenceKind, 'native-query');
  assert.ok(Array.isArray(result.path) && result.path.includes('Fabric Data Agent'));
});
