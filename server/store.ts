import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type BlockBlobClient } from '@azure/storage-blob';
import { z } from 'zod';
import type { ActionDraft, AuditEvent, AutopilotRun, WatchRule } from '../shared/contracts.js';

export interface State {
  schemaVersion: 1;
  actions: ActionDraft[];
  rules: WatchRule[];
  runs: AutopilotRun[];
  audit: AuditEvent[];
  outbox: { actionId: string; version: number; target: string; content: string; at: string }[];
  dedupe: string[];
}

export interface StateStore {
  kind: 'local' | 'azure-blob';
  read(): Promise<State>;
  mutate<T>(fn: (state: State) => T): Promise<T>;
}

export class StoreError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
  }
}

const MAX_ACTIONS = 250;
const MAX_AUDIT = 500;
const MAX_RUNS = 100;
const MAX_BYTES = 64 * 1024 * 1024;
const idSchema = z.string().min(1).max(256).refine((value) => value === value.trim());
const textSchema = z.string().min(1).max(100_000);
const dateSchema = z.iso.datetime({ offset: true });
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actionSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  title: z.string().min(1).max(1_000),
  kind: z.enum(['diary-draft', 'support-ticket', 'lesson-kit', 'feedback-draft']),
  target: z.string().min(1).max(1_000),
  content: textSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: dateSchema,
  evidenceIds: z.array(idSchema).max(250),
  simulated: z.literal(true),
  approvedAt: dateSchema.optional(),
}).refine(
  (action) => (action.status === 'approved') === (action.approvedAt !== undefined),
  'A data de aprovação deve existir somente em ações aprovadas.',
);
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  actions: z.array(actionSchema).max(MAX_ACTIONS),
  rules: z.array(z.strictObject({
    id: idSchema,
    name: z.string().min(1).max(1_000),
    kind: z.enum(['diary-pending', 'learning-gap', 'week-prep']),
    classId: idSchema,
    enabled: z.boolean(),
    description: textSchema,
    lastRunAt: dateSchema.optional(),
  })).max(100),
  runs: z.array(z.strictObject({
    id: idSchema,
    at: dateSchema,
    source: z.enum(['manual', 'schedule']),
    summary: textSchema,
    actionIds: z.array(idSchema).max(MAX_ACTIONS),
  })).max(MAX_RUNS),
  audit: z.array(z.strictObject({
    id: idSchema,
    at: dateSchema,
    actor: idSchema,
    type: idSchema,
    detail: textSchema,
    actionId: idSchema.optional(),
  })).max(MAX_AUDIT),
  outbox: z.array(z.strictObject({
    actionId: idSchema,
    version: versionSchema,
    target: z.string().min(1).max(1_000),
    content: textSchema,
    at: dateSchema,
  })).max(MAX_ACTIONS),
  dedupe: z.array(z.string().min(1).max(1_024)).max(10_000),
}).superRefine((state, ctx) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', path: [path], message: 'Identificadores duplicados.' });
    }
  };
  for (const key of ['actions', 'rules', 'runs', 'audit'] as const) {
    unique(state[key].map((item) => item.id), key);
  }
  unique(state.dedupe, 'dedupe');
  unique(state.outbox.map((item) => item.actionId), 'outbox');
  const actions = new Map(state.actions.map((action) => [action.id, action]));
  const outbox = new Map(state.outbox.map((item) => [item.actionId, item]));
  for (const item of state.outbox) {
    const action = actions.get(item.actionId);
    if (!action || action.status !== 'approved' || action.version !== item.version
      || action.target !== item.target || action.content !== item.content || action.approvedAt !== item.at) {
      ctx.addIssue({ code: 'custom', path: ['outbox'], message: 'A aprovação e a saída devem corresponder.' });
    }
  }
  for (const action of state.actions) {
    if (action.status === 'approved' && !outbox.has(action.id)) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Aprovação sem saída persistida.' });
    }
  }
});

export function emptyState(): State {
  return { schemaVersion: 1, actions: [], rules: [], runs: [], audit: [], outbox: [], dedupe: [] };
}

function validate(value: unknown): State {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) {
    throw new StoreError(500, 'INVALID_STATE', 'Estado persistido inválido; nenhum dado foi substituído.');
  }
  return parsed.data;
}

function decode(raw: string): State {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StoreError(500, 'INVALID_STATE', 'JSON persistido corrompido; nenhum dado foi substituído.');
  }
  return validate(value);
}

function encode(state: State): string {
  const raw = JSON.stringify(state);
  if (Buffer.byteLength(raw) > MAX_BYTES) {
    throw new StoreError(507, 'STATE_CAPACITY', 'O estado excedeu o limite de armazenamento.');
  }
  return raw;
}

function conflict(): StoreError {
  return new StoreError(409, 'CONFLICT', 'O estado foi alterado. Atualize os dados e tente novamente.');
}

function unavailable(error: unknown): never {
  if (error instanceof StoreError) throw error;
  throw new StoreError(503, 'STORE_UNAVAILABLE', 'Não foi possível acessar o armazenamento persistente.');
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function httpStatus(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
}

function queue() {
  let tail = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function transaction<T>(current: State, fn: (state: State) => T): { state: State; result: T } {
  const draft = structuredClone(current);
  const value = fn(draft);
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
    && 'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new StoreError(400, 'ASYNC_MUTATION', 'A transação deve usar uma função síncrona, sem efeitos externos.');
  }
  if (draft.actions.length > MAX_ACTIONS || draft.outbox.length > MAX_ACTIONS
    || draft.rules.length > 100 || draft.dedupe.length > 10_000) {
    // Never evict approvals or deduplication keys to make room for new work.
    throw new StoreError(507, 'STATE_CAPACITY', 'Capacidade atingida; os registros existentes foram preservados.');
  }
  const approvalAudit = draft.audit.filter((event) => event.type === 'action.approved');
  const otherAudit = draft.audit.filter((event) => event.type !== 'action.approved');
  if (approvalAudit.length > MAX_AUDIT) {
    throw new StoreError(507, 'STATE_CAPACITY', 'Capacidade de auditoria de aprovações atingida.');
  }
  const auditBudget = MAX_AUDIT - approvalAudit.length;
  const retainedAuditIds = new Set([
    ...approvalAudit,
    ...(auditBudget > 0 ? otherAudit.slice(-auditBudget) : []),
  ].map((event) => event.id));
  draft.audit = draft.audit.filter((event) => retainedAuditIds.has(event.id));
  draft.runs = draft.runs.slice(-MAX_RUNS);
  const state = validate(draft);
  for (const action of current.actions.filter((item) => item.status === 'approved')) {
    if (JSON.stringify(state.actions.find((item) => item.id === action.id)) !== JSON.stringify(action)) {
      throw new StoreError(409, 'APPROVAL_IMMUTABLE', 'Uma aprovação persistida não pode ser removida ou alterada.');
    }
    for (const event of current.audit.filter((item) => item.type === 'action.approved')) {
      if (JSON.stringify(state.audit.find((item) => item.id === event.id)) !== JSON.stringify(event)) {
        throw new StoreError(409, 'APPROVAL_IMMUTABLE', 'A auditoria de uma aprovação não pode ser removida ou alterada.');
      }
    }
  }
  if (current.dedupe.some((key) => !state.dedupe.includes(key))) {
    throw new StoreError(409, 'DEDUPE_IMMUTABLE', 'Chaves de deduplicação persistidas não podem ser removidas.');
  }
  encode(state);
  return { state, result: structuredClone(value) };
}

export function createMemoryStore(initial: State = emptyState()): StateStore {
  let state = validate(initial);
  const serial = queue();
  return {
    kind: 'local',
    read: () => serial(async () => structuredClone(state)),
    mutate: <T>(fn: (state: State) => T) => serial(async () => {
      const next = transaction(state, fn);
      state = next.state;
      return next.result;
    }),
  };
}

const localQueues = new Map<string, ReturnType<typeof queue>>();

function localStore(path: string): StateStore {
  const file = resolve(path);
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  let serial = localQueues.get(key);
  if (!serial) {
    serial = queue();
    localQueues.set(key, serial);
  }
  const run = serial;
  const load = async (): Promise<State> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyState();
      return unavailable(error);
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) {
      throw new StoreError(500, 'INVALID_STATE', 'O arquivo persistido excede o limite permitido.');
    }
    return decode(raw);
  };
  return {
    kind: 'local',
    read: () => run(load),
    mutate: <T>(fn: (state: State) => T) => run(async () => {
      const lockPath = `${file}.lock`;
      let lock: Awaited<ReturnType<typeof open>>;
      try {
        await mkdir(dirname(file), { recursive: true });
        lock = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') throw conflict();
        return unavailable(error);
      }
      const sibling = `${file}.${randomUUID()}.writing`;
      try {
        const next = transaction(await load(), fn);
        const handle = await open(sibling, 'wx', 0o600);
        try {
          await handle.writeFile(encode(next.state), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(sibling, file);
        return next.result;
      } catch (error) {
        return unavailable(error);
      } finally {
        try {
          await unlink(sibling).catch((error: unknown) => {
            if (errorCode(error) !== 'ENOENT') unavailable(error);
          });
        } finally {
          try {
            await lock.close();
          } finally {
            await unlink(lockPath).catch(unavailable);
          }
        }
      }
    }),
  };
}

function azureStore(blob: BlockBlobClient): StateStore {
  const load = async (): Promise<{ state: State; etag?: string }> => {
    try {
      const response = await blob.download();
      if (!response.etag || !response.readableStreamBody) {
        throw new StoreError(503, 'STORE_UNAVAILABLE', 'Resposta incompleta do armazenamento Azure.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.readableStreamBody) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > MAX_BYTES) {
          throw new StoreError(500, 'INVALID_STATE', 'O estado Azure excede o limite permitido.');
        }
        chunks.push(buffer);
      }
      return { state: decode(Buffer.concat(chunks).toString('utf8')), etag: response.etag };
    } catch (error) {
      if (httpStatus(error) === 404 && errorCode(error) !== 'ContainerNotFound') {
        return { state: emptyState() };
      }
      return unavailable(error);
    }
  };
  return {
    kind: 'azure-blob',
    read: async () => (await load()).state,
    mutate: async <T>(fn: (state: State) => T): Promise<T> => {
      const current = await load();
      const next = transaction(current.state, fn);
      const body = encode(next.state);
      try {
        await blob.upload(body, Buffer.byteLength(body), {
          conditions: current.etag ? { ifMatch: current.etag } : { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
        });
      } catch (error) {
        if (httpStatus(error) === 409 || httpStatus(error) === 412) throw conflict();
        return unavailable(error);
      }
      return next.result;
    },
  };
}

export function createStore(env: NodeJS.ProcessEnv = process.env): StateStore {
  const account = env.AZURE_STORAGE_ACCOUNT?.trim();
  const container = env.AZURE_STORAGE_CONTAINER?.trim();
  if (env.AZURE_STORAGE_ACCOUNT !== undefined || env.AZURE_STORAGE_CONTAINER !== undefined) {
    if (!account || !/^[a-z0-9]{3,24}$/.test(account)
      || !container || !/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(container)) {
      throw new StoreError(500, 'STORE_CONFIG', 'Configure AZURE_STORAGE_ACCOUNT e AZURE_STORAGE_CONTAINER válidos.');
    }
    const credential = new DefaultAzureCredential({ managedIdentityClientId: env.AZURE_CLIENT_ID });
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, {
      retryOptions: { maxTries: 3 },
    });
    return azureStore(service.getContainerClient(container).getBlockBlobClient('state.json'));
  }
  if (env.STATE_PATH !== undefined && !env.STATE_PATH.trim()) {
    throw new StoreError(500, 'STORE_CONFIG', 'STATE_PATH não pode ser vazio.');
  }
  return localStore(env.STATE_PATH ?? resolve('.runtime', 'state.json'));
}

function getAction(state: State, id: string, version: number): ActionDraft {
  if (!idSchema.safeParse(id).success || !versionSchema.safeParse(version).success) {
    throw new StoreError(400, 'INVALID_ACTION', 'Informe uma ação e uma versão válidas.');
  }
  const action = state.actions.find((item) => item.id === id);
  if (!action) throw new StoreError(404, 'ACTION_NOT_FOUND', 'Ação não encontrada.');
  if (action.version !== version) throw conflict();
  return action;
}

export async function editAction(
  store: StateStore, id: string, content: string, version: number,
): Promise<ActionDraft> {
  if (!textSchema.safeParse(content).success || !content.trim()) {
    throw new StoreError(400, 'INVALID_CONTENT', 'O conteúdo deve ter entre 1 e 100.000 caracteres.');
  }
  return store.mutate((state) => {
    const action = getAction(state, id, version);
    if (action.status !== 'pending' || action.version === Number.MAX_SAFE_INTEGER) throw conflict();
    action.content = content;
    action.version += 1;
    state.audit.push({
      id: randomUUID(), at: new Date().toISOString(), actor: 'teacher',
      type: 'action.edited', actionId: id, detail: `Rascunho editado; versão ${action.version}.`,
    });
    return action;
  });
}

export async function decideAction(
  store: StateStore, id: string, version: number, decision: 'approved' | 'rejected',
): Promise<ActionDraft> {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new StoreError(400, 'INVALID_DECISION', 'Decisão inválida.');
  }
  return store.mutate((state) => {
    const action = getAction(state, id, version);
    if (action.status === decision) return action;
    if (action.status !== 'pending') throw conflict();
    const at = new Date().toISOString();
    action.status = decision;
    if (decision === 'approved') {
      action.approvedAt = at;
      state.outbox.push({ actionId: id, version, target: action.target, content: action.content, at });
    }
    state.audit.push({
      id: randomUUID(), at, actor: 'teacher', type: `action.${decision}`, actionId: id,
      detail: decision === 'approved'
        ? `Versão ${version} aprovada para destino simulado; nenhum envio externo.`
        : `Versão ${version} rejeitada; nenhum envio realizado.`,
    });
    return action;
  });
}
