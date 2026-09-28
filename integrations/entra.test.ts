import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createEntraAuth, EntraAuthError, type EntraAuthCode } from './entra.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const oid = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const env: Record<string, string | undefined> = {
  MCP_ENTRA_TENANT_ID: tenantId,
  MCP_ENTRA_CLIENT_ID: clientId,
  MCP_ENTRA_ALLOWED_OIDS: oid,
  MCP_ENTRA_SCOPE: 'access_as_user',
  PUBLIC_ORIGIN: 'https://app.example',
};
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
const remoteRequests: string[] = [];

before(() => {
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    remoteRequests.push(url);
    assert.equal(url, `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
});
after(() => mock.restoreAll());

const auth = createEntraAuth(env, { keyResolver: async () => publicKey });
function claims(): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer, aud: clientId, tid: tenantId, oid, azp: clientId,
    ver: '2.0', scp: 'access_as_user', iat: now - 10, nbf: now - 10, exp: now + 300,
  };
}
async function sign(overrides: JWTPayload = {}, omit: string[] = []): Promise<string> {
  const payload = { ...claims(), ...overrides };
  for (const key of omit) delete payload[key];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key', typ: 'JWT' })
    .sign(privateKey);
}
function safeError(code: EntraAuthCode, status: number): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof EntraAuthError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('secret'));
    return true;
  };
}

test('valid delegated v2 access token returns only the allowed tenant/user identity', async () => {
  assert.equal(auth.configured, true);
  assert.deepEqual(await auth.authenticate(await sign()), { oid, tid: tenantId });
  assert.deepEqual(await auth.authenticate(await sign({ scp: 'openid access_as_user profile' })), {
    oid, tid: tenantId,
  });
});

test('nbf is optional; claims and signature are still required', async () => {
  assert.deepEqual(await auth.authenticate(await sign({}, ['nbf'])), { oid, tid: tenantId });
});

const invalidClaims: [string, JWTPayload][] = [
  ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ['future nbf', { nbf: Math.floor(Date.now() / 1000) + 600 }],
  ['future iat', { iat: Math.floor(Date.now() / 1000) + 600 }],
  ['wrong issuer', { iss: `https://login.microsoftonline.com/${otherId}/v2.0` }],
  ['common issuer', { iss: 'https://login.microsoftonline.com/common/v2.0' }],
  ['v1 issuer', { iss: `https://sts.windows.net/${tenantId}/` }],
  ['wrong audience', { aud: otherId }],
  ['scope URI is not audience', { aud: `api://${clientId}` }],
  ['wrong tenant', { tid: otherId }],
  ['non GUID tenant', { tid: 'common' }],
  ['wrong oid', { oid: otherId }],
  ['non GUID oid', { oid: 'someone@example.com' }],
  ['non string oid', { oid: [oid] }],
  ['wrong scope', { scp: 'User.Read' }],
  ['scope substring', { scp: 'not_access_as_user access_as_user_extra' }],
  ['scope URI is not scp', { scp: `api://${clientId}/access_as_user` }],
  ['non string scope', { scp: ['access_as_user'] }],
  ['wrong azp', { azp: otherId }],
  ['non string azp', { azp: [clientId] }],
  ['v1 version', { ver: '1.0' }],
  ['app identity even with scope', { idtyp: 'app', roles: ['access_as_user'] }],
  ['invalid exp type', { exp: 'secret' } as unknown as JWTPayload],
  ['invalid iat type', { iat: 'secret' } as unknown as JWTPayload],
  ['invalid nbf type', { nbf: 'secret' } as unknown as JWTPayload],
];
for (const [name, overrides] of invalidClaims) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(auth.authenticate(await sign(overrides)), safeError('invalid_token', 401));
  });
}

for (const claim of ['exp', 'iat', 'iss', 'aud', 'tid', 'oid', 'azp', 'ver', 'scp']) {
  test(`rejects missing ${claim}`, async () => {
    await assert.rejects(auth.authenticate(await sign({}, [claim])), safeError('invalid_token', 401));
  });
}
test('ID tokens and app-only roles cannot substitute for delegated scp', async () => {
  for (const overrides of [{ nonce: 'secret' }, { roles: ['access_as_user'], idtyp: 'app' }]) {
    await assert.rejects(auth.authenticate(await sign(overrides, ['scp'])), safeError('invalid_token', 401));
  }
});

test('tampered payload and signatures fail without leaking input', async () => {
  const token = await sign();
  const [header, payload, signature] = token.split('.');
  const alteredPayload = Buffer.from(JSON.stringify({ ...claims(), oid: otherId })).toString('base64url');
  const alteredSignature = `${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`;
  for (const bad of [`${header}.${alteredPayload}.${signature}`, `${header}.${payload}.${alteredSignature}`]) {
    await assert.rejects(auth.authenticate(bad), safeError('invalid_token', 401));
  }
});

test('rejects algorithms other than RS256, including unsigned tokens', async () => {
  const symmetric = new Uint8Array(32).fill(1);
  const hsToken = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256' }).sign(symmetric);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
  for (const token of [hsToken, unsigned]) {
    await assert.rejects(auth.authenticate(token), safeError('invalid_token', 401));
  }
});

test('bounded compact JWT syntax rejects secrets/headers before key resolution', async () => {
  let calls = 0;
  const isolated = createEntraAuth(env, { keyResolver: async () => { calls++; return publicKey; } });
  const valid = await sign();
  for (const bad of [
    '', 'secret', `Bearer ${valid}`, ` ${valid}`, `${valid}\n`, 'a.b.c=', 'a..b',
    'é.b.c', 'a.b.c.d', `${'a'.repeat(16_384)}.b.c`, null, undefined, {},
  ]) {
    await assert.rejects(isolated.authenticate(bad as string), safeError('invalid_token', 401));
  }
  assert.equal(calls, 0);
});

test('signed token size limit accepts exactly 16384 bytes and rejects 16385', async () => {
  let boundary: string | undefined;
  const payload = { ...claims(), pad: '' };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  // Base64url lengths skip one residue modulo four; vary the header too.
  for (const headerPad of ['', 'a', 'aa']) {
    const header = { alg: 'RS256', kid: 'boundary-key', pad: headerPad };
    const base = await new SignJWT(payload).setProtectedHeader(header).sign(privateKey);
    const overhead = base.length - Buffer.from(JSON.stringify(payload)).toString('base64url').length;
    for (let length = 11_000; length <= 13_000; length++) {
      if (overhead + Math.ceil((payloadBytes + length) * 4 / 3) !== 16_384) continue;
      boundary = await new SignJWT({ ...payload, pad: 'a'.repeat(length) })
        .setProtectedHeader(header).sign(privateKey);
      break;
    }
    if (boundary) break;
  }
  assert.ok(boundary, 'must construct a token exactly at the limit');
  assert.equal(Buffer.byteLength(boundary), 16_384);
  assert.deepEqual(await auth.authenticate(boundary), { oid, tid: tenantId });
  await assert.rejects(auth.authenticate(`${boundary}a`), safeError('invalid_token', 401));
});

test('no Entra configuration is disabled and cannot authenticate, even with an injected key', async () => {
  for (const empty of [{}, { PUBLIC_ORIGIN: 'https://app.example' }]) {
    const disabled = createEntraAuth(empty, { keyResolver: async () => publicKey });
    assert.equal(disabled.configured, false);
    assert.equal('challenge' in disabled, false);
    assert.equal('protectedResourceMetadata' in disabled, false);
    await assert.rejects(disabled.authenticate(await sign()), safeError('not_configured', 503));
  }
});

test('every missing, blank or malformed config value fails closed at creation', () => {
  for (const field of Object.keys(env)) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => createEntraAuth({ ...env, [field]: value }), safeError('invalid_configuration', 500));
    }
  }
  for (const field of Object.keys(env).filter((field) => field !== 'PUBLIC_ORIGIN')) {
    assert.throws(() => createEntraAuth({ [field]: '' }), safeError('invalid_configuration', 500));
    assert.throws(() => createEntraAuth({ ...env, [field]: 'secret' }), safeError('invalid_configuration', 500));
  }
  for (const list of [`${oid},`, `,${oid}`, `${oid},secret`, `${oid},,${otherId}`]) {
    assert.throws(() => createEntraAuth({ ...env, MCP_ENTRA_ALLOWED_OIDS: list }), safeError('invalid_configuration', 500));
  }
});

test('PUBLIC_ORIGIN requires HTTPS and only an origin, without credentials, query or fragment', () => {
  for (const value of [
    'http://app.example', 'https://', 'secret', 'https://user:secret@app.example',
    'https://app.example/path', 'https://app.example?secret', 'https://app.example#secret',
    'https://app.example?', 'https://app.example#', 'https://app.example\\evil',
  ]) {
    assert.throws(() => createEntraAuth({ ...env, PUBLIC_ORIGIN: value }), safeError('invalid_configuration', 500));
  }
});

test('GUID allowlist is parsed once, trimmed, and does not accept any other user', async () => {
  const snapshot = { ...env, MCP_ENTRA_ALLOWED_OIDS: ` ${oid}, ${otherId} ` };
  const isolated = createEntraAuth(snapshot, { keyResolver: async () => publicKey });
  snapshot.MCP_ENTRA_ALLOWED_OIDS = tenantId;
  assert.deepEqual(await isolated.authenticate(await sign({ oid: otherId })), { oid: otherId, tid: tenantId });
  await assert.rejects(isolated.authenticate(await sign({ oid: tenantId })), safeError('invalid_token', 401));
});

test('metadata/challenge use deployment origin and fixed tenant, never secrets or OIDs', () => {
  const configured = createEntraAuth({ ...env, PUBLIC_ORIGIN: 'https://app.example/' });
  assert.ok(configured.configured);
  assert.deepEqual(configured.protectedResourceMetadata, {
    resource: 'https://app.example/mcp',
    authorization_servers: [issuer],
    scopes_supported: [`api://${clientId}/access_as_user`],
    bearer_methods_supported: ['header'],
  });
  assert.equal(configured.challenge,
    `Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource/mcp", scope="api://${clientId}/access_as_user"`);
  const serialized = JSON.stringify(configured.protectedResourceMetadata);
  assert.ok(!serialized.includes(oid));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('registration_endpoint'));
  assert.ok(Object.isFrozen(configured.protectedResourceMetadata));
  assert.ok(Object.isFrozen(configured.protectedResourceMetadata.scopes_supported));
});

test('default remote JWKS resolver uses only deployment tenant and caches fetched keys (mock network)', async () => {
  const configured = createEntraAuth(env);
  const beforeCount = remoteRequests.length;
  const token = await sign();
  assert.deepEqual(await configured.authenticate(token), { oid, tid: tenantId });
  assert.deepEqual(await configured.authenticate(token), { oid, tid: tenantId });
  assert.equal(remoteRequests.length - beforeCount, 1);
});

test('resolver failure never falls back and does not expose underlying secrets', async () => {
  const unavailable = createEntraAuth(env, {
    keyResolver: async () => { throw new Error('secret resolver infrastructure detail'); },
  });
  await assert.rejects(unavailable.authenticate(await sign()), (error: unknown) => {
    safeError('invalid_token', 401)(error);
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid access token.');
    assert.ok(!error.stack?.includes('infrastructure'));
    return true;
  });
});
