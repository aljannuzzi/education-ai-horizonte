import { AzureCliCredential } from '@azure/identity';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertModelSource, buildReportModel, buildReportDefinition, modelName, reportName, ownershipMarker } from '../fabric/report-model.mjs';
import { operationUrl } from '../fabric/provision-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.runtime', 'fabric-report-deployment.json');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') options.apply = true;
  else if (args[i] === '--verify-queries') options.verifyQueries = true;
  else if (['--workspace', '--lakehouse', '--tenant'].includes(args[i]) && uuid.test(args[i + 1] ?? '')) options[args[i].slice(2)] = args[++i];
  else throw new Error('Usage: node scripts\\fabric-publish-report.mjs --workspace GUID --lakehouse GUID --tenant GUID [--apply] [--verify-queries]');
}
if (!options.workspace || !options.lakehouse || !options.tenant) throw new Error('WorkspaceLakehouseTenantRequired');
if (options.verifyQueries && !options.apply) throw new Error('QueryVerificationRequiresApply');
const credential = new AzureCliCredential({ tenantId: options.tenant });
const api = 'https://api.fabric.microsoft.com/v1';
const base = `/workspaces/${options.workspace}`;
let state = { marker: ownershipMarker, workspaceId: options.workspace, lakehouseId: options.lakehouse, tenantId: options.tenant, resources: {}, operations: [] };
await mkdir(dirname(output), { recursive: true });
try {
  const previous = JSON.parse(await readFile(output, 'utf8'));
  if (previous.marker !== state.marker || previous.workspaceId !== state.workspaceId || previous.lakehouseId !== state.lakehouseId || previous.tenantId !== state.tenantId) throw new Error('DeploymentStateMismatch');
  state = previous;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const persist = () => writeFile(output, JSON.stringify(state, null, 2) + '\n');
const safeCode = value => typeof value === 'string' && /^[\w.-]{1,150}$/.test(value) ? value : 'FabricRequestFailed';
async function request(path, method = 'GET', body) {
  const url = new URL(path.startsWith('https:') ? path : api + path);
  if (url.origin !== 'https://api.fabric.microsoft.com' || !url.pathname.startsWith('/v1/') || url.username || url.password || url.hash) throw new Error('UnsafeFabricEndpoint');
  const token = await credential.getToken('https://api.fabric.microsoft.com/.default');
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`InvalidResponse${response.status}`); }
  if (!response.ok) {
    state.failure = { httpStatus: response.status, errorCode: safeCode(data.errorCode ?? data.error?.code), path: url.pathname };
    throw new Error(state.failure.errorCode);
  }
  return { data, status: response.status, location: response.headers.get('location'), operationId: response.headers.get('x-ms-operation-id'), retry: Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 2)) };
}
async function poll(operation) {
  const location = operationUrl(operation.location, operation.id);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const current = await request(location);
    operation.status = current.data.status;
    await persist();
    if (operation.status === 'Succeeded') return (await request(`${location}/result`)).data;
    if (['Failed', 'Cancelled'].includes(operation.status)) {
      state.failure = { errorCode: safeCode(current.data.error?.errorCode ?? current.data.error?.code), operationId: operation.id };
      throw new Error('FabricOperationFailed');
    }
    await new Promise(r => setTimeout(r, current.retry * 1000));
  }
  throw new Error('OperationStillRunningResumeSameCommand');
}
async function post(path, body, purpose) {
  const result = await request(path, 'POST', body);
  if (result.status !== 202) return result.data;
  const location = operationUrl(result.location, result.operationId);
  const operation = { id: location.split('/').at(-1), location, purpose, status: 'Running' };
  state.operations.push(operation);
  await persist();
  return poll(operation);
}
async function items() {
  const values = [];
  let path = `${base}/items`;
  for (let i = 0; path && i < 100; i++) {
    const { data } = await request(path);
    if (!Array.isArray(data.value)) throw new Error('InvalidItemCollection');
    values.push(...data.value);
    path = data.continuationUri;
  }
  if (path) throw new Error('PaginationLimit');
  return values;
}
async function ensure(type, displayName, collection, definition) {
  const matches = (await items()).filter(item => item.type === type && item.displayName.toLowerCase() === displayName.toLowerCase());
  if (matches.length > 1 || (matches[0] && matches[0].description !== ownershipMarker)) throw new Error('UnownedItemNameCollision');
  const item = matches[0] ?? await post(`${base}/${collection}`, { displayName, description: ownershipMarker, definition }, type);
  if (!uuid.test(item.id)) throw new Error('MissingCreatedItemId');
  state.resources[type] = item.id;
  await persist();
  return item.id;
}
try {
  delete state.failure;
  for (const operation of state.operations) {
    if (!['Succeeded', 'Failed', 'Cancelled'].includes(operation.status)) await poll(operation);
  }
  const lakehouse = (await request(`${base}/lakehouses/${options.lakehouse}`)).data;
  const endpoint = lakehouse.properties?.sqlEndpointProperties;
  if (!endpoint?.connectionString || !uuid.test(endpoint.id) || endpoint.provisioningStatus !== 'Success') throw new Error('SqlEndpointNotReady');
  // The endpoint ID is the SQL catalog used by Direct Lake, obtained from Get Lakehouse.
  const dataset = JSON.parse(await readFile(resolve(root, 'ontology', 'dataset.json'), 'utf8'));
  const model = buildReportModel(dataset, {
    workspaceId: options.workspace, lakehouseId: options.lakehouse,
    sqlEndpoint: endpoint.connectionString, sqlDatabase: endpoint.id,
  });
  state.status = 'generated';
  state.excludedEntities = model.excludedEntities;
  state.rowSecurity = 'No RLS configured; material table excluded entirely; native workspace permissions apply.';
  await persist();
  if (options.apply) {
    const modelId = await ensure('SemanticModel', modelName, 'semanticModels', model.definition);
    const modelResult = await post(`${base}/semanticModels/${modelId}/getDefinition`, undefined, 'verify-model');
    const modelParts = modelResult.definition?.parts;
    assertModelSource(modelParts, endpoint.connectionString, endpoint.id);
    const reportId = await ensure('Report', reportName, 'reports', buildReportDefinition(modelId));
    const reportResult = await post(`${base}/reports/${reportId}/getDefinition`, undefined, 'verify-report');
    const reportParts = reportResult.definition?.parts;
    if (!modelParts?.length || !reportParts?.length) throw new Error('DefinitionVerificationFailed');
    const modelText = modelParts.filter(p => p.path.endsWith('.tmdl'))
      .map(p => Buffer.from(p.payload, 'base64').toString()).join('\n');
    if (!modelText.includes('compatibilityLevel: 1604') || modelText.includes('horizonte_material')
      || !model.measures.every(([name]) => modelText.includes(`measure ${name} =`))
      || !model.entities.every(e => modelText.includes(`entityName: ${e.table}`))) throw new Error('SemanticModelDefinitionMismatch');
    const binding = reportParts.find(p => p.path === 'definition.pbir');
    if (!binding || !Buffer.from(binding.payload, 'base64').toString().includes(modelId)) throw new Error('ReportBindingMismatch');
    state.verification = { semanticModelDefinition: true, reportDefinition: true, reportBinding: true, queryExecution: 'not-tested' };
    state.urls = { report: `https://app.powerbi.com/groups/${options.workspace}/reports/${reportId}`, semanticModel: `https://app.powerbi.com/groups/${options.workspace}/datasets/${modelId}/details` };
    state.status = 'created-definitions-verified';
    if (options.verifyQueries) {
      const token = await credential.getToken('https://analysis.windows.net/powerbi/api/.default');
      const response = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${options.workspace}/datasets/${modelId}/executeQueries`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [{ query: 'EVALUATE ROW("Turmas", [Turmas], "AulasPlanejadas", [AulasPlanejadas], "EspacosIndisponiveis", [EspacosIndisponiveis], "PendenciasDiario", [PendenciasDiario], "RegistrosEvidencia", [RegistrosEvidencia], "DenominadorAvaliacao", [DenominadorAvaliacao])' }] }),
      });
      const result = await response.json();
      state.verification.queryHttpStatus = response.status;
      if (!response.ok || result.error || result.results?.some(r => r.error)) {
        state.verification.queryExecution = 'blocked';
        state.failure = { httpStatus: response.status, errorCode: safeCode(result.error?.code) };
        throw new Error('QueryVerificationFailed');
      }
      const row = result.results?.[0]?.tables?.[0]?.rows?.[0];
      const expected = {
        Turmas: new Set(dataset.classroom.map(r => r.id)).size,
        AulasPlanejadas: dataset.lesson.filter(r => r.status === 'planned').length,
        EspacosIndisponiveis: dataset.space.filter(r => r.status === 'unavailable').length,
        PendenciasDiario: dataset['diary-entry'].filter(r => !r.recorded && dataset.lesson.find(l => l.id === r.lessonId)?.status === 'taught').length,
        RegistrosEvidencia: dataset.evidence.length,
        DenominadorAvaliacao: dataset.evidence.filter(r => r.type === 'assessment').reduce((n, r) => n + r.assessed, 0),
      };
      if (!row || !Object.entries(expected).every(([name, value]) => row[`[${name}]`] === value)) throw new Error('QuerySyntheticBaselineMismatch');
      // Never persist response bodies, labels, token metadata or query content.
      state.verification.queryExecution = 'passed-synthetic-baseline';
      state.status = 'created-definitions-and-queries-verified';
    }
  }
  await persist();
  console.log(JSON.stringify({ status: state.status, runtimeFile: '.runtime\\fabric-report-deployment.json' }));
} catch (error) {
  state.status = 'blocked';
  state.blocker = safeCode(error.message);
  await persist();
  console.error(JSON.stringify({ status: state.status, blocker: state.blocker, failure: state.failure }));
  process.exitCode = 1;
}
