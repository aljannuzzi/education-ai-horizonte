const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resourceKeys = new Set(['workspaceId', 'lakehouseId', 'notebookId', 'ontologyId', 'dataAgentId']);

export function recoveryState(previous) {
  if (!previous || previous.provider !== 'fabric' || !previous.resources
    || !Array.isArray(previous.operations)) throw new Error('InvalidDeploymentState');
  const resources = {};
  for (const [key, value] of Object.entries(previous.resources)) {
    if (!resourceKeys.has(key) || typeof value !== 'string' || !uuid.test(value)) throw new Error('InvalidDeploymentState');
    resources[key] = value;
  }
  const operations = previous.operations.map(operation => {
    const url = new URL(operation.location);
    if (url.origin !== 'https://api.fabric.microsoft.com'
      || !/^\/v1\/operations\/[0-9a-f-]{36}$/i.test(url.pathname)
      || url.search || url.hash || url.username || url.password
      || typeof operation.status !== 'string') throw new Error('InvalidDeploymentState');
    return { location: url.href, status: operation.status };
  });
  return { resources, operations,
    unresolved: operations.some(operation => !['Succeeded', 'Failed', 'Cancelled'].includes(operation.status)) };
}

export function eligibleCapacity(capacity) {
  return capacity.state === 'Active' && /^(F([2-9]|[1-9][0-9]+)|P[1-9][0-9]*)$/.test(capacity.sku);
}
