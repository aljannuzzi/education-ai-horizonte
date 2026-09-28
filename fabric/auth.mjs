import { AzureCliCredential, ClientSecretCredential } from '@azure/identity';

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createProvisionCredential(mode, env = process.env) {
  const tenant = env.FABRIC_TENANT_ID;
  if (tenant !== undefined && !guid.test(tenant)) throw new Error('InvalidFabricTenant');
  if (mode === 'azure-cli') {
    return new AzureCliCredential({ processTimeoutInMs: 30_000, ...(tenant ? { tenantId: tenant } : {}) });
  }
  if (mode !== 'service-principal') throw new Error('UnsupportedFabricAuthMode');
  if (!tenant || !guid.test(env.FABRIC_CLIENT_ID ?? '')
    || typeof env.FABRIC_CLIENT_SECRET !== 'string' || !env.FABRIC_CLIENT_SECRET.trim()) {
    throw new Error('FabricServicePrincipalConfigurationRequired');
  }
  return new ClientSecretCredential(tenant, env.FABRIC_CLIENT_ID, env.FABRIC_CLIENT_SECRET);
}
