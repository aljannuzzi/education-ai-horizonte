import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { CostPath, CostPriceBook, ModelUsage, QuestionCostCapture, QuestionCostReceipt } from '../shared/cost-contracts.js';
import { calculateCostReceipt, createDefaultPriceBook, createEmptyCapture, parseCapture, parsePriceBook } from '../shared/cost-engine.js';

interface Context {
  capture: QuestionCostCapture;
  active: boolean;
}
const storage = new AsyncLocalStorage<Context>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meteringEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.COST_METERING_ENABLED;
  if (value === 'true') return true;
  if (value === undefined || value === 'false' || value.trim() === '') return false;
  throw new Error('Invalid COST_METERING_ENABLED configuration.');
}

function resource(env: NodeJS.ProcessEnv, key: string): number | null {
  const value = env[key];
  if (value === undefined) return null;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new Error(`Invalid ${key} configuration.`);
  }
  return Number(value);
}

export function recordModelUsage(usage: ModelUsage): void {
  const context = storage.getStore();
  if (!context?.active) return;
  // Project only contract metadata; never retain caller-owned objects or extra payload fields.
  context.capture.modelCalls.push({
    model: usage.model, outcome: usage.outcome, durationMs: Math.round(usage.durationMs),
    inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
    source: usage.source,
    ...(usage.requestId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(usage.requestId) ? { requestId: usage.requestId } : {}),
  });
}

export function recordFabricOperation(): void {
  const context = storage.getStore();
  if (!context?.active) return;
  context.capture.fabric.operations = (context.capture.fabric.operations ?? 0) + 1;
}

export async function withCostMeter<T>(options: {
  path: CostPath;
  scope?: 'question' | 'tool-call' | 'task';
  questionId?: string;
  pricing?: CostPriceBook;
  env?: NodeJS.ProcessEnv;
  onReceipt?: (receipt: QuestionCostReceipt) => void;
}, operation: () => Promise<T>): Promise<T> {
  if (storage.getStore()?.active) throw new Error('Nested cost capture is not supported.');
  const env = options.env ?? process.env;
  if (!meteringEnabled(env)) return operation();
  const generatedId = randomUUID();
  const suppliedId = options.questionId?.trim();
  const questionId = suppliedId && uuid.test(suppliedId) ? suppliedId.toLowerCase() : generatedId;
  const pricing = parsePriceBook(structuredClone(options.pricing ?? createDefaultPriceBook()));
  const capture = createEmptyCapture(options.path, questionId);
  capture.scope = options.scope ?? 'question';
  capture.origin = 'application-metered';
  capture.modelCalls = [];
  capture.runtime = {
    durationMs: 0, vcpu: resource(env, 'COST_CONTAINER_VCPU'),
    memoryGiB: resource(env, 'COST_CONTAINER_MEMORY_GIB'), requests: 1, basis: 'wall-clock-estimate',
  };
  capture.fabric = { operations: 0, cuSeconds: null, source: 'unavailable', correlation: 'unavailable' };
  // Fail closed before invoking a provider if configuration exceeds engine bounds.
  parseCapture(capture);
  const logReceipt = env.COST_LOG_RECEIPTS === 'true';
  const context: Context = { capture, active: true };
  return storage.run(context, async () => {
    const start = performance.now();
    capture.startedAt = new Date().toISOString();
    let operationFailed = false;
    let operationError: unknown;
    let result!: T;
    try {
      result = await operation();
      capture.outcome = 'succeeded';
    } catch (error) {
      operationFailed = true;
      operationError = error;
      capture.outcome = 'failed';
    } finally {
      context.active = false;
      capture.runtime.durationMs = Math.max(0, Math.round(performance.now() - start));
      capture.endedAt = new Date(Math.max(Date.now(), Date.parse(capture.startedAt))).toISOString();
    }
    const emissionErrors: unknown[] = [];
    try {
      const receipt = calculateCostReceipt(parseCapture(capture), pricing);
      if (operationFailed) {
        receipt.warnings.push('Operation failed; absent provider usage is unknown, not evidence of free Azure execution.');
      }
      // Log before handing a detached snapshot to application code.
      if (logReceipt) {
        try { console.error(JSON.stringify({ event: 'horizonte.cost.receipt', receipt })); }
        catch (error) { emissionErrors.push(error); }
      }
      try { options.onReceipt?.(structuredClone(receipt)); }
      catch (error) { emissionErrors.push(error); }
    } catch (error) {
      emissionErrors.push(error);
    }
    if (emissionErrors.length) {
      if (operationFailed) throw new AggregateError([operationError, ...emissionErrors], 'Operation and cost receipt emission failed.');
      if (emissionErrors.length === 1) throw emissionErrors[0];
      throw new AggregateError(emissionErrors, 'Cost receipt emission failed.');
    }
    if (operationFailed) throw operationError;
    return result;
  });
}
