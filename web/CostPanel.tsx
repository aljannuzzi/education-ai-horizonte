import { useState, type ChangeEvent } from 'react';
import type { CostBasis, CostPath, CostPriceBook, ModelUsage, QuestionCostCapture } from '../shared/cost-contracts.js';
import { calculateCostReceipt, createDefaultPriceBook, createEmptyCapture, parseCapture, parsePriceBook } from '../shared/cost-engine.js';
import './costs.css';
import { LiveCostProbe } from './LiveCostProbe';

const paths: [CostPath, string][] = [
  ['cowork-fabric-iq', 'Cowork + Fabric IQ nativo'],
  ['azure-mcp', 'Backend Azure / MCP'],
  ['local-guided', 'Modo guiado local'],
];
const bases: Record<CostBasis, string> = {
  'measured-usage-estimate': 'Uso medido · preço estimado',
  estimated: 'Estimativa', allocated: 'Rateio', 'approximate-native': 'Aproximação nativa',
  illustrative: 'Ilustrativo', unavailable: 'Sem dados / tarifa', 'not-applicable': 'Não se aplica',
};
const outcomes = [['partial', 'Parcial / não confirmado'], ['succeeded', 'Concluído'], ['failed', 'Falhou']] as const;
const emptyCall = (): ModelUsage => ({
  model: 'gpt-5.4-mini', outcome: 'succeeded', durationMs: 0, inputTokens: null,
  cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, source: 'operator',
});
function newCapture(path: CostPath) {
  const capture = createEmptyCapture(path, crypto.randomUUID());
  if (path === 'azure-mcp') {
    capture.modelCalls = [emptyCall()];
    capture.runtime = { ...capture.runtime, vcpu: 0.25, memoryGiB: 0.5, basis: 'wall-clock-estimate' };
  }
  return capture;
}
function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
    return error.issues.map((issue: { path?: unknown[]; message?: string }) =>
      `${issue.path?.join('.') || 'Dado'}: ${issue.message || 'Valor inválido'}`).join(' · ');
  }
  return error instanceof SyntaxError ? 'JSON inválido. Selecione um comprovante estruturado válido.'
    : 'Não foi possível validar os dados. Confira o formato, os valores e as datas.';
}
function Numeric({ label, value, onChange, integer = false, min = 0 }: {
  label: string; value: number | null; onChange: (value: number | null) => void; integer?: boolean; min?: number;
}) {
  return <label className="cost-field"><span>{label}</span>
    <input type="number" min={min} step={integer ? 1 : 'any'} value={value ?? ''} placeholder="Não informado"
      onChange={event => onChange(event.target.value === '' ? null : event.target.valueAsNumber)} />
  </label>;
}
function TextField({ label, value, onChange, type = 'text' }: {
  label: string; value: string; onChange: (value: string) => void; type?: string;
}) {
  return <label className="cost-field"><span>{label}</span>
    <input type={type} value={value} maxLength={type === 'text' ? 500 : undefined}
      onChange={event => onChange(event.target.value)} />
  </label>;
}
function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void;
}) {
  return <label className="cost-field"><span>{label}</span>
    <select value={value} onChange={event => onChange(event.target.value as T)}>
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  </label>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Objeto esperado');
  return value as Record<string, unknown>;
}

export function CostPanel() {
  const [capture, setCapture] = useState(() => newCapture('cowork-fabric-iq'));
  const [pricing, setPricing] = useState(createDefaultPriceBook);
  const [fileError, setFileError] = useState('');
  const [notice, setNotice] = useState('');
  const [imported, setImported] = useState(false);
  const [pendingCurrency, setPendingCurrency] = useState<CostPriceBook['currency']>('USD');
  let receipt: ReturnType<typeof calculateCostReceipt> | null = null;
  let validationError = '';
  try { receipt = calculateCostReceipt(parseCapture(capture), parsePriceBook(pricing)); }
  catch (error) { validationError = errorText(error); }
  const isNative = capture.path === 'cowork-fabric-iq';
  const isAzure = capture.path === 'azure-mcp';
  const isExample = capture.origin === 'synthetic-example' || pricing.kind === 'illustrative';
  const money = (value: number | null | undefined) => value == null ? 'Sem dados' :
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: pricing.currency, maximumFractionDigits: 6 }).format(value);
  const number = (value: number | null | undefined) => value == null ? 'Sem dados' :
    new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 }).format(value);
  const missing = receipt?.lines.filter(line => line.amount === null && line.basis !== 'not-applicable') ?? [];
  function editCapture(update: Partial<QuestionCostCapture>) {
    setImported(false);
    setCapture(current => ({ ...current, ...update,
      origin: current.origin === 'synthetic-example' ? 'synthetic-example' : 'operator-entered' }));
  }
  function editPricing(update: Partial<CostPriceBook>) {
    setPricing(current => ({ ...current, ...update, id: 'operator-pricebook',
      source: update.source ?? 'Tarifas informadas pelo operador' }));
  }
  function editCall(index: number, update: Partial<ModelUsage>) {
    editCapture({ modelCalls: capture.modelCalls.map((call, i) => i === index
      ? { ...call, ...update, source: isExample ? 'example' : 'operator' } : call) });
  }
  function changePath(path: CostPath) {
    setCapture(newCapture(path));
    setImported(false);
    setFileError('');
    setNotice('Nova captura vazia. O caminho anterior foi descartado; as tarifas foram mantidas.');
  }
  function resetCurrency() {
    editPricing({
      currency: pendingCurrency,
      openAi: pricing.openAi.map(rate => ({ ...rate, inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null })),
      container: { vcpuSecond: null, memoryGiBSecond: null, millionRequests: null },
      fabric: { capacityCu: null, capacityHourly: null }, cowork: { perCredit: null },
      shared: { ...pricing.shared, periodCost: null, questionCount: null },
    });
    setNotice('Moeda alterada e tarifas numéricas apagadas. Informe valores nessa moeda; nenhuma conversão foi feita.');
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFileError('');
    try {
      if (file.size > 1_000_000) { setFileError('Arquivo muito grande. Limite: 1 MB.'); return; }
      const input = object(JSON.parse(await file.text()));
      const data = object(input.backendQuestionCostReceipt ?? input.costReceipt ?? input);
      const nextCapture = parseCapture(data.capture);
      const nextPricing = parsePriceBook(data.pricing);
      calculateCostReceipt(nextCapture, nextPricing);
      setCapture(nextCapture); setPricing(nextPricing); setPendingCurrency(nextPricing.currency);
      setImported(true);
      setNotice('Registro importado e validado. Totais recebidos foram ignorados e recalculados localmente. A origem declarada não comprova autenticidade.');
    } catch (error) { setFileError(`Importação recusada. ${errorText(error)} Os dados atuais foram preservados.`); }
  }
  function exportReceipt() {
    if (!receipt) return;
    try {
      const content = calculateCostReceipt(parseCapture(capture), parsePriceBook(pricing));
      const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `custo-${content.questionId}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Comprovante exportado. O arquivo pode conter métricas internas; proteja-o antes de compartilhar externamente.');
    } catch (error) { setFileError(errorText(error)); }
  }
  function loadExample() {
    const sample = createEmptyCapture('cowork-fabric-iq', 'task-demo-001', '2026-03-01T12:00:00Z');
    sample.origin = 'synthetic-example'; sample.outcome = 'succeeded';
    sample.endedAt = '2026-03-01T12:01:00Z';
    sample.fabric = { cuSeconds: 7200, operations: 2, source: 'operator-estimate', correlation: 'time-window' };
    sample.cowork = { creditsBefore: 10, creditsAfter: 14, source: 'native-cost-command', isolatedQuestion: true, concurrentActivity: false };
    const book = createDefaultPriceBook();
    book.id = 'illustrative-demo'; book.kind = 'illustrative'; book.source = 'Exemplo fictício para demonstrar o cálculo';
    book.fabric = { capacityCu: 16, capacityHourly: 8 }; book.cowork = { perCredit: 0.1 };
    book.shared = { periodLabel: 'Período fictício', periodCost: 20, questionCount: 100 };
    setCapture(sample); setPricing(book); setPendingCurrency('USD'); setImported(false); setFileError('');
    setNotice('Exemplo fictício carregado. Nenhum destes números representa consumo, tarifa contratual ou cobrança real.');
  }
  return <div className="cost-page">
    <a className="skip-link" href="#cost-main">Ir para o conteúdo</a>
    <header className="site-header container">
      <a className="brand" href="/"><span className="brand-name">Horizonte<span className="brand-dot">.</span></span>
        <span className="brand-description">Console técnico · custos</span></a>
      <nav className="cost-header-nav" aria-label="Navegação">
        <a href="/">Voltar à página nativa</a>
        <a href="https://copilot.cloud.microsoft/" target="_blank" rel="noopener noreferrer">Abrir Copilot nativo ↗</a>
      </nav>
    </header>
    <main id="cost-main" className="container cost-main">
      <section className="cost-hero">
        <p className="eyebrow">NATIVECOPILOT / OBSERVABILIDADE FINANCEIRA</p>
        <h1>Quanto custa<br /><span>uma pergunta?</span></h1>
        <p>Consumo observado, estimativa e rateio — não uma fatura</p>
        <p>Uma captura por identificador. Compare recursos Azure, capacidade Fabric e créditos Copilot sem confundir
          quantidade consumida com cobrança. O professor continua trabalhando no Copilot nativo.</p>
        {isExample && <div className="cost-badge" role="status">EXEMPLO FICTÍCIO · consumo e preços ilustrativos, não cobrança real</div>}
        {imported && <div className="cost-badge">Registro importado · origem declarada: {capture.origin}</div>}
      </section>
      <fieldset className="cost-paths"><legend>Caminho da pergunta</legend>
        {paths.map(([path, label]) => <label key={path}><input type="radio" name="cost-path" value={path}
          checked={capture.path === path} onChange={() => changePath(path)} />{label}</label>)}
      </fieldset>
      <p>Trocar o caminho inicia uma captura vazia, sem reutilizar créditos ou medições. Exporte antes de trocar.</p>
      <div className="cost-toolbar">
        <button type="button" className="primary" onClick={exportReceipt} disabled={!receipt}>Exportar comprovante</button>
        <label>Importar comprovante JSON<input type="file" accept=".json,application/json" onChange={importFile} /></label>
        <button type="button" onClick={loadExample}>Carregar exemplo fictício</button>
        <button type="button" onClick={() => {
          setCapture(newCapture(capture.path)); setPricing(createDefaultPriceBook()); setPendingCurrency('USD');
          setImported(false); setFileError(''); setNotice('Captura limpa e tabela oficial padrão restaurada. Nenhum consumo preenchido.');
        }}>Limpar captura e tarifas</button>
      </div>
      <p className="cost-notice">Cálculo e importação ficam na memória do navegador. Somente a medição real opcional abaixo
        chama o backend autenticado e registra metadados de consumo nos logs. Recarregar apaga a captura local.
        Proteja os comprovantes exportados antes de compartilhar externamente.</p>
      <LiveCostProbe onReceipt={value => {
        setCapture(value.capture); setPricing(value.pricing); setPendingCurrency(value.pricing.currency);
        setImported(false); setFileError('');
        setNotice('Recibo recebido do backend autenticado. Tokens observados; preços estimados; nenhuma pergunta nativa interceptada.');
      }} />
      {notice && <p className="cost-notice" role="status">{notice}</p>}
      {fileError && <p className="cost-error" role="alert">{fileError}</p>}
      {validationError && <p className="cost-error" role="alert">Corrija os dados para calcular e exportar: {validationError}</p>}
      <section className="cost-metrics" aria-label="Resumo calculado">
        <article className="cost-metric"><small>Azure estimado</small><strong>{isAzure ? money(receipt?.totals.azureEstimate) : 'Não se aplica'}</strong>
          <p>{isAzure ? 'Modelo + contêiner; confira componentes sem tarifa.' : 'Nenhuma cobrança de modelo ou backend Azure atribuída a este caminho.'}</p></article>
        <article className="cost-metric"><small>Fabric rateado</small><strong>{capture.path === 'local-guided' ? 'Não se aplica' : money(receipt?.totals.fabricAllocation)}</strong>
          <p>Parcela da capacidade. Não é custo marginal nem fatura.</p></article>
        <article className="cost-metric"><small>Copilot credits</small><strong>{isNative ? number(receipt?.coworkCredits) : 'Não se aplica'}</strong>
          <p>{isNative ? `Aproximação por tarefa · valor: ${money(receipt?.totals.coworkEstimate)}. Sem conversão fixa.` : 'Créditos nativos não atribuídos a este caminho.'}</p></article>
        <article className="cost-metric"><small>Subtotal conhecido · {pricing.currency}</small><strong>{money(receipt?.totals.knownSubtotal)}</strong>
          <p>{!receipt ? 'Dados inválidos: cálculo indisponível.' : receipt.totals.completeness === 'complete-estimate'
            ? 'Estimativa com componentes precificados, não fatura.' : `Total incompleto · ${missing.length} componente(s) sem dados ou tarifa.`}</p></article>
      </section>
      <div className="cost-layout">
        <aside className="cost-guide">
          <h2>O que move o custo</h2>
          <p><strong>Modelo</strong><br />A tarifa acompanha o identificador exato do modelo e a modalidade contratada.</p>
          <p><strong>Contexto</strong><br />Entrada, histórico e cache mudam o consumo. Cache já faz parte da entrada.</p>
          <p><strong>Esforço</strong><br />Mais saída, raciocínio e tentativas podem aumentar uso. Raciocínio não é somado novamente.</p>
          <p><strong>Ferramentas</strong><br />Chamadas, tempo de execução e operações Fabric são componentes distintos.</p>
          <h3>Como capturar</h3>
          <ol><li>Prefira uma tarefa nova para uma única pergunta.</li><li>Registre contadores antes e depois no host nativo.</li>
            <li>Correlacione métricas, informe tarifas e revise as lacunas.</li></ol>
          <p>Não cole prompts, respostas, dados pessoais, tokens ou credenciais neste console.</p>
          <h3>Fontes oficiais</h3>
          <ul>
            <li><a href="https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-models" target="_blank" rel="noopener noreferrer">Cowork e comando /cost</a></li>
            <li><a href="https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-copilot-credits-cost" target="_blank" rel="noopener noreferrer">Cobrança e créditos Copilot</a></li>
            <li><a href="https://learn.microsoft.com/en-us/azure/container-apps/billing" target="_blank" rel="noopener noreferrer">Cobrança Container Apps</a></li>
            <li><a href="https://learn.microsoft.com/en-us/fabric/enterprise/metrics-app" target="_blank" rel="noopener noreferrer">Fabric Capacity Metrics</a></li>
          </ul>
        </aside>
        <div className="cost-workspace">
          <section className="cost-section" aria-labelledby="capture-heading">
            <p className="eyebrow">01 / IDENTIFICAR</p><h2 id="capture-heading">Metadados da captura</h2>
            <p>Somente identificadores técnicos, sem conteúdo da pergunta. Datas em UTC (ISO 8601); não medem latência automaticamente.</p>
            <div className="cost-fields">
              <TextField label="ID da pergunta" value={capture.questionId} onChange={questionId => editCapture({ questionId })} />
              <SelectField label="Escopo observado" value={capture.scope} options={[['question', 'Uma pergunta'], ['task', 'Tarefa agregada'], ['tool-call', 'Uma chamada de ferramenta']]}
                onChange={scope => editCapture({ scope })} />
              <TextField label="Início (ISO 8601 com fuso)" value={capture.startedAt} onChange={startedAt => editCapture({ startedAt })} />
              <TextField label="Fim (ISO 8601 com fuso)" value={capture.endedAt} onChange={endedAt => editCapture({ endedAt })} />
              <SelectField label="Resultado" value={capture.outcome} options={outcomes} onChange={outcome => editCapture({ outcome })} />
            </div>
            <p>Origem: {capture.origin === 'application-metered' ? 'Medição declarada pela aplicação'
              : capture.origin === 'synthetic-example' ? 'Exemplo fictício' : 'Informado pelo operador'}.
              Editar uma captura importada muda a origem para informação do operador.</p>
          </section>
          {isNative && <section className="cost-section" aria-labelledby="cowork-heading">
            <p className="eyebrow">02 / OBSERVAR NO HOST NATIVO</p><h2 id="cowork-heading">Créditos Cowork</h2>
            <p>Execute <code>/cost</code> manualmente no host nativo antes e depois. O comando é do produto,
              não uma pergunta ao LLM: não peça ao modelo para inventar números. Registre consumo cumulativo de créditos,
              nunca saldo restante ou limite mensal compartilhado.</p>
            <div className="cost-fields">
              <SelectField label="Fonte dos créditos" value={capture.cowork.source}
                options={[['unavailable', 'Indisponível'], ['native-cost-command', 'Comando nativo /cost'], ['admin-export', 'Exportação administrativa']]}
                onChange={source => editCapture({ cowork: { ...capture.cowork, source } })} />
              <Numeric label="Créditos consumidos — antes" value={capture.cowork.creditsBefore}
                onChange={creditsBefore => editCapture({ cowork: { ...capture.cowork, creditsBefore } })} />
              <Numeric label="Créditos consumidos — depois" value={capture.cowork.creditsAfter}
                onChange={creditsAfter => editCapture({ cowork: { ...capture.cowork, creditsAfter } })} />
            </div>
            <label className="cost-check"><input type="checkbox" checked={capture.cowork.isolatedQuestion}
              onChange={event => editCapture({ cowork: { ...capture.cowork, isolatedQuestion: event.target.checked } })} />
              Confirmo que isolei esta pergunta, preferencialmente em uma tarefa nova.</label>
            <label className="cost-check"><input type="checkbox" checked={capture.cowork.concurrentActivity}
              onChange={event => editCapture({ cowork: { ...capture.cowork, concurrentActivity: event.target.checked } })} />
              Houve atividade concorrente no intervalo.</label>
            <p className="cost-notice">{capture.cowork.concurrentActivity ? 'Atenção: atividade concorrente impede atribuição confiável à pergunta. ' : ''}
              /cost agrega a tarefa. A diferença é aproximada, não medição exata por pergunta. Limites mensais e saldos não permitem calcular esse delta.</p>
          </section>}
          {isAzure && <section className="cost-section" aria-labelledby="azure-heading">
            <p className="eyebrow">02 / BACKEND AZURE, VARIANTE MCP</p><h2 id="azure-heading">Chamadas e execução</h2>
            <p>Inclua cada tentativa, inclusive falhas com consumo. Tokens de cache são parte da entrada;
              raciocínio é parte da saída, não cobrança adicional. Duração da chamada: 0 significa não registrada.</p>
            {capture.modelCalls.map((call, index) => <fieldset className="cost-call" key={index}>
              <legend>Chamada {index + 1} · {call.source === 'provider-usage' ? 'Registro importado' : call.source === 'example' ? 'Exemplo' : 'Operador'}</legend>
              <div className="cost-fields">
                <TextField label={`Modelo · chamada ${index + 1}`} value={call.model} onChange={model => editCall(index, { model })} />
                <SelectField label="Resultado da chamada" value={call.outcome} options={[['succeeded', 'Concluída'], ['failed', 'Falhou']]}
                  onChange={outcome => editCall(index, { outcome })} />
                <TextField label="ID de requisição (opcional)" value={call.requestId ?? ''} onChange={requestId => {
                  const next = { ...call, source: isExample ? 'example' as const : 'operator' as const };
                  if (requestId) next.requestId = requestId; else delete next.requestId;
                  editCapture({ modelCalls: capture.modelCalls.map((entry, i) => i === index ? next : entry) });
                }} />
                <Numeric label="Duração da chamada (ms; 0 = não registrada)" integer value={call.durationMs} onChange={value => editCall(index, { durationMs: value ?? 0 })} />
                <Numeric label="Tokens de entrada (promptTokens)" integer value={call.inputTokens} onChange={inputTokens => editCall(index, { inputTokens })} />
                <Numeric label="Tokens de entrada em cache" integer value={call.cachedInputTokens} onChange={cachedInputTokens => editCall(index, { cachedInputTokens })} />
                <Numeric label="Tokens de saída" integer value={call.outputTokens} onChange={outputTokens => editCall(index, { outputTokens })} />
                <Numeric label="Tokens de raciocínio (incluídos na saída)" integer value={call.reasoningOutputTokens} onChange={reasoningOutputTokens => editCall(index, { reasoningOutputTokens })} />
              </div>
              <button type="button" className="cost-button" onClick={() => editCapture({ modelCalls: capture.modelCalls.filter((_, i) => i !== index) })}>Remover chamada {index + 1}</button>
            </fieldset>)}
            <button type="button" className="cost-button" disabled={capture.modelCalls.length >= 32}
              onClick={() => editCapture({ modelCalls: [...capture.modelCalls, emptyCall()] })}>Adicionar chamada</button>
            <h3>Container Apps</h3><p>Alocação por tempo de execução, não CPU observada. Não inclui automaticamente réplicas ociosas,
              franquias, rede ou serviços adicionais. Falhas também podem consumir recursos.</p>
            <div className="cost-fields">
              <Numeric label="Duração atribuída (ms)" integer value={capture.runtime.durationMs} onChange={durationMs => editCapture({ runtime: { ...capture.runtime, durationMs } })} />
              <Numeric label="vCPU alocadas" min={0.000001} value={capture.runtime.vcpu} onChange={vcpu => editCapture({ runtime: { ...capture.runtime, vcpu } })} />
              <Numeric label="Memória alocada (GiB)" min={0.000001} value={capture.runtime.memoryGiB} onChange={memoryGiB => editCapture({ runtime: { ...capture.runtime, memoryGiB } })} />
              <Numeric label="Requisições atribuídas" integer value={capture.runtime.requests} onChange={requests => editCapture({ runtime: { ...capture.runtime, requests } })} />
              <SelectField label="Base da execução" value={capture.runtime.basis}
                options={[['unavailable', 'Indisponível'], ['wall-clock-estimate', 'Estimativa por tempo decorrido'], ['attributed-usage', 'Uso atribuído']]}
                onChange={basis => editCapture({ runtime: { ...capture.runtime, basis } })} />
            </div>
          </section>}
          {capture.path !== 'local-guided' ? <section className="cost-section" aria-labelledby="fabric-heading">
            <p className="eyebrow">03 / CORRELACIONAR CAPACIDADE</p><h2 id="fabric-heading">Operações Fabric</h2>
            <p>Informe apenas operações efetivamente correlacionadas. O backend MCP de ontologia não implica uso de Fabric.
              Janelas de tempo são menos precisas do que correlação por operação.</p>
            <div className="cost-fields">
              <Numeric label="Total CU(s)" value={capture.fabric.cuSeconds} onChange={cuSeconds => editCapture({ fabric: { ...capture.fabric, cuSeconds } })} />
              <Numeric label="Quantidade de operações" integer value={capture.fabric.operations} onChange={operations => editCapture({ fabric: { ...capture.fabric, operations } })} />
              <SelectField label="Fonte Fabric" value={capture.fabric.source}
                options={[['unavailable', 'Indisponível'], ['capacity-metrics', 'Fabric Capacity Metrics'], ['operator-estimate', 'Estimativa do operador']]}
                onChange={source => editCapture({ fabric: { ...capture.fabric, source } })} />
              <SelectField label="Correlação" value={capture.fabric.correlation}
                options={[['unavailable', 'Indisponível'], ['operation-id', 'ID de operação'], ['time-window', 'Janela de tempo']]}
                onChange={correlation => editCapture({ fabric: { ...capture.fabric, correlation } })} />
            </div>
            <p className="cost-notice">Rateio: preço horário da capacidade × Total CU(s) ÷ (3.600 × CUs da capacidade).
              Distribui capacidade contratada; não representa incremento na fatura nem custo marginal.</p>
          </section> : <section className="cost-section"><h2>Modo guiado local</h2>
            <p>Este console não executa modelo, contêiner, Fabric nem Cowork. Esses componentes não se aplicam;
              isso não significa que toda a operação seja gratuita. Custos compartilhados podem ser rateados na tabela.</p></section>}
          <details className="cost-pricing">
            <summary>04 / Configurar tarifas · {pricing.currency} · {pricing.kind === 'illustrative' ? 'ilustrativas' : 'configuradas'}</summary>
            <p>Modelo padrão: gpt-5.4-mini, USD 0,75 entrada / 0,075 cache / 4,50 saída por milhão,
              vigência 01/03/2026 na referência de varejo. Os demais preços começam vazios.
              Varejo não é tarifa contratual. Impostos e descontos não estão incluídos.</p>
            <a href="https://prices.azure.com/api/retail/prices" target="_blank" rel="noopener noreferrer">Fonte pública de preços Azure ↗</a>
            <div className="cost-fields">
              <TextField label="Vigência da tabela" type="date" value={pricing.effectiveDate} onChange={effectiveDate => editPricing({ effectiveDate })} />
              <TextField label="Fonte das tarifas (sem credenciais)" value={pricing.source} onChange={source => editPricing({ source })} />
              <SelectField label="Nova moeda (não converte valores)" value={pendingCurrency}
                options={[['USD', 'USD'], ['BRL', 'BRL'], ['EUR', 'EUR']]} onChange={setPendingCurrency} />
            </div>
            <div className="cost-inline">
              <button className="cost-button" type="button" disabled={pendingCurrency === pricing.currency} onClick={resetCurrency}>Trocar moeda e apagar tarifas</button>
              <button className="cost-button" type="button" onClick={() => {
                setPricing(createDefaultPriceBook()); setPendingCurrency('USD'); setNotice('Tabela padrão oficial em USD restaurada; outras tarifas continuam não informadas.');
              }}>Restaurar tabela padrão USD</button>
            </div>
            <p>Moeda é apenas a unidade das tarifas informadas. Trocar apaga valores numéricos; informe-os manualmente.
              Não há câmbio automático. A identificação de modelo deve corresponder exatamente à chamada.</p>
            {pricing.openAi.map((rate, index) => <fieldset className="cost-call" key={index}><legend>Tarifa de modelo {index + 1}</legend>
              <div className="cost-fields">
                <TextField label="Identificador exato do modelo" value={rate.model} onChange={model => editPricing({ openAi: pricing.openAi.map((entry, i) => i === index ? { ...entry, model } : entry) })} />
                {([['inputPerMillion', 'Entrada / 1M tokens'], ['cachedInputPerMillion', 'Cache / 1M tokens'], ['outputPerMillion', 'Saída / 1M tokens']] as const).map(([key, label]) =>
                  <Numeric key={key} label={`${label} (${pricing.currency})`} value={rate[key]}
                    onChange={value => editPricing({ openAi: pricing.openAi.map((entry, i) => i === index ? { ...entry, [key]: value } : entry) })} />)}
              </div>
              <button type="button" className="cost-button" onClick={() => editPricing({ openAi: pricing.openAi.filter((_, i) => i !== index) })}>Remover tarifa {index + 1}</button>
            </fieldset>)}
            <button type="button" className="cost-button" disabled={pricing.openAi.length >= 128} onClick={() => editPricing({
              openAi: [...pricing.openAi, { model: 'novo-modelo', inputPerMillion: null, cachedInputPerMillion: null, outputPerMillion: null }],
            })}>Adicionar tarifa de modelo</button>
            <h3>Execução, capacidade e créditos · {pricing.currency}</h3>
            <div className="cost-fields">
              <Numeric label="Container / vCPU-segundo" value={pricing.container.vcpuSecond} onChange={vcpuSecond => editPricing({ container: { ...pricing.container, vcpuSecond } })} />
              <Numeric label="Container / GiB-segundo" value={pricing.container.memoryGiBSecond} onChange={memoryGiBSecond => editPricing({ container: { ...pricing.container, memoryGiBSecond } })} />
              <Numeric label="Container / milhão de requisições" value={pricing.container.millionRequests} onChange={millionRequests => editPricing({ container: { ...pricing.container, millionRequests } })} />
              <Numeric label="CUs da capacidade Fabric" min={0.000001} value={pricing.fabric.capacityCu} onChange={capacityCu => editPricing({ fabric: { ...pricing.fabric, capacityCu } })} />
              <Numeric label="Preço da capacidade Fabric / hora" value={pricing.fabric.capacityHourly} onChange={capacityHourly => editPricing({ fabric: { ...pricing.fabric, capacityHourly } })} />
              <Numeric label="Preço contratual / Copilot credit" value={pricing.cowork.perCredit} onChange={perCredit => editPricing({ cowork: { perCredit } })} />
            </div>
            <p>Créditos não têm conversão fixa em moeda, tokens ou perguntas. Preencha somente quando conhecer o contrato aplicável.</p>
            <h3>Custos compartilhados</h3><p>Rateio adicional por perguntas no período. Não duplique custos já incluídos acima.</p>
            <div className="cost-fields">
              <TextField label="Rótulo do período" value={pricing.shared.periodLabel} onChange={periodLabel => editPricing({ shared: { ...pricing.shared, periodLabel } })} />
              <Numeric label={`Custo do período (${pricing.currency})`} value={pricing.shared.periodCost} onChange={periodCost => editPricing({ shared: { ...pricing.shared, periodCost } })} />
              <Numeric label="Perguntas no período" integer min={1} value={pricing.shared.questionCount} onChange={questionCount => editPricing({ shared: { ...pricing.shared, questionCount } })} />
            </div>
          </details>
          <section className="cost-summary" aria-labelledby="receipt-heading">
            <h2 id="receipt-heading">Comprovante de estimativa</h2>
            <p>Quantidades, base e fórmula auditáveis. Valores desconhecidos nunca são tratados como zero.</p>
            {isExample && <p className="cost-badge">EXEMPLO FICTÍCIO · não usar para faturamento</p>}
            {receipt ? <>
              <div className="cost-table-wrap" role="region" aria-label="Componentes do custo" tabIndex={0}>
                <table className="cost-table"><caption>{capture.questionId} · {pricing.currency} · vigência {pricing.effectiveDate}</caption>
                  <thead><tr><th scope="col">Componente</th><th scope="col">Quantidade</th><th scope="col">Base</th><th scope="col">Fórmula</th><th scope="col">Valor</th></tr></thead>
                  <tbody>{receipt.lines.map((line, index) => <tr key={`${line.component}-${index}`}>
                    <th scope="row">{line.label}{line.notes.map((note, i) => <p key={i}>{note}</p>)}</th>
                    <td>{line.basis === 'not-applicable' ? '—' : `${number(line.quantity)} ${line.unit}`}</td>
                    <td>{bases[line.basis]}</td><td><code>{line.formula}</code></td>
                    <td>{line.basis === 'not-applicable' ? 'Não se aplica' : money(line.amount)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <h3>{missing.length ? 'Total incompleto · configure tarifas e medições' : 'Limites desta estimativa'}</h3>
              {missing.length > 0 && <ul>{missing.map((line, index) => <li key={index}>{line.label}: sem dados suficientes ou tarifa.</li>)}</ul>}
              <ul className="cost-warning-list">{receipt.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
              <p><strong>Subtotal conhecido: {money(receipt.totals.knownSubtotal)}</strong>.
                Não é uma fatura. Impostos, descontos, compromissos contratuais e componentes não medidos podem alterar o custo real.</p>
            </> : <p className="cost-error">Comprovante indisponível até corrigir os dados acima. Nenhum total anterior será reutilizado.</p>}
          </section>
          <p className="cost-notice">Calculadora local, sem novo OAuth ou concessão de acesso. A medição Azure opcional exige
            autenticação diagnóstica e gera consumo. Importar valida o contrato, não autentica a origem nem comprova cobrança.</p>
        </div>
      </div>
    </main>
    <footer className="container cost-footer"><p>Horizonte · experiência docente no Copilot nativo, não um clone.</p>
      <a href="https://github.com/aljannuzzi/education-ai-horizonte" target="_blank" rel="noopener noreferrer">Repositório ↗</a></footer>
  </div>;
}
