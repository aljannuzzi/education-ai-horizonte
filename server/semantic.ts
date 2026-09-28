import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import graphJson from '../ontology/graph.json' with { type: 'json' };
import datasetJson from '../ontology/dataset.json' with { type: 'json' };
import catalogJson from '../skills/catalog.json' with { type: 'json' };
import type {
  ActionDraft, Classroom, Evidence, Intent, Mode, OntologyEdge, OntologyEntity,
  Scenario, SkillDescriptor, SystemDescriptor, Teacher, ToolSpec, TraceStep,
  Widget, Workspace,
} from '../shared/contracts.js';

const intentSchema = z.enum(['brief', 'lesson', 'diary', 'learning', 'writing', 'metrics', 'tool']);
const entityIdSchema = z.enum([
  'teacher', 'classroom', 'lesson', 'curriculum', 'activity', 'evidence',
  'intervention', 'diary-entry', 'support-case', 'writing-sample', 'space', 'material',
]);
type EntityId = z.infer<typeof entityIdSchema>;
const scoped = { id: z.string().min(1), classId: z.string().min(1) };
const count = z.number().int().nonnegative();
const countsSchema = z.object({
  expected: count, received: count, ingested: count, assessed: count, correct: count,
}).strict().refine(
  r => r.correct <= r.assessed && r.assessed <= r.ingested
    && r.ingested <= r.received && r.received <= r.expected,
  'Contagens devem respeitar: acertos ≤ avaliadas ≤ integradas ≤ recebidas ≤ esperadas.',
);
const datasetSchema = z.object({
  asOf: z.iso.datetime({ offset: true }),
  teacher: z.array(z.object({
    id: z.string(), name: z.string(), school: z.string(), subject: z.string(),
  }).strict()).length(1),
  classroom: z.array(z.object({
    id: z.string(), teacherId: z.string(), label: z.string(), grade: z.string(), studentCount: count,
  }).strict()),
  space: z.array(z.object({
    ...scoped, teacherId: z.string(), label: z.string(),
    status: z.enum(['available', 'unavailable']), reason: z.string(), next: z.string(),
  }).strict()),
  material: z.array(z.object({
    ...scoped, teacherId: z.string(), curriculumId: z.string(), title: z.string(),
    format: z.literal('printable'), items: z.array(z.string()).min(1), instruction: z.string(),
  }).strict()),
  lesson: z.array(z.object({
    ...scoped, spaceId: z.string().optional(), topic: z.enum(['water', 'fractions', 'writing']), title: z.string(),
    date: z.iso.date(), status: z.enum(['planned', 'taught']), durationMinutes: z.number().int().min(10).max(120),
  }).strict()),
  curriculum: z.array(z.object({
    ...scoped, lessonId: z.string(), code: z.string(), objective: z.string(),
  }).strict()),
  activity: z.array(z.object({
    ...scoped, curriculumId: z.string(), topic: z.enum(['water', 'fractions', 'writing']),
    title: z.string(), materials: z.array(z.string()),
    stations: z.array(z.object({ title: z.string(), instruction: z.string() }).strict()).max(6),
  }).strict()),
  evidence: z.array(z.object({
    ...scoped, activityId: z.string(), type: z.enum(['resource', 'assessment', 'coverage']),
    summary: z.string(), sourceUpdatedAt: z.iso.datetime({ offset: true }),
    expected: count, received: count, ingested: count, assessed: count, correct: count,
  }).strict().superRefine((row, context) => {
    const result = countsSchema.safeParse({
      expected: row.expected, received: row.received, ingested: row.ingested,
      assessed: row.assessed, correct: row.correct,
    });
    if (!result.success) context.addIssue({ code: 'custom', message: 'Contagens inconsistentes na fonte.' });
    if (row.type !== 'assessment' && row.correct !== 0) {
      context.addIssue({ code: 'custom', message: 'Cobertura e recursos não medem acertos.' });
    }
  })),
  intervention: z.array(z.object({
    ...scoped, evidenceId: z.string(), proposal: z.string(),
  }).strict()),
  'diary-entry': z.array(z.object({
    ...scoped, lessonId: z.string(), calendarPending: z.boolean(), recorded: z.boolean(),
  }).strict()),
  'support-case': z.array(z.object({
    ...scoped, diaryId: z.string(), level: z.enum(['N1', 'N2']), reason: z.string(), next: z.string(),
  }).strict()),
  'writing-sample': z.array(z.object({
    ...scoped, activityId: z.string(), author: z.string(), excerpt: z.string(),
    criterion: z.string(), feedback: z.string(),
  }).strict()),
}).strict();
const data = datasetSchema.parse(datasetJson);
type Row<K extends EntityId> = (typeof data)[K][number];
type RecordRow = { id: string; classId?: string; [key: string]: unknown };

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw Object.assign(new Error(`Dados semânticos incompletos: ${label}.`), {
      status: 500, code: 'SEMANTIC_DATA_ERROR',
    });
  }
  return value;
}

export const teacher: Teacher = { ...required(data.teacher[0], 'professora') };
export const classes: Classroom[] = data.classroom.filter(row => row.teacherId === teacher.id).map(({ id, label, grade, studentCount }) => ({
  id, label, grade, studentCount,
}));
export const systems: SystemDescriptor[] = [
  { id: 'spaces', name: 'Espaços e Manutenção', kind: 'legacy', description: 'Disponibilidade de espaços e orientação de manutenção inteiramente sintéticas; nenhuma reserva ou solicitação é enviada.', simulated: true },
  { id: 'school-record', name: 'Registro Escolar', kind: 'legacy', description: 'Matrículas e vínculo docente; consulta sintética somente leitura.', simulated: true },
  { id: 'diary', name: 'Diário e Frequência', kind: 'legacy', description: 'Calendário, aula efetiva e registro são estados distintos; nenhuma gravação.', simulated: true },
  { id: 'support-ai', name: 'Assistente de Suporte AI', kind: 'ai', description: 'Triagem N1/N2 proposta, nunca preenche diário ou frequência.', simulated: true },
  { id: 'formative', name: 'Avaliação Formativa', kind: 'analytics', description: 'Cobertura e acerto separados, com denominadores e atualização da fonte.', simulated: true },
  { id: 'writing-ai', name: 'Escrita Assistida AI', kind: 'ai', description: 'Trechos sintéticos e rubrica para feedback com revisão humana, sem nota automática.', simulated: true },
  { id: 'library', name: 'Biblioteca/Conteúdo', kind: 'content', description: 'Objetivos curriculares locais e atividades imprimíveis, sem internet.', simulated: true },
];
const systemById = new Map(systems.map(system => [system.id, { ...system }]));
const graph = z.object({
  entities: z.array(z.object({
    id: entityIdSchema, label: z.string(), description: z.string(), systemId: z.string(),
  }).strict()),
  edges: z.array(z.object({
    from: entityIdSchema, to: entityIdSchema, label: z.string(),
    sourceKey: z.string(), targetKey: z.string(),
  }).strict()),
  adapters: z.array(z.object({
    systemId: z.string(), source: z.string(), entities: z.array(entityIdSchema),
    readOnly: z.literal(true), simulated: z.literal(true),
  }).strict()),
}).strict().parse(graphJson);
export const ontology: { entities: OntologyEntity[]; edges: OntologyEdge[] } = {
  entities: graph.entities.map(entity => ({ ...entity })),
  edges: graph.edges.map(({ from, to, label }) => ({ from, to, label })),
};
export const adapterContracts = structuredClone(graph.adapters);

export const toolSpecSchema = z.object({
  kind: z.enum(['station-planner', 'fraction-lab', 'rubric-studio']),
  durationMinutes: z.number().int().min(10).max(120),
  stationCount: z.number().int().min(2).max(6),
  numerator: z.number().int().min(1).max(24),
  denominator: z.number().int().min(2).max(24),
  title: z.string().trim().min(1).max(100)
    .regex(/^[\p{L}\p{N} .,!?'’()\-–]+$/u, 'Use apenas um título em texto simples.')
    .refine(title => !/\b(?:https?|www|javascript|script|select|insert|update|delete|drop|alter|create|union|eval|function|const|let|var|fetch|import|export)\b|\b[\p{L}\p{N}-]+\.[\p{L}]{2,}\b/iu.test(title),
      'Código, SQL e endereços não são parâmetros de ferramenta.'),
}).strict().refine(tool => tool.numerator <= tool.denominator, {
  path: ['numerator'], message: 'Nesta ferramenta, o numerador não pode exceder o denominador.',
});

const catalog = z.object({
  skills: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
    operation: intentSchema, readOnly: z.literal(true),
    routes: z.array(z.array(entityIdSchema).min(2)).min(1),
  }).strict()),
  tools: z.object({
    'station-planner': toolSpecSchema, 'fraction-lab': toolSpecSchema, 'rubric-studio': toolSpecSchema,
  }).strict(),
  rubric: z.array(z.object({
    criterion: z.string(), descriptor: z.string(), question: z.string(),
  }).strict()).min(1),
}).strict().parse(catalogJson);

function entityDefinition(id: EntityId) {
  return required(graph.entities.find(entity => entity.id === id), id);
}

function describeSkill(skill: (typeof catalog.skills)[number]): SkillDescriptor {
  const ids = [...new Set(skill.routes.flat())];
  return {
    id: skill.id, name: skill.name, description: skill.description, readOnly: skill.readOnly,
    systems: [...new Set(ids.map(id => entityDefinition(id).systemId))],
    ontologyPath: ids.map(id => entityDefinition(id).label),
  };
}
export const skills: SkillDescriptor[] = catalog.skills.map(describeSkill);
export const scenarios: Scenario[] = [
  { id: 'before-class', title: 'Antes da aula', prompt: 'O que preciso saber antes da aula?', mode: 'home', tag: 'Preparação' },
  { id: 'water-escape', title: 'Escape room da água', prompt: 'Planeje uma aula escape room de água por estações sem internet.', mode: 'cowork', tag: 'Aula' },
  { id: 'unavailable-lab', title: 'Laboratório indisponível', prompt: 'O laboratorio ficou indisponivel. Como mantenho minha aula?', mode: 'cowork', tag: 'Alternativa offline' },
  { id: 'diary-check', title: 'Diário e calendário', prompt: 'Confira a pendência de diário versus aula efetiva e proponha ticket.', mode: 'autopilot', tag: 'Triagem' },
  { id: 'fraction-recovery', title: 'Recomposição de frações', prompt: 'Sugira recomposição de frações sem rotular estudantes.', mode: 'cowork', tag: 'Aprendizagem' },
  { id: 'human-feedback', title: 'Feedback de escrita', prompt: 'Revise a escrita usando rubrica e trechos sintéticos.', mode: 'cowork', tag: 'Escrita' },
  { id: 'grounded-measures', title: 'Completude não é acerto', prompt: 'Mostre métricas e separe dado atrasado de aprendizagem, com denominadores.', mode: 'home', tag: 'Indicadores' },
  { id: 'station-tool', title: 'Planejador de estações', prompt: 'Crie uma ferramenta station-planner sem internet.', mode: 'code', tag: 'Ferramenta' },
  { id: 'fraction-tool', title: 'Laboratório de frações', prompt: 'Configure a ferramenta fraction-lab.', mode: 'code', tag: 'Ferramenta' },
  { id: 'rubric-tool', title: 'Estúdio de rubrica', prompt: 'Configure a ferramenta rubric-studio.', mode: 'code', tag: 'Ferramenta' },
];

export function assertClass(classId: string): void {
  const owner = required(data.teacher[0], 'professora').id;
  if (!data.classroom.some(row => row.id === classId && row.teacherId === owner)) {
    throw Object.assign(new Error('Turma não autorizada para esta professora.'), {
      status: 403, code: 'CLASS_FORBIDDEN',
    });
  }
}

function normalize(message: string): string {
  return message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function inferIntent(message: string): Intent {
  const text = normalize(message);
  if (/\blaboratorio\b/.test(text) && /indisponivel|interditad|fechad|sem acesso|nao (?:esta )?disponivel/.test(text)) return 'lesson';
  if (/\b(ferramenta|simulador|laboratorio|miniapp|aplicativo)\b|station-planner|fraction-lab|rubric-studio/.test(text)) return 'tool';
  if (/metricas?|indicadores?|dashboard|completude|denominador|dado[s]? atrasad|percentual|taxa de acerto/.test(text)) return 'metrics';
  if (/diario|frequencia|pendencia|calendario|ticket|suporte|triagem/.test(text)) return 'diary';
  if (/antes d[ae] aula|antes da minha aula|brief|panorama|resumo|preparar para a aula/.test(text)) return 'brief';
  if (/recompos|fracoes|fracao|aprendizagem|recuperacao/.test(text)) return 'learning';
  if (/escrita|redacao|rubrica|feedback|devolutiva|trechos|texto/.test(text)) return 'writing';
  if (/aula|escape|agua|estacoes|sem internet|plano/.test(text)) return 'lesson';
  return 'brief';
}

export function defaultToolSpec(message: string): ToolSpec {
  const text = normalize(message);
  const kind: ToolSpec['kind'] = /rubric|escrita|redacao/.test(text) ? 'rubric-studio'
    : /fraction|fracao|fracoes/.test(text) ? 'fraction-lab' : 'station-planner';
  const duration = text.match(/(-?\d+(?:[.,]\d+)?)\s*min(?:utos?)?\b/);
  const stations = text.match(/(-?\d+(?:[.,]\d+)?)\s*estac(?:oes|ao)\b/);
  const fraction = text.match(/(-?\d+)\s*\/\s*(-?\d+)/);
  const result = { ...catalog.tools[kind] };
  if (duration?.[1]) result.durationMinutes = Number(duration[1].replace(',', '.'));
  if (stations?.[1]) result.stationCount = Number(stations[1].replace(',', '.'));
  if (fraction?.[1] && fraction[2]) {
    result.numerator = Number(fraction[1]);
    result.denominator = Number(fraction[2]);
  }
  return toolSpecSchema.parse(result);
}

export interface AdapterResult {
  entity: EntityId;
  record: RecordRow;
  evidenceId: string;
  path: string[];
  provenance: {
    sourceSystem: string; sourceKind: SystemDescriptor['kind']; source: string;
    capturedAt: string; sourceUpdatedAt: string; classId: string;
    readOnly: true; simulated: true;
  };
}
export interface SkillExecution {
  skill: SkillDescriptor;
  results: AdapterResult[];
  evidence: Evidence[];
  trace: TraceStep[];
}

function sourceRows(entity: EntityId, classId: string): RecordRow[] {
  return data[entity].filter(row => {
    if ('teacherId' in row && row.teacherId !== required(data.teacher[0], 'professora').id) return false;
    if (entity === 'teacher') return row.id === required(data.teacher[0], 'professora').id;
    if (entity === 'classroom') return row.id === classId;
    return 'classId' in row && row.classId === classId;
  });
}

function summarize(entity: EntityId, record: RecordRow): string {
  switch (entity) {
    case 'space': {
      const r = record as Row<'space'>;
      return `${r.label}: ${r.status === 'unavailable' ? 'indisponível' : 'disponível'}. ${r.reason} ${r.next}`;
    }
    case 'material': {
      const r = record as Row<'material'>;
      return `${r.title}; material imprimível da docente ${r.teacherId}. Itens: ${r.items.join(', ')}. ${r.instruction}`;
    }
    case 'teacher': {
      const r = record as Row<'teacher'>;
      return `Professora ${r.name}, escola ${r.school}; ${r.subject}.`;
    }
    case 'classroom': {
      const r = record as Row<'classroom'>;
      return `${r.label}, ${r.grade}: ${r.studentCount} estudantes no retrato de matrículas.`;
    }
    case 'lesson': {
      const r = record as Row<'lesson'>;
      return `${r.title}; ${r.date}; ${r.status === 'taught' ? 'aula efetivamente realizada' : 'apenas planejada'}; ${r.durationMinutes} minutos.`;
    }
    case 'curriculum': {
      const r = record as Row<'curriculum'>;
      return `${r.code}: ${r.objective} Objetivo local, não código curricular oficial.`;
    }
    case 'activity': {
      const r = record as Row<'activity'>;
      return `${r.title}. Materiais: ${r.materials.join(', ')}. ${r.stations.map(s => `${s.title}: ${s.instruction}`).join(' ')}`;
    }
    case 'evidence': {
      const r = record as Row<'evidence'>;
      return `${r.summary} Fonte atualizada em ${r.sourceUpdatedAt}. Esperadas: ${r.expected}; recebidas: ${r.received}; integradas: ${r.ingested}; avaliadas: ${r.assessed}${r.type === 'assessment' ? `; corretas: ${r.correct}` : '; acerto não se aplica'}.`;
    }
    case 'intervention': return (record as Row<'intervention'>).proposal;
    case 'diary-entry': {
      const r = record as Row<'diary-entry'>;
      return `Alerta de calendário: ${r.calendarPending ? 'sim' : 'não'}; registro existente: ${r.recorded ? 'sim' : 'não'}. Não confirma presença individual.`;
    }
    case 'support-case': {
      const r = record as Row<'support-case'>;
      return `${r.level}: ${r.reason} ${r.next} Apenas proposta de triagem; suporte nunca preenche diário.`;
    }
    case 'writing-sample': {
      const r = record as Row<'writing-sample'>;
      return `${r.author}, trecho sintético: “${r.excerpt}” Critério: ${r.criterion}. Proposta para revisão humana: ${r.feedback}`;
    }
  }
}

// Joins and adapter selection come from the JSON graph, not from an intent-specific shortcut.
export function executeSkill(skillId: string, classId: string): SkillExecution {
  assertClass(classId);
  const definition = required(catalog.skills.find(skill => skill.id === skillId), 'skill executável');
  const found = new Map<string, AdapterResult>();
  for (const route of definition.routes) {
    if (route[0] !== 'teacher') required(undefined, 'rota deve começar pela professora');
    let parents: AdapterResult[] = [];
    for (const [index, entity] of route.entries()) {
      const descriptor = entityDefinition(entity);
      const adapter = required(graph.adapters.find(a =>
        a.systemId === descriptor.systemId && a.entities.includes(entity)), `adaptador de ${entity}`);
      const system = required(systemById.get(adapter.systemId), 'sistema da fonte');
      const previous = route[index - 1];
      const edge = index === 0 ? undefined : required(graph.edges.find(e =>
        e.from === previous && e.to === entity), `aresta ${previous} → ${entity}`);
      const next: AdapterResult[] = [];
      for (const record of sourceRows(entity, classId)) {
        const parent = edge ? parents.find(p =>
          p.record[edge.sourceKey] !== undefined
          && p.record[edge.sourceKey] === record[edge.targetKey]) : undefined;
        if (edge && !parent) continue;
        const path = [...(parent?.path ?? []), descriptor.label];
        const baseKey = `${entity}:${record.id}`;
        // Keep distinct paths when a record is reached through multiple JSON routes.
        const key = `${baseKey}:${path.join('>')}`;
        const existing = [...found.values()].some(result => result.entity === entity && result.record.id === record.id);
        const result: AdapterResult = found.get(key) ?? {
          entity, record: structuredClone(record),
          evidenceId: `ev:${classId}:${baseKey}${existing ? `:${route.slice(0, index + 1).join('.')}` : ''}`,
          path,
          provenance: {
            sourceSystem: system.id, sourceKind: system.kind, source: adapter.source,
            capturedAt: data.asOf,
            sourceUpdatedAt: typeof record.sourceUpdatedAt === 'string' ? record.sourceUpdatedAt : data.asOf,
            classId, readOnly: true, simulated: true,
          },
        };
        found.set(key, result);
        next.push(result);
      }
      parents = next;
    }
  }
  const results = [...found.values()];
  const evidence: Evidence[] = results.map(result => ({
    id: result.evidenceId, label: `${entityDefinition(result.entity).label} · ${result.record.id}`,
    sourceSystem: result.provenance.sourceSystem, sourceKind: result.provenance.sourceKind,
    path: [...result.path], synthetic: true,
    summary: `${summarize(result.entity, result.record)} Fonte: ${result.provenance.source}. Retrato sintético: ${result.provenance.capturedAt}.`,
  }));
  const trace: TraceStep[] = [...new Set(results.map(result => result.entity))].map(entity => {
    const matches = results.filter(result => result.entity === entity);
    const first = required(matches[0], 'evidência da etapa');
    return {
      id: `trace:${classId}:${definition.id}:${entity}`,
      label: `Consulta somente leitura · ${first.path.join(' → ')}`,
      skill: definition.id, system: first.provenance.sourceSystem,
      evidenceIds: matches.map(result => result.evidenceId), status: 'completed',
    };
  });
  return { skill: describeSkill(definition), results, evidence, trace };
}

function rows<K extends EntityId>(execution: SkillExecution, entity: K): Row<K>[] {
  return [...new Map(execution.results.filter(result => result.entity === entity)
    .map(result => [result.record.id, result.record as Row<K>])).values()];
}
function refs(execution: SkillExecution, ids: string[]): AdapterResult[] {
  return execution.results.filter(result => ids.includes(result.record.id));
}
function citation(results: AdapterResult[]): string {
  if (results.length === 0) required(undefined, 'resultado sem proveniência');
  return `Evidências: ${results.map(result => result.evidenceId).join(', ')}. Caminhos: ${
    [...new Set(results.map(result => result.path.join(' → ')))].join(' | ')}.`;
}
function grounded(widget: Widget, results: AdapterResult[]): Widget {
  const source = citation(results);
  return {
    ...widget, subtitle: [widget.subtitle, source].filter(Boolean).join(' '),
    ...(widget.items ? { items: widget.items.map(item => ({
      ...item, meta: [item.meta, source].filter(Boolean).join(' '),
    })) } : {}),
    ...(widget.metrics ? { metrics: widget.metrics.map(metric => ({
      ...metric, detail: `${metric.detail} ${source}`,
    })) } : {}),
  };
}

export function calculateMeasures(input: z.infer<typeof countsSchema>) {
  const c = countsSchema.parse(input);
  return {
    ...c,
    notReceived: c.expected - c.received,
    notYetIntegrated: c.received - c.ingested,
    awaitingAssessment: c.ingested - c.assessed,
    needsReview: c.assessed - c.correct,
    completionPercent: c.expected === 0 ? null : 100 * c.ingested / c.expected,
    accuracyPercent: c.assessed === 0 ? null : 100 * c.correct / c.assessed,
  };
}
function percent(value: number | null): string {
  return value === null ? 'Não disponível' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
function topicContext(execution: SkillExecution, topic: Row<'lesson'>['topic']) {
  const lesson = required(rows(execution, 'lesson').find(row => row.topic === topic), `aula de ${topic}`);
  const curriculum = required(rows(execution, 'curriculum').find(row => row.lessonId === lesson.id), 'habilidade curricular');
  const activity = required(rows(execution, 'activity').find(row => row.curriculumId === curriculum.id), 'atividade');
  const observation = required(rows(execution, 'evidence').find(row => row.activityId === activity.id), 'evidência da atividade');
  const interventions = rows(execution, 'intervention').filter(row => row.evidenceId === observation.id);
  return { lesson, curriculum, activity, observation, interventions,
    sources: refs(execution, [lesson.id, curriculum.id, activity.id, observation.id, ...interventions.map(row => row.id)]) };
}
function measuresFor(observation: Row<'evidence'>) {
  return calculateMeasures({
    expected: observation.expected, received: observation.received, ingested: observation.ingested,
    assessed: observation.assessed, correct: observation.correct,
  });
}
function numericWidget(execution: SkillExecution): Widget {
  const { observation } = topicContext(execution, 'fractions');
  const m = measuresFor(observation);
  return grounded({
    id: 'fraction-measures', type: 'metrics', title: 'Frações: completude não é aprendizagem',
    subtitle: `Unidade: uma resposta por estudante neste instrumento. Fonte em ${observation.sourceUpdatedAt}; retrato em ${data.asOf}.`,
    metrics: [
      { label: 'Completude no analytics', value: percent(m.completionPercent), detail: `${m.ingested} de ${m.expected} respostas esperadas estão integradas.` },
      { label: 'Acerto entre avaliadas', value: percent(m.accuracyPercent), detail: `${m.correct} de ${m.assessed} respostas avaliadas estão corretas; não usa a matrícula como denominador.` },
      { label: 'Aguardando integração', value: String(m.notYetIntegrated), detail: `${m.received} recebidas menos ${m.ingested} integradas. Atraso de dado não é dificuldade de aprendizagem.` },
      { label: 'Aguardando avaliação', value: String(m.awaitingAssessment), detail: `${m.ingested} integradas menos ${m.assessed} avaliadas; não contam como erro.` },
      { label: 'Ainda não recebidas', value: String(m.notReceived), detail: `${m.expected} esperadas menos ${m.received} recebidas; não permite inferir falta ou desempenho.` },
      { label: 'Respostas para revisão', value: String(m.needsReview), detail: `${m.assessed} avaliadas menos ${m.correct} corretas; observar justificativas, sem rotular estudantes.` },
    ],
  }, refs(execution, [observation.id]));
}
function diaryFacts(execution: SkillExecution) {
  const lessons = rows(execution, 'lesson');
  const entries = rows(execution, 'diary-entry');
  const pending = entries.filter(entry =>
    !entry.recorded && lessons.some(lesson => lesson.id === entry.lessonId && lesson.status === 'taught'));
  const calendarOnly = entries.filter(entry =>
    entry.calendarPending && lessons.some(lesson => lesson.id === entry.lessonId && lesson.status === 'planned'));
  return { lessons, entries, pending, calendarOnly };
}
function draft(kind: ActionDraft['kind'], title: string, target: string, content: string, sources: AdapterResult[]): ActionDraft {
  return {
    id: randomUUID(), version: 1, title, kind, target,
    content: `${content}\nProposta sintética para revisão humana; nenhuma gravação ou envio ao destino.\n${citation(sources)}`,
    status: 'pending', createdAt: new Date().toISOString(),
    evidenceIds: sources.map(result => result.evidenceId), simulated: true,
  };
}

function renderLesson(execution: SkillExecution): { widgets: Widget[]; actions: ActionDraft[] } {
  const context = topicContext(execution, 'water');
  const { lesson, curriculum, activity, sources } = context;
  const stationCount = activity.stations.length;
  if (stationCount < 2) required(undefined, 'estações imprimíveis');
  const baseMinutes = Math.floor(lesson.durationMinutes / stationCount);
  const remainder = lesson.durationMinutes % stationCount;
  const items = activity.stations.map((station, index) => ({
    title: `${station.title} · ${baseMinutes + (index < remainder ? 1 : 0)} minutos`,
    body: station.instruction,
  }));
  const plan = grounded({
    id: 'offline-lesson', type: 'plan', title: 'Escape room da água: estações sem internet',
    subtitle: `${lesson.date}; ${lesson.durationMinutes} minutos; ${stationCount} estações. ${curriculum.objective} Materiais: ${activity.materials.join(', ')}. Kit proposto; não comprova aula realizada.`,
    items: [...items, { title: 'Mediação e observação', body: 'A professora valida as justificativas e libera as pistas em papel. O desafio termina em uma explicação coletiva, sem cadeados, telas ou internet; registrar observações somente após a aula e revisão humana.' }],
  }, sources);
  const unavailable = rows(execution, 'space').find(space => space.id === lesson.spaceId && space.status === 'unavailable');
  const widgets: Widget[] = [plan];
  const actions = [draft('lesson-kit', 'Revisar kit de estações', 'Biblioteca/Conteúdo — proposta local',
    `${curriculum.objective}\n${items.map(item => `${item.title}: ${item.body}`).join('\n')}\nMateriais: ${activity.materials.join(', ')}.`, sources)];
  if (unavailable) {
    const materials = rows(execution, 'material').filter(material => material.curriculumId === curriculum.id);
    required(materials[0], 'material docente autorizado para alternativa offline');
    const alternativeSources = refs(execution, [unavailable.id, lesson.id, lesson.classId, curriculum.id, ...materials.map(material => material.id)]);
    const alternative = `${unavailable.label} indisponível: ${unavailable.reason}\n`
      + `Manter o objetivo: ${curriculum.objective}\n`
      + materials.map(material => `${material.title}: ${material.instruction} Separar: ${material.items.join(', ')}.`).join('\n')
      + '\nAlternativa proposta em sala comum, sujeita à confirmação docente; não comprova aula realizada nem aprendizagem.';
    widgets.push(grounded({
      id: 'unavailable-space', type: 'plan', title: 'Laboratório indisponível: manter a aula sem internet',
      subtitle: `${unavailable.label}; ${lesson.title}. ${curriculum.objective}`,
      items: materials.map(material => ({
        title: material.title, body: `${material.instruction} Materiais: ${material.items.join(', ')}.`,
      })).concat({ title: 'Conferência docente', body: 'Confirmar o uso da sala comum antes da aula. A conclusão da atividade não comprova aprendizagem; observar justificativas depois da aula.' }),
    }, alternativeSources));
    actions[0] = draft('lesson-kit', 'Revisar alternativa offline e kit de estações',
      'Biblioteca/Conteúdo — proposta local', `${alternative}\n${items.map(item => `${item.title}: ${item.body}`).join('\n')}`,
      [...sources, ...alternativeSources]);
    actions.push(draft('support-ticket', 'Revisar solicitação simulada de manutenção',
      'Espaços e Manutenção — triagem proposta',
      `${unavailable.label}; aula ${lesson.title}, ${lesson.date}. ${unavailable.reason}\n${unavailable.next}\n`
        + 'Solicitação não enviada. Suporte nunca preenche diário ou frequência; não alterar reserva, realização ou resultados de aprendizagem.',
      alternativeSources));
  }
  return {
    widgets, actions,
  };
}

function renderDiary(execution: SkillExecution): { widgets: Widget[]; actions: ActionDraft[] } {
  const { lessons, entries, pending, calendarOnly } = diaryFacts(execution);
  const support = rows(execution, 'support-case');
  const sources = refs(execution, [...lessons, ...entries, ...support].map(row => row.id));
  const widgets: Widget[] = [grounded({
    id: 'diary-reconciliation', type: 'table', title: 'Calendário versus aula efetivamente realizada',
    subtitle: `${calendarOnly.length} alerta(s) apenas de calendário; ${pending.length} pendência(s) de aula efetiva. Frequência individual não é inferida.`,
    columns: ['Aula', 'Data', 'Realização', 'Registro', 'Evidência e caminho'],
    rows: entries.map(entry => {
      const lesson = required(lessons.find(row => row.id === entry.lessonId), 'aula do registro');
      return [lesson.title, lesson.date, lesson.status === 'taught' ? 'Efetivamente realizada' : 'Apenas planejada',
        entry.recorded ? 'Registrado' : lesson.status === 'taught' ? 'Pendente de conferência docente' : 'Não exigir preenchimento antecipado',
        citation(refs(execution, [entry.id, lesson.id]))];
    }),
  }, sources), grounded({
    id: 'support-triage', type: 'diagnosis', title: 'Suporte propõe triagem; nunca preenche diário',
    items: support.map(row => ({
      title: `${row.level} · ${row.reason}`, body: row.next,
      meta: citation(refs(execution, [row.id])),
    })),
  }, sources)];
  const actions: ActionDraft[] = [];
  if (support.length) actions.push(draft('support-ticket', 'Revisar ticket proposto N1/N2',
    'Assistente de Suporte AI — triagem proposta',
    support.map(row => `${row.level}: ${row.reason} ${row.next}`).join('\n')
      + '\nN1 confere calendário, horários e recibos; N2 investiga integração somente se necessário. Suporte nunca preenche diário ou frequência.', sources));
  for (const entry of pending) {
    const lesson = required(lessons.find(row => row.id === entry.lessonId), 'aula pendente');
    actions.push(draft('diary-draft', 'Conferir registro de aula efetiva', 'Diário e Frequência — rascunho para a docente',
      `${lesson.title}, ${lesson.date}: realização consta na fonte. Conteúdo efetivamente ministrado e frequência devem ser confirmados pela professora; não preencher automaticamente.`,
      refs(execution, [entry.id, lesson.id])));
  }
  return { widgets, actions };
}

function renderLearning(execution: SkillExecution): { widgets: Widget[]; actions: ActionDraft[] } {
  const context = topicContext(execution, 'fractions');
  const proposals = context.interventions.map(row => ({ title: 'Recomposição revisável', body: row.proposal }));
  required(proposals[0], 'intervenção de frações');
  return {
    widgets: [numericWidget(execution), grounded({
      id: 'fraction-recomposition', type: 'diagnosis', title: 'Recomposição de frações sem rótulos',
      subtitle: context.curriculum.objective,
      items: [...proposals, {
        title: 'Próxima observação',
        body: 'Pedir nova representação e justificativa com o mesmo inteiro. Reorganizar apoios conforme a observação docente; não classificar estudantes por dados ausentes ou atrasados.',
      }],
    }, context.sources)],
    actions: [draft('lesson-kit', 'Revisar proposta de recomposição', 'Biblioteca/Conteúdo — proposta local',
      proposals.map(item => item.body).join('\n'), context.sources)],
  };
}

function renderWriting(execution: SkillExecution): { widgets: Widget[]; actions: ActionDraft[] } {
  const context = topicContext(execution, 'writing');
  const samples = rows(execution, 'writing-sample').filter(row => row.activityId === context.activity.id);
  required(samples[0], 'trecho sintético');
  const sampleSources = refs(execution, samples.map(row => row.id));
  const rubricSource = refs(execution, [context.curriculum.id, context.activity.id]);
  const widgets: Widget[] = [
    grounded({
      id: 'writing-rubric', type: 'table', title: 'Rubrica qualitativa para revisão humana',
      subtitle: 'Critérios declarados no catálogo de skills, sem pontuação automática nem inferência sobre toda a turma.',
      columns: ['Critério', 'Descritor', 'Pergunta de revisão'],
      rows: catalog.rubric.map(row => [row.criterion, row.descriptor, row.question]),
    }, rubricSource),
    grounded({
      id: 'synthetic-writing', type: 'writing', title: 'Trechos inteiramente sintéticos',
      subtitle: 'São exemplos, não textos reais nem amostra representativa. A professora revisa cada devolutiva antes de qualquer uso.',
      items: samples.map(row => ({
        title: `${row.author} · ${row.criterion}`, body: `“${row.excerpt}”\nProposta de feedback: ${row.feedback}`,
        meta: citation(refs(execution, [row.id])),
      })),
    }, sampleSources),
  ];
  return {
    widgets,
    actions: [draft('feedback-draft', 'Revisar feedback humano', 'Escrita Assistida AI — devolutiva não enviada',
      samples.map(row => `${row.author}: “${row.excerpt}”\n${row.criterion}: ${row.feedback}`).join('\n'),
      [...rubricSource, ...sampleSources])],
  };
}

function renderMetrics(execution: SkillExecution): { widgets: Widget[]; actions: ActionDraft[] } {
  const context = topicContext(execution, 'fractions');
  const m = measuresFor(context.observation);
  const sources = refs(execution, [context.observation.id]);
  return {
    widgets: [numericWidget(execution), grounded({
      id: 'measure-caveats', type: 'diagnosis', title: 'Dado atrasado não é evidência de não aprendizagem',
      items: [
        { title: 'Denominadores distintos', body: 'Completude compara respostas integradas com esperadas. Acerto compara corretas somente com avaliadas. Estes instrumentos não medem toda a aprendizagem da turma.' },
        { title: 'Atualização e ausência', body: `${m.notYetIntegrated} recebidas aguardam integração; ${m.notReceived} esperadas ainda não foram recebidas. Datas de atualização não provam falha técnica; não imputar notas ou faltas.` },
      ],
    }, sources)],
    actions: m.notYetIntegrated > 0 ? [draft('support-ticket', 'Conferir atraso da coleta',
      'Assistente de Suporte AI — triagem proposta',
      `${m.notYetIntegrated} respostas recebidas ainda não integradas. N1 verifica recibos e horários; N2 investiga integração se necessário. Isso não comprova dificuldade de aprendizagem. Nunca preencher diário.`, sources)] : [],
  };
}

function renderTool(execution: SkillExecution, spec: ToolSpec): { widgets: Widget[]; actions: ActionDraft[] } {
  const context = topicContext(execution, spec.kind === 'fraction-lab' ? 'fractions' : spec.kind === 'rubric-studio' ? 'writing' : 'water');
  const guidance = spec.kind === 'station-planner'
    ? `${spec.stationCount} estações em ${spec.durationMinutes} minutos. Tempo médio de ${Number((spec.durationMinutes / spec.stationCount).toFixed(2)).toLocaleString('pt-BR')} minutos por estação; preparar pistas em papel.`
    : spec.kind === 'fraction-lab'
      ? `Representar ${spec.numerator}/${spec.denominator} do mesmo inteiro em papel, comparando partes iguais e justificativas.`
      : `Usar os critérios ${catalog.rubric.map(row => row.criterion).join(', ')} com revisão humana, sem nota automática.`;
  return {
    widgets: [grounded({
      id: 'bounded-tool', type: 'tool', title: spec.title, tool: { ...spec },
      subtitle: 'Parâmetros de simulação, não métricas da turma. Configuração declarativa limitada; não executa código, SQL ou endereços.',
      items: [{ title: 'Uso proposto', body: guidance }],
    }, context.sources)],
    actions: [draft('lesson-kit', 'Revisar configuração da ferramenta', 'Biblioteca/Conteúdo — configuração local',
      `${spec.title}: ${guidance}\nParâmetros de simulação; não representam resultados de estudantes.`, context.sources)],
  };
}

const workspaceInputSchema = z.object({
  classId: z.string(), mode: z.enum(['home', 'cowork', 'code', 'autopilot']), intent: intentSchema,
  model: z.enum(['guided', 'azure-openai']), toolSpec: toolSpecSchema.optional(), plan: z.string().max(16000).optional(),
}).strict();

export function buildWorkspace(input: {
  classId: string; mode: Mode; intent: Intent; model: 'guided' | 'azure-openai'; toolSpec?: ToolSpec; plan?: string;
}): Workspace {
  assertClass(input.classId);
  const parsed = workspaceInputSchema.parse(input);
  const definition = required(catalog.skills.find(skill => skill.operation === parsed.intent), 'operação da skill');
  const execution = executeSkill(definition.id, parsed.classId);
  const classroom = required(rows(execution, 'classroom')[0], 'turma vinculada');
  let rendered: { widgets: Widget[]; actions: ActionDraft[] };
  switch (definition.operation) {
    case 'brief': {
      const context = topicContext(execution, 'water');
      const diary = diaryFacts(execution);
      const sources = [...refs(execution, [classroom.id, ...diary.entries.map(row => row.id)]), ...context.sources];
      rendered = {
        widgets: [grounded({
          id: 'before-class', type: 'timeline', title: 'Antes da aula',
          subtitle: `Retrato sintético em ${data.asOf}; não é consulta em tempo real.`,
          items: [
            { title: `${classroom.label} · ${classroom.studentCount} estudantes`, body: `${context.lesson.title}, prevista para ${context.lesson.date}, ${context.lesson.durationMinutes} minutos. Ainda não realizada.` },
            { title: 'Preparação sem internet', body: `${context.curriculum.objective} Separar: ${context.activity.materials.join(', ')}.` },
            { title: 'Pendências que merecem conferência', body: `${diary.pending.length} de aula efetiva; ${diary.calendarOnly.length} apenas de calendário. Suporte não registra aula ou frequência.` },
          ],
        }, sources), numericWidget(execution)],
        actions: [],
      };
      break;
    }
    case 'lesson': rendered = renderLesson(execution); break;
    case 'diary': rendered = renderDiary(execution); break;
    case 'learning': rendered = renderLearning(execution); break;
    case 'writing': rendered = renderWriting(execution); break;
    case 'metrics': rendered = renderMetrics(execution); break;
    case 'tool': rendered = renderTool(execution, parsed.toolSpec ?? defaultToolSpec('station-planner')); break;
  }
  // Free-form model plans are deliberately not rendered: they cannot become a source of facts.
  return {
    id: randomUUID(), title: `${definition.name} · ${classroom.label}`,
    summary: `${definition.description} Turma ${classroom.label}; dados e adaptadores inteiramente sintéticos, somente leitura.`,
    mode: parsed.mode, intent: parsed.intent, model: parsed.model,
    modelNotice: parsed.model === 'guided'
      ? 'Modo guiado explícito. Travessia e cálculos determinísticos; sem chamada a modelo e sem gravação em destinos.'
      : 'Roteamento Azure OpenAI informado pelo chamador. Texto livre do plano não é exibido; fatos, métricas e propostas vêm do dataset e das regras determinísticas, não do modelo. Sem gravação em destinos.',
    widgets: rendered.widgets, evidence: execution.evidence, trace: execution.trace, actions: rendered.actions,
    followUps: ['Conferir as fontes e seus caminhos na ontologia.', 'Revisar propostas antes de qualquer uso; nenhum destino foi alterado.'],
  };
}
