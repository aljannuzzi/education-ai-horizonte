import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { QuestionCostReceipt } from '../shared/cost-contracts';
import { calculateCostReceipt, parseCapture, parsePriceBook } from '../shared/cost-engine';

const sessionSchema = z.object({ authenticated: z.boolean(), csrfToken: z.string().min(1) });
const envelopeSchema = z.object({
  costReceipt: z.object({ capture: z.unknown(), pricing: z.unknown() }).optional(),
});

async function request(path: string, csrf?: string, body?: object) {
  return fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '',
    }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
}

export function LiveCostProbe({ onReceipt }: { onReceipt: (receipt: QuestionCostReceipt) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  async function measure(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setStatus('Consultando o backend autenticado...');
    try {
      const sessionResponse = await request('session');
      if (!sessionResponse.ok) throw new Error('Sessão indisponível.');
      let session = sessionSchema.parse(await sessionResponse.json());
      if (!session.authenticated) {
        if (!key.trim()) throw new Error('Informe a chave diagnóstica ou entre pela sessão existente.');
        const login = await request('login', session.csrfToken, { accessKey: key });
        if (!login.ok) throw new Error('Autenticação não concluída. Confira a chave e tente novamente.');
        session = sessionSchema.parse(await login.json());
        if (!session.authenticated) throw new Error('Sessão não autenticada.');
      }
      const response = await request('costs/probe', session.csrfToken, {});
      const body = envelopeSchema.parse(await response.json());
      if (body.costReceipt) {
        const receipt = calculateCostReceipt(
          parseCapture(body.costReceipt.capture), parsePriceBook(body.costReceipt.pricing),
        );
        onReceipt(receipt);
      }
      if (!response.ok) throw new Error(response.status === 429
        ? 'Limite de medições atingido. Aguarde um minuto.'
        : 'A medição falhou ou não está habilitada. Se houve consumo capturado, o recibo permanece visível.');
      if (!body.costReceipt) throw new Error('O backend não retornou um recibo.');
      setStatus('Consumo real do Azure capturado; valor monetário estimado. Esta chamada não passou pelo Cowork.');
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof z.ZodError
        ? 'Resposta de medição inválida; não foi utilizada como comprovante.'
        : error instanceof Error ? error.message : 'Falha de medição.');
    } finally {
      setKey('');
      setBusy(false);
    }
  }
  return <details className="cost-section">
    <summary>Medir uma chamada real ao Azure da demo</summary>
    <p>Executa uma pergunta sintética fixa de triagem do diário, captura tokens do provedor
      e carrega o recibo abaixo. Não lê nem grava registros escolares. Gera consumo normal
      do Azure OpenAI; não mede créditos do Cowork.</p>
    <form onSubmit={measure}>
      <label className="cost-field">
        <span>Chave diagnóstica (somente se ainda não estiver autenticado)</span>
        <input type="password" autoComplete="off" value={key} disabled={busy}
          onChange={event => setKey(event.target.value)} />
        <small>Enviada somente ao backend desta página e removida do campo após a tentativa.</small>
      </label>
      <button className="cost-button" disabled={busy} type="submit">
        {busy ? 'Medindo...' : 'Executar pergunta sintética e medir'}
      </button>
    </form>
    {status && <p className={failed ? 'cost-error' : 'cost-notice'} role={failed ? 'alert' : 'status'}>{status}</p>}
  </details>;
}
