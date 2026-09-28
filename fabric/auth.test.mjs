import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureCliCredential, ClientSecretCredential } from '@azure/identity';
import { createProvisionCredential } from './auth.mjs';

const env = {
  FABRIC_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  FABRIC_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  FABRIC_CLIENT_SECRET: 'synthetic-unit-test-value',
};

test('provisioning explicitly selects CLI or dedicated service principal', () => {
  assert.ok(createProvisionCredential('azure-cli', {}) instanceof AzureCliCredential);
  assert.ok(createProvisionCredential('azure-cli', env) instanceof AzureCliCredential);
  assert.ok(createProvisionCredential('service-principal', env) instanceof ClientSecretCredential);
});

test('incomplete service-principal configuration never falls back to CLI', () => {
  for (const name of Object.keys(env)) {
    const partial = { ...env };
    delete partial[name];
    assert.throws(() => createProvisionCredential('service-principal', partial),
      /FabricServicePrincipalConfigurationRequired/);
  }
  assert.throws(() => createProvisionCredential('service-principal', { ...env, FABRIC_CLIENT_SECRET: ' ' }),
    /FabricServicePrincipalConfigurationRequired/);
  assert.throws(() => createProvisionCredential('managed-identity', env), /UnsupportedFabricAuthMode/);
});

test('invalid tenant configuration fails without disclosing credentials', () => {
  for (const mode of ['azure-cli', 'service-principal']) {
    assert.throws(() => createProvisionCredential(mode, { ...env, FABRIC_TENANT_ID: 'not-a-tenant' }),
      error => error.message === 'InvalidFabricTenant' && !error.message.includes(env.FABRIC_CLIENT_SECRET));
  }
});
