import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { ClientSecretCredential, OnBehalfOfCredential } from '@azure/identity';
import {
  createFabricTokenProvider,
  type FabricTokenProvider,
  type TokenCredential,
} from '../server/fabric-auth.js';
import { FABRIC_SCOPE, FabricError } from '../server/fabric.js';

const signal = () => new AbortController().signal;
const secret = 'synthetic-secret-do-not-reflect';
const clientEnv = (): NodeJS.ProcessEnv => ({
  FABRIC_AUTH_MODE: 'client-secret',
  FABRIC_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  FABRIC_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
  FABRIC_CLIENT_SECRET: secret,
});
const callback: FabricTokenProvider = async () => 'synthetic.token';
const credential: TokenCredential = { getToken: async () => ({ token: 'synthetic.token' }) };
const errorCode = (code: 'INVALID_CONFIG' | 'AUTH_FAILED' | 'CANCELLED') => (error: unknown) => {
  assert.ok(error instanceof FabricError);
  assert.equal(error.code, code);
  assert.equal(error.message, new FabricError(code).message);
  assert.equal(error.httpStatus, undefined);
  assert.equal('cause' in error, false);
  assert.equal(inspect(error).includes(secret), false);
  return true;
};

test('callback injection is lazy, exact-scope, forwards signal and does not cache tokens', async () => {
  let calls = 0;
  const abortSignal = signal();
  const provider = createFabricTokenProvider({}, {
    getFabricToken: async (scope, suppliedSignal) => {
      assert.equal(scope, FABRIC_SCOPE);
      assert.equal(suppliedSignal, abortSignal);
      return `synthetic.${++calls}`;
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(provider(`${FABRIC_SCOPE} `, abortSignal), errorCode('INVALID_CONFIG'));
  assert.equal(calls, 0);
  assert.equal(await provider(FABRIC_SCOPE, abortSignal), 'synthetic.1');
  assert.equal(await provider(FABRIC_SCOPE, abortSignal), 'synthetic.2');
});

test('credential injection preserves receiver, scope and abort signal', async () => {
  const abortSignal = signal();
  const injected: TokenCredential = {
    async getToken(scope, options) {
      assert.equal(this, injected);
      assert.equal(scope, FABRIC_SCOPE);
      assert.equal(options?.abortSignal, abortSignal);
      return { token: 'synthetic.token' };
    },
  };
  const provider = createFabricTokenProvider({ FABRIC_AUTH_MODE: 'token-provider' }, {
    credential: injected,
  });
  assert.equal(await provider(FABRIC_SCOPE, abortSignal), 'synthetic.token');
});

test('client-secret is explicit, lazy, and Azure credentials are structurally compatible', () => {
  assert.equal(typeof createFabricTokenProvider(clientEnv(), { getFabricToken: undefined }), 'function');
  const env = clientEnv();
  const credentials: TokenCredential[] = [
    new ClientSecretCredential(env.FABRIC_TENANT_ID!, env.FABRIC_CLIENT_ID!, secret),
    new OnBehalfOfCredential({
      tenantId: env.FABRIC_TENANT_ID!,
      clientId: env.FABRIC_CLIENT_ID!,
      clientSecret: secret,
      userAssertionToken: 'synthetic.user.assertion',
    }),
  ];
  for (const supplied of credentials) {
    assert.equal(typeof createFabricTokenProvider({}, { credential: supplied }), 'function');
  }
});

test('rejects missing, partial, blank and malformed auth configuration without network', () => {
  for (const env of [{}, { FABRIC_AUTH_MODE: 'token-provider' }]) {
    assert.throws(() => createFabricTokenProvider(env), errorCode('INVALID_CONFIG'));
  }
  for (const key of ['FABRIC_TENANT_ID', 'FABRIC_CLIENT_ID', 'FABRIC_CLIENT_SECRET']) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => createFabricTokenProvider({ ...clientEnv(), [key]: value }), errorCode('INVALID_CONFIG'));
    }
  }
  for (const key of ['FABRIC_TENANT_ID', 'FABRIC_CLIENT_ID']) {
    for (const value of [secret, 'organizations', 'common', ` ${clientEnv()[key]}`, `${clientEnv()[key]}\n`]) {
      assert.throws(() => createFabricTokenProvider({ ...clientEnv(), [key]: value }), errorCode('INVALID_CONFIG'));
    }
  }
  for (const mode of ['managed-identity', 'default', 'azure-cli', '', secret]) {
    assert.throws(() => createFabricTokenProvider({ FABRIC_AUTH_MODE: mode }, {
      getFabricToken: callback,
    }), errorCode('INVALID_CONFIG'));
  }
});

test('rejects conflicting config, dependency sources, static tokens and implicit client-secret', () => {
  assert.throws(() => createFabricTokenProvider({}, {
    credential, getFabricToken: callback,
  }), errorCode('INVALID_CONFIG'));
  for (const deps of [{ credential }, { getFabricToken: callback }]) {
    assert.throws(() => createFabricTokenProvider(clientEnv(), deps), errorCode('INVALID_CONFIG'));
    for (const mode of [undefined, 'token-provider']) {
      for (const key of ['FABRIC_TENANT_ID', 'FABRIC_CLIENT_ID', 'FABRIC_CLIENT_SECRET',
        'FABRIC_TOKEN', 'FABRIC_ACCESS_TOKEN']) {
        assert.throws(() => createFabricTokenProvider({
          FABRIC_AUTH_MODE: mode, [key]: '',
        }, deps), errorCode('INVALID_CONFIG'));
      }
    }
  }
  assert.throws(() => createFabricTokenProvider({
    ...clientEnv(), FABRIC_AUTH_MODE: undefined,
  }), errorCode('INVALID_CONFIG'));
});

test('pre-abort never invokes callback or credential and does not reflect abort reason', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error(secret));
  for (const deps of [
    { getFabricToken: async () => { calls++; return 'token'; } },
    { credential: { getToken: async () => { calls++; return { token: 'token' }; } } },
  ]) {
    await assert.rejects(createFabricTokenProvider({}, deps)(FABRIC_SCOPE, controller.signal), errorCode('CANCELLED'));
  }
  assert.equal(calls, 0);
});

test('in-flight abort rejects promptly even if either dependency ignores it', async () => {
  for (const kind of ['callback', 'credential']) {
    const controller = new AbortController();
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let fail!: (error: unknown) => void;
    const pending = new Promise<string>((_, reject) => { fail = reject; });
    const acquire: FabricTokenProvider = (scope, suppliedSignal) => {
      assert.equal(scope, FABRIC_SCOPE);
      assert.equal(suppliedSignal, controller.signal);
      start();
      return pending;
    };
    const provider = createFabricTokenProvider({}, kind === 'callback'
      ? { getFabricToken: acquire }
      : { credential: { getToken: async (scope, options) =>
        ({ token: await acquire(scope, options!.abortSignal!) }) } });
    const result = provider(FABRIC_SCOPE, controller.signal);
    await started;
    controller.abort(secret);
    await assert.rejects(result, errorCode('CANCELLED'));
    fail(new Error(secret));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('all dependency failures including malicious FabricErrors are reconstructed', async () => {
  const malicious = new FabricError('INVALID_CONFIG', 401);
  malicious.message = secret;
  malicious.stack = secret;
  Object.assign(malicious, { cause: new Error(secret), token: secret });
  for (const failure of [malicious, new Error(secret), secret, { token: secret }]) {
    for (const deps of [
      { getFabricToken: () => { throw failure; } },
      { credential: { getToken: () => { throw failure; } } },
      { getFabricToken: async () => { throw failure; } },
    ]) {
      await assert.rejects(createFabricTokenProvider({}, deps)(FABRIC_SCOPE, signal()), errorCode('AUTH_FAILED'));
    }
  }
  assert.throws(() => createFabricTokenProvider({}, {
    credential: { get getToken(): TokenCredential['getToken'] { throw malicious; } },
  }), errorCode('INVALID_CONFIG'));
});

test('invalid callback and credential tokens fail closed without reflecting contents', async () => {
  for (const token of ['', ' ', ' token', 'token\n', 'Bearer token', `token\r\n${secret}`, null, undefined, 42, {}]) {
    for (const deps of [
      { getFabricToken: async () => token as string },
      { credential: { getToken: async () => ({ token: token as string }) } },
    ]) {
      await assert.rejects(createFabricTokenProvider({}, deps)(FABRIC_SCOPE, signal()), errorCode('AUTH_FAILED'));
    }
  }
  await assert.rejects(createFabricTokenProvider({}, {
    credential: { getToken: async () => null },
  })(FABRIC_SCOPE, signal()), errorCode('AUTH_FAILED'));
});
