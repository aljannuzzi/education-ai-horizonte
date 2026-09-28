import { createProvisionCredential } from '../fabric/auth.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { buildArtifacts } from '../fabric/model.mjs';
import { recoveryState, eligibleCapacity } from '../fabric/provision-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://api.fabric.microsoft.com/v1';
const marker = 'education-ai-horizonte synthetic-only managed deployment';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
let capacityId;
let authMode = 'azure-cli';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') continue;
  if (args[i] === '--capacity' && uuid.test(args[i + 1] ?? '')) capacityId = args[++i];
  else if (args[i] === '--auth' && ['azure-cli', 'service-principal'].includes(args[i + 1])) authMode = args[++i];
  else throw new Error('Usage: node scripts\\fabric-provision.mjs [--apply --capacity GUID] [--auth azure-cli|service-principal]');
}
const evidence = {
  checkedAt: new Date().toISOString(), provider: 'fabric', apply, authMode,
  status: 'checking', resources: {}, operations: [], capacities: [],
  nativeOntology: 'unverified', nativeGraph: 'unverified', nativeDataAgent: 'unverified',
};
const credential = createProvisionCredential(authMode);
const output = resolve(root, 'fabric', apply ? 'deployment.json' : 'preflight.json');
await mkdir(dirname(output), { recursive: true });
let unresolved = false;
if (apply) {
  try {
    const previous = recoveryState(JSON.parse(await readFile(output, 'utf8')));
    evidence.resources = previous.resources;
    evidence.operations = previous.operations;
    unresolved = previous.unresolved;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('InvalidDeploymentState: existing state was preserved; inspect it before retrying.');
      process.exit(1);
    }
  }
}
const persist = () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? value : 'FabricRequestFailed';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function safeUrl(path) {
  const url = new URL(path.startsWith('https:') ? path : `${api}${path}`);
  if (url.origin !== 'https://api.fabric.microsoft.com' || !url.pathname.startsWith('/v1/')
    || url.username || url.password || url.hash) throw new Error('UnsafeFabricEndpoint');
  return url;
}
async function request(path, method = 'GET', body) {
  const token = await credential.getToken('https://api.fabric.microsoft.com/.default');
  const response = await fetch(safeUrl(path), {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  const text = await response.text();
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('InvalidFabricResponse'); }
  if (!response.ok) {
    evidence.failure = { httpStatus: response.status, errorCode: safeCode(data.errorCode ?? data.error?.code) };
    throw new Error(evidence.failure.errorCode);
  }
  return { data, status: response.status, location: response.headers.get('location'),
    retry: Math.max(1, Math.min(120, Number(response.headers.get('retry-after')) || 5)) * 1000 };
}
async function collection(path) {
  const items = [];
  for (let pages = 0; path && pages < 100; pages++) {
    const { data } = await request(path);
    if (!Array.isArray(data.value)) throw new Error('InvalidFabricCollection');
    items.push(...data.value);
    path = data.continuationUri;
    if (!path) return items;
  }
  throw new Error('PaginationLimit');
}
async function mutation(path, body) {
  const response = await request(path, 'POST', body);
  if (response.status !== 202) return response.data;
  if (!response.location) throw new Error('MissingOperationLocation');
  const location = safeUrl(response.location).href;
  evidence.operations.push({ location, status: 'pending' });
  await persist();
  const operation = evidence.operations.at(-1);
  const deadline = Date.now() + 12 * 60_000;
  let retry = response.retry;
  while (Date.now() < deadline) {
    await sleep(retry);
    const current = await request(location);
    retry = current.retry;
    operation.status = current.data.status;
    await persist();
    if (current.data.status === 'Succeeded') return (await request(`${location}/result`)).data;
    if (['Failed', 'Cancelled'].includes(current.data.status)) throw new Error('FabricOperationFailed');
  }
  throw new Error('OperationStillRunningInspectBeforeRetry');
}
async function ensureItem(workspaceId, kind, displayName, body = {}) {
  const matches = (await collection(`/workspaces/${workspaceId}/items`))
    .filter(item => item.displayName === displayName);
  if (matches.length > 1 || (matches[0] && (matches[0].description !== marker || matches[0].type !== kind))) {
    throw new Error('UnownedItemNameCollision');
  }
  if (matches[0]) return matches[0];
  return mutation(`/workspaces/${workspaceId}/${{
    Lakehouse: 'lakehouses', Notebook: 'notebooks', Ontology: 'ontologies', DataAgent: 'dataAgents',
  }[kind]}`, { displayName, description: marker, ...body });
}
try {
  if (unresolved) throw new Error('UnresolvedOperationInspectBeforeRetry');
  const capacities = await collection('/capacities');
  evidence.capacities = capacities.map(({ id, sku, state, region }) => ({ id, sku, state, region }));
  const eligible = capacities.filter(eligibleCapacity);
  const chosen = capacityId ? eligible.find(c => c.id.toLowerCase() === capacityId.toLowerCase()) : eligible.length === 1 ? eligible[0] : undefined;
  if (!chosen) throw new Error(capacityId ? 'SelectedCapacityNotEligibleOrNotVisible'
    : eligible.length ? 'ExplicitCapacitySelectionRequired' : 'NoEligibleFabricCapacityVisible');
  evidence.capacityId = chosen.id;
  evidence.status = 'preflight-passed';
  await persist();
  if (apply) {
    const matches = (await collection('/workspaces')).filter(w => w.displayName === 'Horizonte Education');
    if (matches.length > 1 || (matches[0] && matches[0].description !== marker)) throw new Error('UnownedWorkspaceNameCollision');
    const workspace = matches[0] ?? await mutation('/workspaces', {
      displayName: 'Horizonte Education', description: marker, capacityId: chosen.id,
    });
    if (!uuid.test(workspace.id)) throw new Error('InvalidWorkspaceResponse');
    evidence.resources.workspaceId = workspace.id;
    await persist();
    const actual = (await request(`/workspaces/${workspace.id}`)).data;
    if (actual.capacityId !== chosen.id) throw new Error('WorkspaceCapacityMismatch');
    const lakehouse = await ensureItem(workspace.id, 'Lakehouse', 'HorizonteEducationLakehouse',
      { creationPayload: { enableSchemas: true } });
    evidence.resources.lakehouseId = lakehouse.id;
    await persist();
    const dataset = JSON.parse(await readFile(resolve(root, 'ontology', 'dataset.json'), 'utf8'));
    const artifacts = buildArtifacts(dataset, workspace.id, lakehouse.id);
    const generated = resolve(root, 'fabric', 'generated');
    await mkdir(generated, { recursive: true });
    for (const [name, content] of [
      ['ontology-definition.json', artifacts.ontologyDefinition],
      ['notebook-definition.json', artifacts.notebookDefinition],
      ['manifest.json', artifacts.manifest],
    ]) await writeFile(resolve(generated, name), JSON.stringify(content, null, 2) + '\n', 'utf8');
    const notebook = await ensureItem(workspace.id, 'Notebook', 'HorizonteEducationLoad',
      { definition: artifacts.notebookDefinition });
    evidence.resources.notebookId = notebook.id;
    evidence.status = 'notebook-created-execution-required';
    await persist();
    // Execute deliberately outside provisioning: repeated provisioning must not overwrite managed tables.
    // The definition explicitly selects documented generation 1, never updates an empty generation 2 item.
    const ontology = await ensureItem(workspace.id, 'Ontology', 'EducationOntology',
      { definition: artifacts.ontologyDefinition });
    evidence.resources.ontologyId = ontology.id;
    evidence.ontologyGeneration = (await request(`/workspaces/${workspace.id}/ontologies/${ontology.id}`)).data.properties?.generation ?? 'not-returned';
    await persist();
    const agent = await ensureItem(workspace.id, 'DataAgent', 'TeacherEducationAgent');
    evidence.resources.dataAgentId = agent.id;
    evidence.endpoint = `${api}/mcp/workspaces/${workspace.id}/dataagents/${agent.id}/agent`;
    evidence.status = 'native-configuration-and-query-verification-required';
    evidence.next = 'Execute load notebook; verify bindings; initialize and query native graph; select Ontology in Data Agent portal; publish; test MCP. Empty agent is not a completed integration.';
  }
  await persist();
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.status = 'blocked';
  evidence.blocker = safeCode(error?.message);
  await persist();
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
}
