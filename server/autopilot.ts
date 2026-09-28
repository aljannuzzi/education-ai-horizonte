import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutopilotRun, AutopilotState, Intent, WatchRule } from '../shared/contracts.js';
import { assertClass, buildWorkspace, teacher } from './semantic.js';
import { StoreError, type State, type StateStore } from './store.js';

export const createRuleSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['diary-pending', 'learning-gap', 'week-prep']),
  classId: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
});
const updateRuleSchema = z.strictObject({ enabled: z.boolean() });
const operations: Record<WatchRule['kind'], { intent: Intent; description: string }> = {
  'diary-pending': {
    intent: 'diary',
    description: 'Conferir calendário e aula efetiva; preparar triagem e rascunhos para revisão, nunca preencher o diário.',
  },
  'learning-gap': {
    intent: 'learning',
    description: 'Separar cobertura de aprendizagem e preparar recomposição com evidências sintéticas, sem rótulos.',
  },
  'week-prep': {
    intent: 'lesson',
    description: 'Preparar aula e alternativas offline com materiais autorizados; manutenção apenas como proposta.',
  },
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StoreError(400, 'INVALID_RULE', 'Informe somente os campos válidos da regra.');
  return result.data;
}

function schedule(env: NodeJS.ProcessEnv): string {
  return env.AUTOPILOT_SCHEDULE?.trim() || '06:30 em dias uteis (America/Sao_Paulo)';
}

function audit(state: State, type: string, detail: string, at: string, actionId?: string): void {
  state.audit.push({
    id: randomUUID(), at, actor: teacher.id, type, detail,
    ...(actionId ? { actionId } : {}),
  });
}

export async function createRule(store: StateStore, input: unknown): Promise<WatchRule> {
  const value = parse(createRuleSchema, input);
  assertClass(value.classId);
  return store.mutate(state => {
    assertClass(value.classId);
    const rule: WatchRule = {
      ...value, id: randomUUID(), description: operations[value.kind].description,
    };
    state.rules.push(rule);
    audit(state, 'autopilot.rule.created', `Regra ${rule.id} criada; habilitada: ${rule.enabled}.`, new Date().toISOString());
    return rule;
  });
}

export async function updateRule(store: StateStore, id: string, input: { enabled: boolean }): Promise<WatchRule> {
  const value = parse(updateRuleSchema, input);
  return store.mutate(state => {
    const rule = state.rules.find(item => item.id === id);
    if (!rule) throw new StoreError(404, 'RULE_NOT_FOUND', 'Regra não encontrada.');
    assertClass(rule.classId);
    if (rule.enabled !== value.enabled) {
      rule.enabled = value.enabled;
      audit(state, 'autopilot.rule.updated', `Regra ${rule.id}; habilitada: ${rule.enabled}.`, new Date().toISOString());
    }
    return rule;
  });
}

export async function getAutopilot(store: StateStore, env: NodeJS.ProcessEnv = process.env): Promise<AutopilotState> {
  const state = await store.read();
  for (const rule of state.rules) assertClass(rule.classId);
  return {
    rules: state.rules, runs: state.runs,
    drafts: state.actions.filter(action => action.status === 'pending'),
    audit: state.audit, schedule: schedule(env),
  };
}

export async function runAutopilot(
  store: StateStore,
  source: AutopilotRun['source'],
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutopilotState> {
  if ((source !== 'manual' && source !== 'schedule') || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new StoreError(400, 'INVALID_RUN', 'Informe origem e data válidas para a execução.');
  }
  const at = now.toISOString();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const day = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  await store.mutate(state => {
    const actionIds: string[] = [];
    let executed = 0;
    for (const rule of state.rules) {
      assertClass(rule.classId);
      if (!rule.enabled) continue;
      const key = `autopilot:${rule.id}:${day}`;
      if (state.dedupe.includes(key)) continue;
      const operation = operations[rule.kind];
      if (!operation) throw new StoreError(400, 'INVALID_RULE', 'Tipo de regra não suportado.');
      const workspace = buildWorkspace({
        classId: rule.classId, mode: 'autopilot', intent: operation.intent, model: 'guided',
      });
      for (const draft of workspace.actions) {
        draft.createdAt = at;
        state.actions.push(draft);
        actionIds.push(draft.id);
        audit(state, 'autopilot.draft.prepared', `Regra ${rule.id}; origem ${source}; proposta sintética não enviada.`, at, draft.id);
      }
      rule.lastRunAt = at;
      state.dedupe.push(key);
      executed++;
    }
    const run: AutopilotRun = {
      id: randomUUID(), at, source, actionIds,
      summary: `${executed} regra(s) preparada(s); ${actionIds.length} rascunho(s) para revisão humana. Nenhum envio ou registro externo.`,
    };
    state.runs.push(run);
    audit(state, 'autopilot.run', `Origem ${source}; dia ${day} (America/Sao_Paulo). ${run.summary}`, at);
  });
  return getAutopilot(store, env);
}
