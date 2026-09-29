import { z } from 'zod';
import type {
  CostBasis, CostComponent, CostLine, CostPath, CostPriceBook,
  QuestionCostCapture, QuestionCostReceipt,
} from './cost-contracts.js';

const bounded = z.number().finite().min(0).max(1e12);
const count = bounded.int();
const duration = count.max(86_400_000);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestamp = z.iso.datetime({ offset: true });
const pathSchema = z.enum(['cowork-fabric-iq', 'azure-mcp', 'local-guided']);
const sourceText = z.string().min(1).max(500).refine(value => {
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (/(?:bearer\s|password|api[-_ ]?key|access[-_ ]?token|secret|[?&](?:sig|token|code)=)/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('://')) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && !url.search && !url.hash;
    } catch { return false; }
  }
  return !/[?&=@\\]/.test(value);
}, 'Informe uma fonte textual ou URL HTTPS sem credenciais, parâmetros ou fragmentos.');

const modelUsageSchema = z.strictObject({
  model: identifier,
  outcome: z.enum(['succeeded', 'failed']),
  durationMs: duration,
  inputTokens: count.nullable(),
  cachedInputTokens: count.nullable(),
  outputTokens: count.nullable(),
  reasoningOutputTokens: count.nullable(),
  source: z.enum(['provider-usage', 'operator', 'example']),
  requestId: identifier.optional(),
}).superRefine((value, ctx) => {
  if (value.inputTokens !== null && value.cachedInputTokens !== null
      && value.cachedInputTokens > value.inputTokens) {
    ctx.addIssue({ code: 'custom', path: ['cachedInputTokens'], message: 'Cache excede tokens de entrada.' });
  }
  if (value.outputTokens !== null && value.reasoningOutputTokens !== null
      && value.reasoningOutputTokens > value.outputTokens) {
    ctx.addIssue({ code: 'custom', path: ['reasoningOutputTokens'], message: 'Raciocínio excede tokens de saída.' });
  }
});

const captureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  questionId: identifier,
  scope: z.enum(['question', 'tool-call', 'task']),
  path: pathSchema,
  origin: z.enum(['application-metered', 'operator-entered', 'synthetic-example']),
  startedAt: timestamp,
  endedAt: timestamp,
  outcome: z.enum(['succeeded', 'failed', 'partial']),
  modelCalls: z.array(modelUsageSchema).max(32),
  runtime: z.strictObject({
    durationMs: duration.nullable(),
    vcpu: bounded.positive().max(1024).nullable(),
    memoryGiB: bounded.positive().max(1_048_576).nullable(),
    requests: count.nullable(),
    basis: z.enum(['wall-clock-estimate', 'attributed-usage', 'unavailable']),
  }),
  fabric: z.strictObject({
    cuSeconds: bounded.nullable(),
    operations: count.nullable(),
    source: z.enum(['capacity-metrics', 'operator-estimate', 'unavailable']),
    correlation: z.enum(['operation-id', 'time-window', 'unavailable']),
  }),
  cowork: z.strictObject({
    creditsBefore: bounded.nullable(),
    creditsAfter: bounded.nullable(),
    source: z.enum(['native-cost-command', 'admin-export', 'unavailable']),
    isolatedQuestion: z.boolean(),
    concurrentActivity: z.boolean(),
  }),
}).superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) issue('endedAt', 'Fim anterior ao início.');
  const runtimeUsed = [value.runtime.durationMs, value.runtime.vcpu,
    value.runtime.memoryGiB, value.runtime.requests].some(v => v !== null);
  const fabricUsed = value.fabric.cuSeconds !== null || value.fabric.operations !== null;
  const coworkUsed = value.cowork.creditsBefore !== null || value.cowork.creditsAfter !== null;
  if (value.path !== 'azure-mcp' && (value.modelCalls.length > 0 || runtimeUsed
      || value.runtime.basis !== 'unavailable')) issue('path', 'Este caminho não utiliza Azure OpenAI nem contêiner Azure.');
  if (value.path === 'local-guided' && (fabricUsed || value.fabric.source !== 'unavailable'
      || value.fabric.correlation !== 'unavailable')) issue('fabric', 'Fabric não se aplica ao caminho local.');
  if (value.path !== 'cowork-fabric-iq' && (coworkUsed || value.cowork.source !== 'unavailable')) {
    issue('cowork', 'Créditos nativos não se aplicam a este caminho.');
  }
  if (value.runtime.basis === 'unavailable' && runtimeUsed) issue('runtime', 'Uso exige uma base de medição.');
  // Contar operações não mede CU-segundos; o aplicativo pode conhecer só o contador.
  if (value.fabric.source === 'unavailable' && value.fabric.cuSeconds !== null) {
    issue('fabric', 'Uso exige uma fonte de medição.');
  }
  if (value.cowork.source === 'unavailable' && coworkUsed) issue('cowork', 'Créditos exigem uma fonte.');
  if (value.cowork.creditsBefore !== null && value.cowork.creditsAfter !== null
      && value.cowork.creditsAfter < value.cowork.creditsBefore) {
    issue('cowork', 'Contador cumulativo de créditos retrocedeu; delta negativo inválido.');
  }
});

const priceBookSchema = z.strictObject({
  id: identifier,
  kind: z.enum(['configured', 'illustrative']),
  currency: z.enum(['USD', 'BRL', 'EUR']),
  effectiveDate: z.iso.date(),
  source: sourceText,
  openAi: z.array(z.strictObject({
    model: identifier,
    inputPerMillion: bounded.nullable(),
    cachedInputPerMillion: bounded.nullable(),
    outputPerMillion: bounded.nullable(),
  })).max(128),
  container: z.strictObject({
    vcpuSecond: bounded.nullable(),
    memoryGiBSecond: bounded.nullable(),
    millionRequests: bounded.nullable(),
  }),
  fabric: z.strictObject({
    capacityCu: bounded.min(0.000001).nullable(),
    capacityHourly: bounded.nullable(),
  }),
  cowork: z.strictObject({ perCredit: bounded.nullable() }),
  shared: z.strictObject({
    periodLabel: sourceText,
    periodCost: bounded.nullable(),
    questionCount: count.positive().nullable(),
  }),
}).superRefine((value, ctx) => {
  const models = new Set<string>();
  value.openAi.forEach((rate, index) => {
    if (models.has(rate.model)) ctx.addIssue({
      code: 'custom', path: ['openAi', index, 'model'], message: 'Modelo duplicado na tabela de preços.',
    });
    models.add(rate.model);
  });
});

export function parseCapture(value: unknown): QuestionCostCapture {
  return captureSchema.parse(value);
}

export function parsePriceBook(value: unknown): CostPriceBook {
  return priceBookSchema.parse(value);
}

export function createEmptyCapture(path: CostPath, questionId: string, now?: string): QuestionCostCapture {
  const time = now === undefined ? new Date().toISOString() : now;
  return parseCapture({
    schemaVersion: 1, questionId, scope: 'question', path, origin: 'operator-entered',
    startedAt: time, endedAt: time, outcome: 'partial', modelCalls: [],
    runtime: { durationMs: null, vcpu: null, memoryGiB: null, requests: null, basis: 'unavailable' },
    fabric: { cuSeconds: null, operations: null, source: 'unavailable', correlation: 'unavailable' },
    cowork: { creditsBefore: null, creditsAfter: null, source: 'unavailable',
      isolatedQuestion: false, concurrentActivity: false },
  });
}

export function createDefaultPriceBook(): CostPriceBook {
  return parsePriceBook({
    id: 'azure-retail-2026-09-29', kind: 'configured', currency: 'USD',
    effectiveDate: '2026-03-01', source: 'https://prices.azure.com/api/retail/prices',
    openAi: [{ model: 'gpt-5.4-mini', inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075, outputPerMillion: 4.5 }],
    container: { vcpuSecond: null, memoryGiBSecond: null, millionRequests: null },
    fabric: { capacityCu: null, capacityHourly: null },
    cowork: { perCredit: null },
    shared: { periodLabel: 'Período não informado', periodCost: null, questionCount: null },
  });
}

function checked(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Resultado monetário fora do intervalo finito.');
  return value;
}

// Zero observado não depende de preço; ausência de quantidade nunca equivale a zero.
function priced(quantity: number | null, rate: number | null): number | null {
  if (quantity === null) return null;
  if (quantity === 0) return 0;
  return rate === null ? null : checked(quantity * rate);
}

function sumComplete(values: (number | null)[]): number | null {
  return values.some(value => value === null) ? null
    : checked(values.reduce<number>((sum, value) => sum + (value as number), 0));
}

export function calculateCostReceipt(capture: QuestionCostCapture, pricing: CostPriceBook): QuestionCostReceipt {
  const c = parseCapture(capture);
  const p = parsePriceBook(pricing);
  const warnings = [
    'Subtotal conhecido não é fatura: não inclui componentes desconhecidos; billingRecord=false.',
    `Valores em ${p.currency}; não há conversão automática de moeda (FX).`,
    'Preços configurados são estimativas; varejo não comprova preço contratual nem cobrança efetiva.',
  ];
  if (p.kind === 'illustrative' || c.origin === 'synthetic-example') {
    warnings.push('Dados ou preços ilustrativos: não representam consumo ou cobrança reais.');
  }
  if (c.origin === 'operator-entered') warnings.push('Uso informado pelo operador, sem validação independente do provedor.');
  if (c.scope !== 'question') warnings.push('Escopo de tarefa ou chamada de ferramenta: totais não representam uma pergunta isolada.');
  const lines: CostLine[] = [];
  function line(component: CostComponent, label: string, unit: string, formula: string): CostLine {
    const result: CostLine = { component, label, amount: null, currency: p.currency,
      basis: 'unavailable', quantity: null, unit, formula, notes: [] };
    lines.push(result);
    return result;
  }
  function note(target: CostLine, text: string) {
    target.notes.push(text);
    warnings.push(text);
  }
  function finish(target: CostLine, amount: number | null, basis: CostBasis) {
    target.amount = amount;
    target.basis = amount === null ? 'unavailable'
      : p.kind === 'illustrative' || c.origin === 'synthetic-example' ? 'illustrative' : basis;
  }
  function notApplicable(target: CostLine) {
    target.basis = 'not-applicable';
    note(target, `${target.label}: não aplicável por definição do caminho; nenhum consumo Azure implícito.`);
  }

  const model = line('azure-openai', 'Azure OpenAI', 'tokens',
    'Σ ((entrada − cache) × preço entrada + cache × preço cache + saída × preço saída) / 1.000.000');
  if (c.path !== 'azure-mcp') {
    notApplicable(model);
  } else if (c.modelCalls.length === 0) {
    if (c.origin === 'application-metered') {
      model.amount = 0; model.quantity = 0; model.basis = 'not-applicable';
      note(model, 'Azure OpenAI: captura da aplicação sem chamadas observadas; modelo não chamado.');
    } else note(model, 'Azure OpenAI: ausência de eventos não comprova uso zero; consumo desconhecido.');
  } else {
    const callAmounts: (number | null)[] = [];
    let knownTokens = 0;
    let allTokensKnown = true;
    let providerOnly = true;
    c.modelCalls.forEach((call, index) => {
      const prefix = `Azure OpenAI, chamada ${index + 1}`;
      providerOnly &&= call.source === 'provider-usage';
      if (call.outcome === 'failed') note(model, `${prefix}: falha não elimina cobrança de uso observado antes da falha.`);
      if (call.inputTokens === null || call.outputTokens === null) allTokensKnown = false;
      knownTokens += (call.inputTokens ?? 0) + (call.outputTokens ?? 0);
      if (call.reasoningOutputTokens !== null) note(model, `${prefix}: raciocínio já incluído na saída, sem cobrança adicional.`);
      if (call.cachedInputTokens === null && call.inputTokens !== null) {
        note(model, `${prefix}: cache não informado: sem desconto.`);
      }
      const rate = p.openAi.find(candidate => candidate.model === call.model);
      if (!rate || call.inputTokens === null || call.outputTokens === null) {
        callAmounts.push(null);
        note(model, `${prefix}: entrada, saída ou preço do modelo ausente; valor desconhecido.`);
        return;
      }
      const cached = call.cachedInputTokens ?? 0;
      const amount = sumComplete([
        priced((call.inputTokens - cached) / 1e6, rate.inputPerMillion),
        priced(cached / 1e6, rate.cachedInputPerMillion),
        priced(call.outputTokens / 1e6, rate.outputPerMillion),
      ]);
      callAmounts.push(amount);
      if (amount === null) note(model, `${prefix}: tarifa necessária ausente; valor desconhecido.`);
    });
    model.quantity = allTokensKnown ? knownTokens : null;
    const amount = sumComplete(callAmounts);
    finish(model, amount, providerOnly ? 'measured-usage-estimate' : 'estimated');
    if (amount === null) note(model, 'Azure OpenAI: componente incompleto; chamadas conhecidas não formam um total completo e não entram no subtotal.');
  }

  const container = line('azure-container', 'Contêiner Azure', 'segundos',
    '(duração ms / 1.000) × (vCPU × tarifa/vCPU-s + GiB × tarifa/GiB-s) + requisições × tarifa/milhão / 1.000.000');
  if (c.path !== 'azure-mcp') notApplicable(container);
  else {
    const r = c.runtime;
    container.quantity = r.durationMs === null ? null : r.durationMs / 1000;
    const cpuSeconds = r.durationMs === null || r.vcpu === null ? null : r.durationMs / 1000 * r.vcpu;
    const memorySeconds = r.durationMs === null || r.memoryGiB === null ? null : r.durationMs / 1000 * r.memoryGiB;
    const amount = sumComplete([
      priced(cpuSeconds, p.container.vcpuSecond),
      priced(memorySeconds, p.container.memoryGiBSecond),
      priced(r.requests === null ? null : r.requests / 1e6, p.container.millionRequests),
    ]);
    finish(container, amount, r.basis === 'attributed-usage' ? 'measured-usage-estimate' : 'estimated');
    if (amount === null) note(container, 'Contêiner Azure: uso, SKU/recursos ou tarifas incompletos; não assumir zero.');
    if (r.basis === 'wall-clock-estimate') note(container, 'Contêiner Azure: tempo de parede ESTIMADO; concorrência, franquias e ociosidade impedem tratá-lo como cobrança real.');
    if (r.basis === 'attributed-usage') note(container, 'Contêiner Azure: uso atribuído ainda é estimativa por preço e SKU; não é reconciliação de fatura.');
  }

  const fabric = line('fabric-capacity', 'Capacidade Fabric', 'CU-segundos',
    'CU-segundos × preço horário da capacidade / (3.600 × CUs da capacidade)');
  if (c.path === 'local-guided') notApplicable(fabric);
  else {
    fabric.quantity = c.fabric.cuSeconds;
    const amount = c.fabric.source === 'unavailable' || c.fabric.cuSeconds === null
      || p.fabric.capacityCu === null || p.fabric.capacityHourly === null ? null
      : checked(c.fabric.cuSeconds * p.fabric.capacityHourly / (3600 * p.fabric.capacityCu));
    finish(fabric, amount, 'allocated');
    note(fabric, 'Fabric: rateio de capacidade, não custo marginal nem fatura por pergunta.');
    if (amount === null) note(fabric, 'Fabric: uso ou preço/capacidade ausente; alocação desconhecida.');
    if (c.fabric.correlation === 'time-window') note(fabric, 'Fabric: correlação por janela de tempo é heurística e pode incluir outras operações.');
    if (c.fabric.correlation === 'operation-id') note(fabric, 'Fabric: correlação por ID de operação é mais forte, mas continua sendo alocação, não fatura.');
    if (c.fabric.source !== 'unavailable' && c.fabric.correlation === 'unavailable') note(fabric, 'Fabric: sem correlação de operação; atribuição à pergunta não comprovada.');
    if (c.fabric.source === 'operator-estimate') note(fabric, 'Fabric: CU-segundos estimados pelo operador, não medição confirmada.');
  }

  const cowork = line('cowork-credits', 'Créditos nativos Copilot/Cowork', 'créditos',
    '(contador depois − contador antes) × preço por crédito; somente pergunta isolada');
  let coworkCredits: number | null = null;
  if (c.path !== 'cowork-fabric-iq') notApplicable(cowork);
  else {
    const native = c.cowork;
    note(cowork, 'Créditos nativos incluem raciocínio e chamadas do Copilot/transcrição; não duplicar como Azure OpenAI.');
    note(cowork, 'P3, pacotes pré-pagos e PAYG têm regras de financiamento distintas; confirmar cobertura e contrato, sem preço presumido.');
    if (native.source === 'native-cost-command') note(cowork, '/cost é sempre aproximado, mesmo quando observado; não é registro de cobrança.');
    if (native.source === 'native-cost-command' && native.creditsBefore !== null && native.creditsAfter !== null
        && native.isolatedQuestion && !native.concurrentActivity && c.scope === 'question') {
      coworkCredits = checked(native.creditsAfter - native.creditsBefore);
    } else note(cowork, 'Créditos nativos: exige contadores aproximados da mesma tarefa, pergunta isolada sem concorrência. Exportações administrativas agregadas e totais mensais não permitem atribuição por pergunta.');
    cowork.quantity = coworkCredits;
    // Sem tarifa por crédito, nem um delta zero constitui conversão monetária configurada.
    finish(cowork, coworkCredits === null || p.cowork.perCredit === null ? null
      : checked(coworkCredits * p.cowork.perCredit), 'approximate-native');
    if (coworkCredits !== null) cowork.basis = p.kind === 'illustrative'
      || c.origin === 'synthetic-example' ? 'illustrative' : 'approximate-native';
    if (p.cowork.perCredit === null) note(cowork, 'Preço por crédito desconhecido; créditos conhecidos não equivalem a valor monetário zero.');
    else note(cowork, 'Conversão de créditos por tarifa configurada é estimada, não cobrança contratual efetiva.');
  }

  const shared = line('shared-overhead', 'Custos compartilhados', 'perguntas no período',
    'Custo informado do período / quantidade de perguntas do período');
  shared.quantity = p.shared.questionCount;
  finish(shared, p.shared.periodCost === null || p.shared.questionCount === null ? null
    : checked(p.shared.periodCost / p.shared.questionCount), 'allocated');
  note(shared, 'Custos compartilhados: rateio uniforme informado pelo usuário, não custo marginal; não inclui taxas de terceiros ou de primeira parte ocultas.');
  if (shared.amount === null) note(shared, 'Custos compartilhados: custo do período ou quantidade de perguntas ausente.');

  const applicable = lines.filter(item => item.basis !== 'not-applicable');
  const known = applicable.filter(item => item.amount !== null);
  const knownSubtotal = known.length === 0 ? null : sumComplete(known.map(item => item.amount));
  const completeness = applicable.every(item => item.amount !== null) ? 'complete-estimate'
    : known.length > 0 ? 'partial' : 'unpriced';
  return {
    schemaVersion: 1, questionId: c.questionId, capture: c, pricing: p, lines,
    totals: {
      azureEstimate: [model, container].every(item => item.basis === 'not-applicable') ? null
        : sumComplete([model, container].map(item => item.basis === 'not-applicable' ? 0 : item.amount)),
      fabricAllocation: fabric.amount,
      coworkEstimate: cowork.amount,
      sharedAllocation: shared.amount,
      knownSubtotal,
      completeness,
    },
    coworkCredits, warnings: [...new Set(warnings)], billingRecord: false,
  };
}
