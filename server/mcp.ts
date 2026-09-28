import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApiError } from '../shared/contracts.js';
import { HttpError } from './auth.js';
import { adapterContracts, classes, executeSkill, ontology, skills, systems, teacher } from './semantic.js';
import { agentInput, agentRegistry, createEducationAgents, type EducationAgents } from './agents.js';
import { ModelError } from './llm.js';
import { createEntraAuth, EntraAuthError, type EntraAuthOptions } from '../integrations/entra.js';

const executeInput = z.strictObject({
  skillId: z.enum(skills.map(skill => skill.id) as [string, ...string[]]).describe('ID de list_skills: suporte/diário, avaliação, biblioteca ou espaços.'),
  classId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).describe('ID da turma autorizada retornado por list_classes.'),
});
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));
const toolError = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export interface McpOptions { env?: NodeJS.ProcessEnv; agents?: EducationAgents }

export function createSemanticMcpServer(options: McpOptions = {}): McpServer {
  const server = new McpServer({ name: 'horizonte-semantic', version: '1.0.0' });
  const agents = options.agents ?? createEducationAgents(options.env ?? process.env);
  const tools = new Map<string, { schema: z.ZodType; keys: string[]; run: (input: unknown) => CallToolResult | Promise<CallToolResult> }>();
  const content = (value: Record<string, unknown>): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
  });
  function register<T extends z.ZodRawShape>(
    name: string, description: string, schema: z.ZodObject<T>,
    run: (input: z.infer<z.ZodObject<T>>) => CallToolResult | Promise<CallToolResult>,
    ai = false,
  ) {
    tools.set(name, { schema, keys: Object.keys(schema.shape), run: input => run(schema.parse(input)) });
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: !ai, openWorldHint: ai },
    }, run);
  }
  const execute = ({ skillId, classId }: z.infer<typeof executeInput>): CallToolResult => {
    try {
      const result = executeSkill(skillId, classId);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
    } catch (error) {
      return toolError(error instanceof Error && 'code' in error && error.code === 'CLASS_FORBIDDEN'
        ? 'Turma não autorizada para esta professora.'
        : 'Não foi possível consultar a skill semântica.');
    }
  };
  register('execute_skill', 'Consulta determinística somente leitura de evidências escolares sintéticas, com registros, números, proveniência e caminhos. Sem modelo, gravação ou aprovação.', executeInput, execute);
  register('describe_ontology', 'Descubra entidades, relações e mapeamento de sistemas sintéticos: suporte, avaliação, biblioteca e espaços. Motor customizado, não Fabric nativo.', z.strictObject({}), () => content({
    ...ontology, systems, adapters: adapterContracts, engine: 'custom-semantic-engine', nativeFabric: false,
    synthetic: true, readOnly: true,
    limits: 'Copilot nativo Home/Cowork/Code/Autopilot conduz raciocínio, arquivos e agendamento. MCP não oferece chat, runtime nativo, escrita, aprovações ou jobs.',
    externalConnectorContract: 'Futuros conectores autorizados devem implementar consulta somente leitura por turma, retornar evidência e proveniência e ser registrados no servidor; nenhum endpoint ou provedor é selecionado pelo chamador. Nenhum agente de cliente integrado.',
  }));
  register('list_classes', 'Liste somente turmas da professora fixa sintética e seus IDs para consultas autorizadas.', z.strictObject({}), () => content({
    teacher, classes, synthetic: true, readOnly: true,
  }));
  register('list_skills', 'Catálogo com IDs, descrições e caminhos AI versus legados. Selecione reconcile-diary para suporte, explain-measures para avaliação, design-offline-lesson para biblioteca/espaços, review-writing para escrita. Skills são determinísticas; especialistas AI usam invoke_education_agent.', z.strictObject({}), () => content({
    skills: skills.map(skill => ({ ...skill, systems: skill.systems.map(id => systems.find(system => system.id === id)) })),
    agents: agentRegistry, syntheticConnectors: true, readOnly: true,
  }));
  register('invoke_education_agent', 'Consulte agente de referência Azure OpenAI real: teacher-support faz triagem sem preencher diário; writing-coach sugere feedback sem nota. Texto pedagógico com revisão docente, evidências e números determinísticos. Requer Azure configurado, nunca simula AI. Não é agente preexistente de cliente.', agentInput,
    async input => content(await agents.invoke(input)), true);
  // SDK tools/call parsing strips __proto__ from its arguments record. Preserve raw
  // arguments here so every unknown own key is rejected on both HTTP and STDIO.
  server.server.setRequestHandler(z.object({
    method: z.literal('tools/call'),
    params: z.looseObject({
      name: z.string(), arguments: z.unknown().optional(), task: z.unknown().optional(),
    }),
  }), async request => {
    if (request.params.task !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'Execução de tarefas não suportada.');
    }
    const tool = tools.get(request.params.name);
    if (!tool) return toolError('Ferramenta não disponível.');
    const raw = request.params.arguments === undefined && tool.keys.length === 0 ? {} : request.params.arguments;
    if (raw && typeof raw === 'object'
      && (Object.getPrototypeOf(raw) !== Object.prototype
        || Object.keys(raw).some(key => !tool.keys.includes(key)))) {
      return toolError('Argumentos inválidos. Informe somente campos declarados.');
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) return toolError('Argumentos de ferramenta inválidos.');
    try {
      return await tool.run(parsed.data);
    } catch (error) {
      if (error instanceof ModelError) return toolError(`${error.code}: ${error.message}`);
      return toolError('Consulta indisponível ou turma não autorizada; nenhuma escrita realizada.');
    }
  });
  return server;
}

export function mountMcp(app: Express, env: NodeJS.ProcessEnv, options: Omit<McpOptions, 'env'> & { entraOptions?: EntraAuthOptions } = {}): void {
  const entra = createEntraAuth(env, options.entraOptions);
  const key = env.MCP_ACCESS_KEY;
  const demoKey = env.DEMO_ACCESS_KEY;
  let configured = entra.configured || (Boolean(key?.trim())
    && !(demoKey !== undefined && equal(key?.trim() ?? '', demoKey.trim())));
  let publicOrigin: string | undefined;
  if (env.PUBLIC_ORIGIN !== undefined) {
    try {
      const url = new URL(env.PUBLIC_ORIGIN);
      if (url.origin !== env.PUBLIC_ORIGIN || !['http:', 'https:'].includes(url.protocol)
        || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
      publicOrigin = url.origin;
    } catch {
      configured = false;
    }
  } else if (env.NODE_ENV === 'production') {
    configured = false;
  }

  if (entra.configured) {
    app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (_req, res) => {
      res.set('Cache-Control', 'no-store').json(entra.protectedResourceMetadata);
    });
  }

  const authorize: RequestHandler = async (req, res, next) => {
    if (!configured) {
      return next(new HttpError(503, 'MCP_NOT_CONFIGURED', 'MCP indisponível. Verifique a configuração do servidor.'));
    }
    const candidate = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    let authenticated = false;
    if (entra.configured) {
      try {
        const identity = await entra.authenticate(candidate);
        res.locals.mcpPrincipal = `${identity.tid}:${identity.oid}`;
        authenticated = true;
      } catch (error) {
        if (!(error instanceof EntraAuthError)) return next(error);
      }
    } else {
      authenticated = equal(candidate, key!);
      if (authenticated) res.locals.mcpPrincipal = 'local-diagnostic';
    }
    if (!authenticated) {
      res.set('WWW-Authenticate', entra.configured ? entra.challenge : 'Bearer');
      return next(new HttpError(401, 'MCP_UNAUTHORIZED', 'Autenticação MCP obrigatória.'));
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      let expected = publicOrigin;
      if (!expected) {
        try {
          const local = new URL(`${req.protocol}://${req.get('host') ?? ''}`);
          if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) throw new Error();
          expected = local.origin;
        } catch {
          return next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'Origem da requisição não autorizada.'));
        }
      }
      if (origin !== expected) {
        return next(new HttpError(403, 'ORIGIN_FORBIDDEN', 'Origem da requisição não autorizada.'));
      }
    }
    if (!req.is('application/json')) {
      return next(new HttpError(415, 'JSON_REQUIRED', 'Envie um corpo JSON com Content-Type application/json.'));
    }
    next();
  };
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    let failure = new HttpError(500, 'MCP_FAILED', 'Não foi possível processar a requisição MCP.');
    if (error instanceof HttpError) failure = error;
    else if (error?.type === 'entity.too.large') {
      failure = new HttpError(413, 'BODY_TOO_LARGE', 'Corpo da requisição excede o limite.');
    } else if (error?.status === 415) {
      failure = new HttpError(415, 'UNSUPPORTED_ENCODING', 'Codificação da requisição não suportada.');
    } else if (error?.status === 400) {
      failure = new HttpError(400, 'INVALID_JSON', 'Corpo JSON inválido.');
    }
    const body: ApiError = { error: { code: failure.code, message: failure.message } };
    res.status(failure.status).json(body);
  };
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const authorizedLimit = rateLimit({
    windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (_req, res) => {
      const principal: unknown = res.locals.mcpPrincipal;
      if (typeof principal !== 'string') throw new Error('MCP principal missing after authentication.');
      return principal;
    },
    message: { error: { code: 'MCP_RATE_LIMITED', message: 'Muitas requisições MCP. Tente novamente mais tarde.' } } satisfies ApiError,
  });
  router.all('/', (req, res, next) => {
    if (req.method === 'POST') return next();
    res.set('Allow', 'POST').status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP sem sessão aceita somente POST.' },
    } satisfies ApiError);
  });
  router.post('/', authorize, authorizedLimit, express.json({ limit: '16kb', strict: true, inflate: false }), async (req, res, next) => {
    const server = createSemanticMcpServer({ ...options, env });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
    });
    let closing: Promise<unknown> | undefined;
    const close = () => closing ??= Promise.allSettled([server.close(), transport.close()]);
    res.once('close', () => { void close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      await close();
      next(new HttpError(500, 'MCP_FAILED', 'Não foi possível processar a requisição MCP.'));
    }
  });
  router.use(errors);
  app.use('/mcp', router);
}
