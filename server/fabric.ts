import { AzureCliCredential } from '@azure/identity';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
export const FABRIC_MAX_QUESTION_LENGTH = 8_000;
const MAX_RESULT_LENGTH = 64_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9_.-]{1,128}$/;

export interface FabricConfig {
  workspaceId: string;
  dataAgentId: string;
  /** Provenance only: this ID does not select or verify a native data source. */
  ontologyId: string;
  auth: 'azure-cli' | 'token-provider';
  timeoutMs?: number;
  tool?: {
    name: string;
    inputProperty: string;
    /** Operator has independently checked this specific tool is read-only. */
    readOnlyAttested?: boolean;
  };
  /** Recorded separately; an operator assertion is not runtime verification. */
  nativeOntologyAttested?: boolean;
}

export interface FabricTool {
  name: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface FabricSession {
  connect(signal: AbortSignal): Promise<void>;
  listTools(cursor: string | undefined, signal: AbortSignal): Promise<{
    tools: FabricTool[];
    nextCursor?: string;
  }>;
  callTool(name: string, args: Record<string, string>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface FabricDependencies {
  /** Supply a user or service-principal token, never a managed-identity credential. */
  tokenProvider?: (scope: string, signal: AbortSignal) => Promise<string>;
  createSession?: (options: {
    endpoint: string; token: string; signal: AbortSignal;
  }) => FabricSession;
  fetch?: typeof globalThis.fetch;
}

export type FabricErrorCode =
  | 'INVALID_CONFIG' | 'INVALID_QUESTION' | 'AUTH_FAILED' | 'HTTP_ERROR'
  | 'MCP_ERROR' | 'TOOL_UNSUPPORTED' | 'TOOL_ERROR' | 'INVALID_RESULT'
  | 'TIMEOUT' | 'CANCELLED';

const messages: Record<FabricErrorCode, string> = {
  INVALID_CONFIG: 'Invalid Fabric configuration.',
  INVALID_QUESTION: 'Question must be nonempty and within the supported bounds.',
  AUTH_FAILED: 'Fabric authentication failed.',
  HTTP_ERROR: 'Fabric HTTP request failed.',
  MCP_ERROR: 'Fabric MCP request failed.',
  TOOL_UNSUPPORTED: 'No unambiguous supported read-only question tool was discovered.',
  TOOL_ERROR: 'The Fabric tool reported an error.',
  INVALID_RESULT: 'Fabric returned an unsupported or oversized result.',
  TIMEOUT: 'Fabric request timed out.',
  CANCELLED: 'Fabric request was cancelled.',
};

export class FabricError extends Error {
  constructor(public readonly code: FabricErrorCode, public readonly httpStatus?: number) {
    super(messages[code]);
    this.name = 'FabricError';
  }
}

export interface FabricMetadata {
  source: 'fabric';
  provider: 'fabric';
  endpoint: string;
  workspaceId: string;
  dataAgentId: string;
  ontologyId: string;
  nativeOntology: { status: 'unverified'; operatorAttested: boolean };
}

export interface FabricHealth extends FabricMetadata {
  availability: 'not-checked' | 'available' | 'unavailable';
  lastError?: FabricErrorCode;
}

export interface FabricQueryResult extends FabricMetadata {
  tool: { name: string; inputProperty: string };
  /** Text blocks only; transport metadata, links and embedded resources are not exposed. */
  content: Array<{ type: 'text'; text: string }>;
  answer: string;
  structuredContent?: unknown;
}

export interface FabricClient {
  /** Last observed query availability, not a network probe or ontology health check. */
  health(): FabricHealth;
  query(question: string, options?: { signal?: AbortSignal }): Promise<FabricQueryResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAllowed(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function validSchemaLabels(value: Record<string, unknown>): boolean {
  return ['title', 'description'].every(key => value[key] === undefined || typeof value[key] === 'string');
}

function validateConfig(value: FabricConfig, deps: FabricDependencies): FabricConfig {
  if (!record(value) || !keysAllowed(value, [
    'workspaceId', 'dataAgentId', 'ontologyId', 'auth', 'timeoutMs', 'tool', 'nativeOntologyAttested',
  ]) || ![value.workspaceId, value.dataAgentId, value.ontologyId].every(
    id => typeof id === 'string' && UUID.test(id),
  ) || !['azure-cli', 'token-provider'].includes(value.auth)
    || (value.auth === 'token-provider' && typeof deps.tokenProvider !== 'function')
    || (value.auth === 'azure-cli' && deps.tokenProvider !== undefined)
    || (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs)
      || value.timeoutMs < 1 || value.timeoutMs > 120_000))
    || (value.nativeOntologyAttested !== undefined && typeof value.nativeOntologyAttested !== 'boolean')) {
    throw new FabricError('INVALID_CONFIG');
  }
  if (value.tool !== undefined && (!record(value.tool)
    || !keysAllowed(value.tool, ['name', 'inputProperty', 'readOnlyAttested'])
    || typeof value.tool.name !== 'string' || !NAME.test(value.tool.name)
    || typeof value.tool.inputProperty !== 'string' || !NAME.test(value.tool.inputProperty)
    || ['__proto__', 'constructor', 'prototype'].includes(value.tool.inputProperty)
    || (value.tool.readOnlyAttested !== undefined && typeof value.tool.readOnlyAttested !== 'boolean'))) {
    throw new FabricError('INVALID_CONFIG');
  }
  return { ...value, tool: value.tool ? { ...value.tool } : undefined };
}

// Fail closed on schema features we cannot fully validate; never guess an argument name.
function questionProperty(tool: FabricTool, config: FabricConfig, question: string): string | undefined {
  if (!NAME.test(tool.name) || (config.tool && config.tool.name !== tool.name)
    || tool.annotations?.destructiveHint === true
    || tool.annotations?.readOnlyHint === false
    || (tool.annotations?.readOnlyHint !== true && config.tool?.readOnlyAttested !== true)) return;
  const schema = tool.inputSchema;
  if (!record(schema) || schema.type !== 'object'
    || !validSchemaLabels(schema)
    || (schema.$schema !== undefined && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
      && schema.$schema !== 'http://json-schema.org/draft-07/schema#')
    || !keysAllowed(schema, ['$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties'])
    || !record(schema.properties) || Object.keys(schema.properties).length !== 1
    || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')) return;
  const property = Object.keys(schema.properties)[0]!;
  if (!NAME.test(property) || ['__proto__', 'constructor', 'prototype'].includes(property)
    || (config.tool && config.tool.inputProperty !== property)
    || (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.length > 1 || schema.required.some(key => key !== property)))) return;
  const input = schema.properties[property];
  if (!record(input) || input.type !== 'string'
    || !validSchemaLabels(input)
    || !keysAllowed(input, ['type', 'title', 'description', 'minLength', 'maxLength', 'enum', 'const'])) return;
  const length = Array.from(question).length;
  for (const key of ['minLength', 'maxLength'] as const) {
    const bound = input[key];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0
      || (key === 'minLength' ? length < bound : length > bound))) return;
  }
  if (input.const !== undefined && (typeof input.const !== 'string' || input.const !== question)) return;
  if (input.enum !== undefined && (!Array.isArray(input.enum) || input.enum.length === 0
    || !input.enum.every(item => typeof item === 'string')
    || new Set(input.enum).size !== input.enum.length || !input.enum.includes(question))) return;
  return property;
}

function cleanResult(value: unknown, token: string): Pick<FabricQueryResult, 'content' | 'answer' | 'structuredContent'> {
  if (!record(value) || value.isError === true) throw new FabricError('TOOL_ERROR');
  if ((value.isError !== undefined && value.isError !== false) || !Array.isArray(value.content)) {
    throw new FabricError('INVALID_RESULT');
  }
  let budget = MAX_RESULT_LENGTH;
  let nodes = 0;
  const text = (input: string) => {
    if (input.length > budget) throw new FabricError('INVALID_RESULT');
    const output = input.split(token).join('[redacted]')
      .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
    budget -= Math.max(input.length, output.length);
    if (budget < 0) throw new FabricError('INVALID_RESULT');
    return output;
  };
  const scrub = (input: unknown, depth = 0): unknown => {
    if (++nodes > 4_000 || depth > 12) throw new FabricError('INVALID_RESULT');
    if (typeof input === 'string') return text(input);
    if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return input;
    if (Array.isArray(input)) return input.map(item => scrub(item, depth + 1));
    if (!record(input)) throw new FabricError('INVALID_RESULT');
    return Object.fromEntries(Object.entries(input).filter(([key]) =>
      !/meta|header|token|secret|password|authorization|cookie|credential|session|__proto__|constructor|prototype/i.test(key),
    ).map(([key, item]) => [text(key), scrub(item, depth + 1)]));
  };
  if (value.content.length > 1_000) throw new FabricError('INVALID_RESULT');
  const content = value.content.map(block => {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') {
      throw new FabricError('INVALID_RESULT');
    }
    return { type: 'text' as const, text: text(block.text) };
  });
  const structuredContent = value.structuredContent === undefined ? undefined : scrub(value.structuredContent);
  if (!content.length && structuredContent === undefined) throw new FabricError('INVALID_RESULT');
  return { content, answer: content.map(block => block.text).join('\n'), structuredContent };
}

function nativeSession(
  options: { endpoint: string; token: string; signal: AbortSignal },
  fetchImpl: typeof globalThis.fetch,
): FabricSession {
  const transport = new StreamableHTTPClientTransport(new URL(options.endpoint), {
    // No auth discovery, arbitrary endpoints, redirect following, or alternate providers.
    fetch: async (url, init) => {
      options.signal.throwIfAborted();
      if (new URL(String(url)).href !== options.endpoint) throw new FabricError('HTTP_ERROR');
      const response = await fetchImpl(url, {
        ...init,
        headers: new Headers(init?.headers),
        redirect: 'error',
        signal: init?.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal,
      });
      if (response.redirected || (!response.ok && !(response.status === 405 && init?.method === 'GET'))) {
        throw new FabricError('HTTP_ERROR', response.status);
      }
      return response;
    },
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: 'horizonte-fabric', version: '1.0.0' });
  return {
    // The outer deadline owns cancellation; do not let the SDK's 60s default preempt it.
    connect: signal => client.connect(transport, { signal, timeout: 120_000 }),
    listTools: (cursor, signal) => client.listTools(cursor ? { cursor } : {}, { signal, timeout: 120_000 }),
    callTool: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }),
    close: async () => {
      await Promise.allSettled([client.close(), transport.close()]);
    },
  };
}

export function createFabricClient(config: FabricConfig, deps: FabricDependencies = {}): FabricClient {
  const settings = validateConfig(config, deps);
  const endpoint = `https://api.fabric.microsoft.com/v1/mcp/workspaces/${settings.workspaceId}/dataagents/${settings.dataAgentId}/agent`;
  const metadata = (): FabricMetadata => ({
    source: 'fabric', provider: 'fabric', endpoint,
    workspaceId: settings.workspaceId, dataAgentId: settings.dataAgentId, ontologyId: settings.ontologyId,
    nativeOntology: { status: 'unverified', operatorAttested: settings.nativeOntologyAttested === true },
  });
  let availability: FabricHealth['availability'] = 'not-checked';
  let lastError: FabricErrorCode | undefined;
  return {
    health: () => ({ ...metadata(), availability, lastError }),
    async query(question, options = {}) {
      if (typeof question !== 'string' || !question.trim() || question.length > FABRIC_MAX_QUESTION_LENGTH
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(question)) throw new FabricError('INVALID_QUESTION');
      const controller = new AbortController();
      let session: FabricSession | undefined;
      let phase: 'auth' | 'mcp' = 'auth';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => controller.abort(new FabricError('CANCELLED'));
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        if (controller.signal.aborted) stop();
      });
      timer = setTimeout(() => controller.abort(new FabricError('TIMEOUT')), settings.timeoutMs ?? 60_000);
      const run = async (): Promise<FabricQueryResult> => {
        controller.signal.throwIfAborted();
        const token = settings.auth === 'token-provider'
          ? await deps.tokenProvider!(FABRIC_SCOPE, controller.signal)
          : (await new AzureCliCredential().getToken(FABRIC_SCOPE, { abortSignal: controller.signal }))?.token;
        controller.signal.throwIfAborted();
        if (typeof token !== 'string' || !token || token.length > 32_000 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
          throw new FabricError('AUTH_FAILED');
        }
        phase = 'mcp';
        session = deps.createSession
          ? deps.createSession({ endpoint, token, signal: controller.signal })
          : nativeSession({ endpoint, token, signal: controller.signal }, deps.fetch ?? globalThis.fetch);
        await session.connect(controller.signal);
        controller.signal.throwIfAborted();
        const tools: FabricTool[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await session.listTools(cursor, controller.signal);
          controller.signal.throwIfAborted();
          if (!Array.isArray(page.tools) || page.tools.length > 100 || tools.length + page.tools.length > 100) {
            throw new FabricError('TOOL_UNSUPPORTED');
          }
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            if (typeof cursor !== 'string' || !cursor || cursor.length > 2_048 || cursors.has(cursor) || cursors.size >= 10) {
              throw new FabricError('TOOL_UNSUPPORTED');
            }
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new FabricError('TOOL_UNSUPPORTED');
        const candidates = tools.map(tool => ({ tool, property: questionProperty(tool, settings, question) }))
          .filter((item): item is { tool: FabricTool; property: string } => item.property !== undefined);
        if (candidates.length !== 1) throw new FabricError('TOOL_UNSUPPORTED');
        const selected = candidates[0]!;
        controller.signal.throwIfAborted();
        const result = await session.callTool(selected.tool.name, { [selected.property]: question }, controller.signal);
        controller.signal.throwIfAborted();
        return { ...metadata(), tool: { name: selected.tool.name, inputProperty: selected.property }, ...cleanResult(result, token) };
      };
      try {
        const result = await Promise.race([aborted, run()]);
        availability = 'available';
        lastError = undefined;
        return result;
      } catch (error) {
        const safe = error instanceof FabricError ? error : new FabricError(phase === 'auth' ? 'AUTH_FAILED' : 'MCP_ERROR');
        availability = 'unavailable';
        lastError = safe.code;
        throw safe;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (session) {
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.resolve().then(() => session!.close()).catch(() => undefined),
            new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 250); }),
          ]);
          clearTimeout(closeTimer);
        }
      }
    },
  };
}
