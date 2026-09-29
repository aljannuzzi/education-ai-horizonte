import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Bootstrap, ChatRequest, Intent, ToolSpec, Workspace } from '../shared/contracts.js';
import { createAuth, HttpError } from './auth.js';
import { createRule, createRuleSchema, getAutopilot, runAutopilot, updateRule } from './autopilot.js';
import { createReasoner, MODEL_NAME } from './llm.js';
import { mountMcp } from './mcp.js';
import {
  assertClass, buildWorkspace, classes, defaultToolSpec, inferIntent, ontology,
  scenarios, skills, systems, teacher, toolSpecSchema,
} from './semantic.js';
import { createStore, decideAction, editAction, StoreError, type StateStore } from './store.js';
import { calculateCostReceipt, parseCapture } from '../shared/cost-engine.js';
import type { QuestionCostReceipt } from '../shared/cost-contracts.js';
import { loadCostPriceBook } from './cost-config.js';
import { meteringEnabled, withCostMeter } from './cost-meter.js';

export interface Reasoner {
  configured: boolean;
  route(request: ChatRequest): Promise<{ intent: Intent; toolSpec?: ToolSpec; plan: string }>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(moduleDir, '..', ...(basename(dirname(moduleDir)) === 'dist' ? [] : ['dist']), 'web');

function createContentSecurityPolicy() {
  const hashes = new Set<string>();
  try {
    // Only the trusted build index is read, once per app boot; requests cannot add hashes.
    const html = fs.readFileSync(resolve(staticRoot, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
    for (const match of html.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attributes = [...match[1]!.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))?/g)];
      if (attributes.some(attribute => attribute[1]!.toLowerCase() === 'src')) continue;
      hashes.add(`'sha256-${createHash('sha256').update(match[2]!).digest('base64')}'`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  return [
    "default-src 'self'", ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join('; ');
}
const identifier = z.string().trim().min(1).max(256);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const emptyBody = z.strictObject({});
const chatBody = z.strictObject({
  message: z.string().trim().min(1).max(8_000),
  classId: identifier,
  mode: z.enum(['home', 'cowork', 'code', 'autopilot']),
  guided: z.boolean().optional(),
});
const routeResult = z.strictObject({
  intent: z.enum(['brief', 'lesson', 'diary', 'learning', 'writing', 'metrics', 'tool']),
  plan: z.string().max(16_000),
  toolSpec: toolSpecSchema.optional(),
}).refine(value => value.intent !== 'tool' || value.toolSpec !== undefined);
const updateRuleBody = z.strictObject({ enabled: z.boolean() });
const bodyParser = express.json({ limit: '128kb', strict: true, inflate: false });
const jsonOnly: RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) {
    return next(new HttpError(415, 'JSON_REQUIRED', 'Envie um corpo JSON com Content-Type application/json.'));
  }
  next();
};

export function createApp(options: {
  env?: NodeJS.ProcessEnv; store?: StateStore; model?: Reasoner;
} = {}) {
  const env = { ...(options.env ?? process.env) };
  const auth = createAuth(env);
  const store = options.store ?? createStore(env);
  const model = options.model ?? createReasoner(env);
  const costsEnabled = meteringEnabled(env);
  const costPricing = loadCostPriceBook(env);
  const csp = createContentSecurityPolicy();
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== '1') {
    throw new Error('TRUST_PROXY_HOPS must be unset or 1 for the managed ingress.');
  }
  app.set('trust proxy', env.TRUST_PROXY_HOPS === '1' ? 1 : false);
  app.set('query parser', false);
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store',
    });
    if (env.NODE_ENV === 'production') {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

  // MCP owns its bearer authentication and bounded transport parser, not browser cookies.
  mountMcp(app, env);
  app.use('/mcp', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  });

  const api = express.Router();
  api.use(rateLimit({
    windowMs: 15 * 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde antes de tentar novamente.' } },
  }));
  const loginLimit = rateLimit({
    windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: { code: 'LOGIN_RATE_LIMITED', message: 'Muitas tentativas de entrada. Tente novamente mais tarde.' } },
  });
  const mutation = [auth.mutation, jsonOnly, bodyParser];
  const privateMutation = [auth.requireSession, ...mutation];
  api.get('/session', (req, res) => { res.json(auth.session(req, res)); });
  api.post('/login', loginLimit, ...mutation, (req, res) => {
    const body = z.strictObject({ accessKey: z.string().min(1).max(1_024) }).parse(req.body);
    res.json(auth.login(req, res, body.accessKey));
  });
  api.post('/logout', ...privateMutation, (req, res) => {
    emptyBody.parse(req.body);
    auth.logout(req, res);
    res.json({ ok: true });
  });
  api.get('/bootstrap', auth.requireSession, (_req, res) => {
    const bootstrap: Bootstrap = {
      teacher, classes, scenarios, systems, skills, ontology,
      capabilities: {
        model: model.configured ? 'azure-openai' : 'guided',
        modelName: model.configured ? `Azure OpenAI · ${MODEL_NAME}` : 'Modo guiado explícito',
        persistence: store.kind,
        synthetic: true,
        notices: [
          'Dados inteiramente sintéticos; integrações e destinos escolares simulados.',
          'Nenhum código gerado é executado. Aprovações afetam somente a saída simulada.',
          model.configured
            ? 'Roteamento de intenção por chamada real ao Azure OpenAI; evidências e métricas determinísticas.'
            : 'Modelo não configurado. Selecione explicitamente o modo guiado (guided: true); não há fallback automático.',
        ],
      },
    };
    res.json(bootstrap);
  });
  api.get('/costs/config', auth.requireSession, (_req, res) => {
    res.json({
      enabled: costsEnabled, pricing: costPricing,
      nativeCoworkCapture: 'operator-observed',
      notes: [
        'O backend não intercepta o plugin Fabric IQ nativo do Cowork.',
        '/cost informa créditos aproximados acumulados por tarefa, não uma fatura por pergunta.',
        'Recibos não incluem o conteúdo da pergunta ou da resposta.',
      ],
    });
  });
  api.post('/costs/estimate', ...privateMutation, (req, res) => {
    const body = z.strictObject({ capture: z.unknown() }).parse(req.body);
    const capture = parseCapture(body.capture);
    // Operator-submitted quantities are not attested by backend metering.
    res.json(calculateCostReceipt({ ...capture, origin: 'operator-entered' }, costPricing));
  });
  api.post('/costs/probe', ...privateMutation, rateLimit({
    windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'COST_PROBE_LIMIT', message: 'Aguarde antes de repetir a medição de inferência.' } },
  }), async (req, res) => {
    emptyBody.parse(req.body);
    if (!costsEnabled || !model.configured) {
      throw new HttpError(503, 'COST_PROBE_UNAVAILABLE', 'A medição e o modelo devem estar configurados.');
    }
    await withCostMeter({
      path: 'azure-mcp', scope: 'question', env, pricing: costPricing,
      onReceipt: receipt => {
        res.locals.costReceipt = receipt;
        res.set('X-Question-Id', receipt.questionId);
      },
    }, async () => {
      await model.route({
        message: 'Verifique as pendências do diário da turma sintética 7A, somente leitura.',
        classId: 'class-7a', mode: 'cowork',
      });
    });
    res.json({ diagnosticOnly: true, costReceipt: res.locals.costReceipt });
  });
  api.post('/chat', ...privateMutation, async (req, res) => {
    const input = chatBody.parse(req.body);
    assertClass(input.classId);
    const run = async () => {
      let workspace: Workspace;
      if (input.guided === true) {
        const intent = inferIntent(input.message);
        workspace = buildWorkspace({
          classId: input.classId, mode: input.mode, intent, model: 'guided',
          ...(intent === 'tool' ? { toolSpec: defaultToolSpec(input.message) } : {}),
        });
      } else {
        if (!model.configured) {
          throw new HttpError(503, 'MODEL_NOT_CONFIGURED', 'Modelo não configurado. Selecione explicitamente o modo guiado.');
        }
        try {
          const routed = routeResult.parse(await model.route(input));
          workspace = buildWorkspace({
            classId: input.classId, mode: input.mode, model: 'azure-openai', ...routed,
          });
          workspace.modelNotice = `Intenção roteada por chamada real ao Azure OpenAI (${MODEL_NAME}; implantação configurada). Evidências, métricas e propostas vêm da travessia semântica determinística de dados sintéticos. Nenhum destino externo foi alterado.`;
        } catch {
          throw new HttpError(502, 'MODEL_FAILED', 'Falha no roteamento do modelo. Nenhum rascunho foi salvo; tente novamente ou selecione o modo guiado.');
        }
      }
      await store.mutate(state => {
        state.actions.push(...workspace.actions);
        state.audit.push({
          id: randomUUID(), at: new Date().toISOString(), actor: teacher.id,
          type: 'workspace.created',
          detail: `Espaço ${workspace.intent}; turma ${input.classId}; modo ${workspace.model}. Somente propostas simuladas.`,
        });
      });
      return workspace;
    };
    const workspace = costsEnabled ? await withCostMeter({
      path: 'azure-mcp', scope: 'question', env, pricing: costPricing,
      onReceipt: receipt => {
        res.locals.costReceipt = receipt;
        res.set('X-Question-Id', receipt.questionId);
      },
    }, run) : await run();
    const receipt: QuestionCostReceipt | undefined = res.locals.costReceipt;
    res.json(receipt ? { ...workspace, costReceipt: receipt } : workspace);
  });
  api.get('/actions', auth.requireSession, async (_req, res) => {
    res.json({ actions: (await store.read()).actions });
  });
  api.patch('/actions/:id', ...privateMutation, async (req, res) => {
    const body = z.strictObject({
      content: z.string().min(1).max(100_000).refine(value => value.trim().length > 0), version,
    }).parse(req.body);
    res.json(await editAction(store, identifier.parse(req.params.id), body.content, body.version));
  });
  for (const [path, decision] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    api.post(`/actions/:id/${path}`, ...privateMutation, async (req, res) => {
      const body = z.strictObject({ version }).parse(req.body);
      res.json(await decideAction(store, identifier.parse(req.params.id), body.version, decision));
    });
  }
  api.get('/autopilot', auth.requireSession, async (_req, res) => {
    res.json(await getAutopilot(store, env));
  });
  api.post('/autopilot/rules', ...privateMutation, async (req, res) => {
    const input = createRuleSchema.parse(req.body);
    assertClass(input.classId);
    res.status(201).json(await createRule(store, input));
  });
  api.patch('/autopilot/rules/:id', ...privateMutation, async (req, res) => {
    res.json(await updateRule(store, identifier.parse(req.params.id), updateRuleBody.parse(req.body)));
  });
  api.post('/autopilot/run', ...privateMutation, async (req, res) => {
    emptyBody.parse(req.body);
    res.json(await runAutopilot(store, 'manual', undefined, env));
  });
  api.get('/audit', auth.requireSession, async (_req, res) => {
    res.json({ events: (await store.read()).audit });
  });
  api.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  });
  app.use('/api', api);

  app.use((req, res, next) => {
    const path = decodeURIComponent(req.path).replaceAll('\\', '/');
    if (/^\/+(?:api|mcp)(?:\/|$)/i.test(path)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      return;
    }
    next();
  });
  app.use(express.static(staticRoot, { index: false, dotfiles: 'deny', redirect: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (extname(req.path) || decodeURIComponent(req.path).split('/').some(part => part.startsWith('.'))
      || !req.accepts('html')) return next();
    res.sendFile(resolve(staticRoot, 'index.html'), error => { if (error) next(error); });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error);
    const receipt: QuestionCostReceipt | undefined = res.locals.costReceipt;
    const costDetails = receipt ? { costReceipt: receipt } : {};
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message }, ...costDetails });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Corpo inválido ou campos não permitidos.' }, ...costDetails });
      return;
    }
    const detail = error !== null && typeof error === 'object'
      ? error as { type?: string; code?: string; status?: number } : {};
    if (detail.code === 'CLASS_FORBIDDEN') {
      res.status(403).json({ error: { code: 'CLASS_FORBIDDEN', message: 'Turma não autorizada para esta professora.' } });
      return;
    }
    if (error instanceof StoreError) {
      res.status(error.status).json({ error: { code: error.code, message: 'Não foi possível concluir a operação. Atualize os dados e tente novamente.' }, ...costDetails });
      return;
    }
    const status = detail.type === 'entity.too.large' ? 413
      : detail.type === 'encoding.unsupported' || detail.type === 'charset.unsupported' ? 415
        : detail.type === 'entity.parse.failed' || detail.type === 'request.size.invalid' || error instanceof URIError ? 400
          : detail.code === 'ENOENT' || detail.status === 404 ? 404 : 500;
    res.status(status).json({ error: {
      code: status === 413 ? 'BODY_TOO_LARGE' : status === 415 ? 'JSON_REQUIRED'
        : status === 400 ? 'INVALID_BODY' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      message: status === 500 ? 'Não foi possível concluir a operação.' : 'Requisição inválida ou recurso indisponível.',
    }, ...costDetails });
  };
  app.use(errors);
  return app;
}
