import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { generateKeyPair, SignJWT } from 'jose';
import type { Server } from 'node:http';
import { mountMcp } from '../server/mcp.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const keys = await generateKeyPair('RS256');
let server: Server;
let origin: string;
before(async () => {
  const app = express();
  mountMcp(app, {
    MCP_ENTRA_TENANT_ID: tenant, MCP_ENTRA_CLIENT_ID: client,
    MCP_ENTRA_ALLOWED_OIDS: user, MCP_ENTRA_SCOPE: 'access_as_user',
    PUBLIC_ORIGIN: 'https://education.example.test',
    MCP_ACCESS_KEY: 'legacy-diagnostic-key-must-not-bypass-oauth',
  }, { entraOptions: { keyResolver: async () => keys.publicKey } });
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const request = (token?: string) => fetch(`${origin}/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
test('native MCP publishes OAuth resource metadata and discovery challenge', async () => {
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  const data = await metadata.json();
  assert.equal(data.resource, 'https://education.example.test/mcp');
  const denied = await request();
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate')!, /resource_metadata=/);
});
test('native MCP rejects the legacy bearer key when Entra is enabled', async () => {
  const response = await request('legacy-diagnostic-key-must-not-bypass-oauth');
  assert.equal(response.status, 401);
});
test('native MCP accepts only an authorized delegated identity for tool discovery', async () => {
  for (let i = 0; i < 125; i++) {
    const unauthorized = await request();
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
  }
  const token = await new SignJWT({ ver: '2.0', tid: tenant, oid: user, scp: 'access_as_user', azp: client })
    .setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('5m')
    .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`).setAudience(client)
    .sign(keys.privateKey);
  const response = await request(token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.result.tools.some((tool: { name: string }) => tool.name === 'invoke_education_agent'));
});
