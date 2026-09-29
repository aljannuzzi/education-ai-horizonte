import assert from 'node:assert/strict';
import test from 'node:test';
import type { CostComponent, CostLine, CostPriceBook, QuestionCostCapture, QuestionCostReceipt } from '../shared/cost-contracts.js';
import {
  calculateCostReceipt,
  createDefaultPriceBook,
  createEmptyCapture,
  parseCapture,
  parsePriceBook,
} from '../shared/cost-engine.js';

const NOW = '2026-09-29T17:58:57.327Z';

function closeTo(actual: number | null, expected: number, epsilon = 1e-12) {
  assert.ok(typeof actual === 'number');
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

function line(receipt: QuestionCostReceipt, component: CostComponent): CostLine {
  const found = receipt.lines.find(candidate => candidate.component === component);
  assert.ok(found, `missing ${component} line`);
  return found;
}

function makeCall(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.4-mini',
    outcome: 'succeeded',
    durationMs: 1_000,
    inputTokens: 1_000,
    cachedInputTokens: 200,
    outputTokens: 400,
    reasoningOutputTokens: 25,
    source: 'provider-usage',
    requestId: 'req-1',
    ...overrides,
  };
}

function makeAzureCapture(overrides: Record<string, unknown> = {}): QuestionCostCapture {
  const capture: QuestionCostCapture = {
    schemaVersion: 1,
    questionId: 'question-1',
    scope: 'question',
    path: 'azure-mcp',
    origin: 'operator-entered',
    startedAt: NOW,
    endedAt: NOW,
    outcome: 'partial',
    modelCalls: [],
    runtime: {
      durationMs: null,
      vcpu: null,
      memoryGiB: null,
      requests: null,
      basis: 'unavailable',
    },
    fabric: {
      cuSeconds: null,
      operations: null,
      source: 'unavailable',
      correlation: 'unavailable',
    },
    cowork: {
      creditsBefore: null,
      creditsAfter: null,
      source: 'unavailable',
      isolatedQuestion: false,
      concurrentActivity: false,
    },
  };
  return {
    ...capture,
    ...overrides,
    modelCalls: (overrides.modelCalls as QuestionCostCapture['modelCalls'] | undefined) ?? capture.modelCalls,
    runtime: { ...capture.runtime, ...(overrides.runtime as object | undefined) },
    fabric: { ...capture.fabric, ...(overrides.fabric as object | undefined) },
    cowork: { ...capture.cowork, ...(overrides.cowork as object | undefined) },
  };
}

function makeNativeCapture(overrides: Record<string, unknown> = {}): QuestionCostCapture {
  return makeAzureCapture({
    path: 'cowork-fabric-iq',
    modelCalls: [],
    runtime: {
      durationMs: null,
      vcpu: null,
      memoryGiB: null,
      requests: null,
      basis: 'unavailable',
    },
    fabric: {
      cuSeconds: 7_200,
      operations: 2,
      source: 'capacity-metrics',
      correlation: 'operation-id',
    },
    cowork: {
      creditsBefore: 1_000,
      creditsAfter: 1_005,
      source: 'native-cost-command',
      isolatedQuestion: true,
      concurrentActivity: false,
    },
    ...overrides,
  });
}

function makeLocalCapture(overrides: Record<string, unknown> = {}): QuestionCostCapture {
  return makeAzureCapture({
    path: 'local-guided',
    modelCalls: [],
    runtime: {
      durationMs: null,
      vcpu: null,
      memoryGiB: null,
      requests: null,
      basis: 'unavailable',
    },
    fabric: {
      cuSeconds: null,
      operations: null,
      source: 'unavailable',
      correlation: 'unavailable',
    },
    ...overrides,
  });
}

function makePriceBook(overrides: Record<string, unknown> = {}): CostPriceBook {
  const priceBook: CostPriceBook = {
    id: 'book-1',
    kind: 'configured',
    currency: 'USD',
    effectiveDate: '2026-03-01',
    source: 'https://prices.example.com/api/retail/prices',
    openAi: [{
      model: 'gpt-5.4-mini',
      inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 4.5,
    }],
    container: {
      vcpuSecond: 0.4,
      memoryGiBSecond: 0.1,
      millionRequests: 0.2,
    },
    fabric: {
      capacityCu: 1.5,
      capacityHourly: 18,
    },
    cowork: {
      perCredit: 0.2,
    },
    shared: {
      periodLabel: '2026-09',
      periodCost: 0,
      questionCount: 10,
    },
  };
  return {
    ...priceBook,
    ...overrides,
    openAi: (overrides.openAi as CostPriceBook['openAi'] | undefined) ?? priceBook.openAi,
    container: { ...priceBook.container, ...(overrides.container as object | undefined) },
    fabric: { ...priceBook.fabric, ...(overrides.fabric as object | undefined) },
    cowork: { ...priceBook.cowork, ...(overrides.cowork as object | undefined) },
    shared: { ...priceBook.shared, ...(overrides.shared as object | undefined) },
  };
}

test('createEmptyCapture and createDefaultPriceBook expose documented defaults', () => {
  const empty = parseCapture(createEmptyCapture('azure-mcp', 'question-1', NOW));
  assert.deepEqual(empty, {
    schemaVersion: 1,
    questionId: 'question-1',
    scope: 'question',
    path: 'azure-mcp',
    origin: 'operator-entered',
    startedAt: NOW,
    endedAt: NOW,
    outcome: 'partial',
    modelCalls: [],
    runtime: {
      durationMs: null,
      vcpu: null,
      memoryGiB: null,
      requests: null,
      basis: 'unavailable',
    },
    fabric: {
      cuSeconds: null,
      operations: null,
      source: 'unavailable',
      correlation: 'unavailable',
    },
    cowork: {
      creditsBefore: null,
      creditsAfter: null,
      source: 'unavailable',
      isolatedQuestion: false,
      concurrentActivity: false,
    },
  });

  const priceBook = parsePriceBook(createDefaultPriceBook());
  assert.equal(priceBook.id, 'azure-retail-2026-09-29');
  assert.equal(priceBook.kind, 'configured');
  assert.equal(priceBook.currency, 'USD');
  assert.equal(priceBook.effectiveDate, '2026-03-01');
  assert.equal(priceBook.source, 'https://prices.azure.com/api/retail/prices');
  assert.deepEqual(priceBook.openAi, [{
    model: 'gpt-5.4-mini',
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  }]);
  assert.equal(priceBook.container.vcpuSecond, null);
  assert.equal(priceBook.container.memoryGiBSecond, null);
  assert.equal(priceBook.container.millionRequests, null);
  assert.equal(priceBook.fabric.capacityCu, null);
  assert.equal(priceBook.fabric.capacityHourly, null);
  assert.equal(priceBook.cowork.perCredit, null);
  assert.equal(priceBook.shared.periodCost, null);
  assert.equal(priceBook.shared.questionCount, null);
});

test('parseCapture rejects unknown fields, unsafe values and contradictory path usage', () => {
  const invalidCases = [
    { label: 'unknown field', value: { ...makeAzureCapture(), extra: true } },
    { label: 'unsafe question id url', value: makeAzureCapture({ questionId: 'https://attacker.example' }) },
    { label: 'unsafe question id length', value: makeAzureCapture({ questionId: 'x'.repeat(129) }) },
    { label: 'invalid calendar date', value: makeAzureCapture({ startedAt: '2026-02-30', endedAt: NOW }) },
    { label: 'date order', value: makeAzureCapture({ startedAt: '2026-09-29T18:00:00.000Z', endedAt: NOW }) },
    { label: 'non-finite number', value: makeAzureCapture({ modelCalls: [makeCall({ inputTokens: Number.POSITIVE_INFINITY })] }) },
    { label: 'too-large number', value: makeAzureCapture({ modelCalls: [makeCall({ inputTokens: 1_000_000_000_001 })] }) },
    { label: 'fractional token count', value: makeAzureCapture({ modelCalls: [makeCall({ outputTokens: 0.5 })] }) },
    { label: 'cached exceeds input', value: makeAzureCapture({ modelCalls: [makeCall({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 0, reasoningOutputTokens: 0 })] }) },
    { label: 'reasoning exceeds output', value: makeAzureCapture({ modelCalls: [makeCall({ outputTokens: 10, reasoningOutputTokens: 11 })] }) },
    { label: 'duration too large', value: makeAzureCapture({ modelCalls: [makeCall({ durationMs: 86_400_001 })] }) },
    { label: 'unavailable runtime with data', value: makeAzureCapture({ runtime: { basis: 'unavailable', durationMs: 1 } }) },
    { label: 'native model calls', value: makeNativeCapture({ modelCalls: [makeCall()] }) },
    { label: 'local fabric data', value: makeLocalCapture({ fabric: { cuSeconds: 1, operations: null, source: 'capacity-metrics', correlation: 'time-window' } }) },
    { label: 'nonnative cowork data', value: makeAzureCapture({ cowork: { creditsBefore: 10, creditsAfter: 9, source: 'admin-export', isolatedQuestion: true, concurrentActivity: false } }) },
    { label: 'native negative credits delta', value: makeNativeCapture({ cowork: { creditsBefore: 10, creditsAfter: 9, source: 'native-cost-command', isolatedQuestion: true, concurrentActivity: false } }) },
    { label: 'unavailable cowork with values', value: makeNativeCapture({ cowork: { creditsBefore: 10, creditsAfter: null, source: 'unavailable', isolatedQuestion: true, concurrentActivity: false } }) },
    { label: 'unavailable fabric with values', value: makeNativeCapture({ fabric: { cuSeconds: 10, operations: null, source: 'unavailable', correlation: 'unavailable' } }) },
  ];
  for (const { label, value } of invalidCases) assert.throws(() => parseCapture(value), label);
});

test('parsePriceBook rejects unknown fields, unsafe sources, duplicate models and invalid numeric bounds', () => {
  const accepted = parsePriceBook(makePriceBook({ fabric: { capacityCu: 1.25, capacityHourly: 9 } }));
  assert.equal(accepted.fabric.capacityCu, 1.25);

  const invalidCases = [
    { label: 'unknown field', value: { ...makePriceBook(), extra: true } },
    { label: 'unsafe id url', value: makePriceBook({ id: 'https://attacker.example' }) },
    { label: 'unsafe id length', value: makePriceBook({ id: 'x'.repeat(129) }) },
    { label: 'invalid effective date', value: makePriceBook({ effectiveDate: '2026-02-30' }) },
    { label: 'empty source', value: makePriceBook({ source: '' }) },
    { label: 'credentials in source', value: makePriceBook({ source: 'https://user:pass@prices.example.com/api/retail/prices' }) },
    { label: 'query string in source', value: makePriceBook({ source: 'https://prices.example.com/api/retail/prices?sig=secret' }) },
    { label: 'too-long source', value: makePriceBook({ source: 'x'.repeat(501) }) },
    { label: 'zero capacity CU', value: makePriceBook({ fabric: { capacityCu: 0, capacityHourly: 9 } }) },
    { label: 'duplicate openai model', value: makePriceBook({ openAi: [makePriceBook().openAi[0]!, { ...makePriceBook().openAi[0]! }] }) },
    { label: 'non-finite rate', value: makePriceBook({ container: { vcpuSecond: Number.NaN, memoryGiBSecond: 0.1, millionRequests: 0.2 } }) },
    { label: 'too-large rate', value: makePriceBook({ cowork: { perCredit: 1_000_000_000_001 } }) },
  ];
  for (const { label, value } of invalidCases) assert.throws(() => parsePriceBook(value), label);
});

test('calculateCostReceipt charges priced Azure tokens, keeps five fixed lines and does not mutate inputs', () => {
  const capture = parseCapture(makeAzureCapture({
    origin: 'application-metered',
    outcome: 'failed',
    modelCalls: [makeCall()],
    runtime: {
      durationMs: 0,
      vcpu: 4,
      memoryGiB: 8,
      requests: 0,
      basis: 'attributed-usage',
    },
  }));
  const priceBook = parsePriceBook(makePriceBook());
  const captureBefore = structuredClone(capture);
  const priceBefore = structuredClone(priceBook);

  const receipt = calculateCostReceipt(capture, priceBook);
  assert.deepEqual(capture, captureBefore);
  assert.deepEqual(priceBook, priceBefore);
  assert.deepEqual(receipt.lines.map(current => current.component), [
    'azure-openai',
    'azure-container',
    'fabric-capacity',
    'cowork-credits',
    'shared-overhead',
  ]);
  closeTo(line(receipt, 'azure-openai').amount, 0.002415);
  closeTo(line(receipt, 'azure-container').amount, 0);
  closeTo(line(receipt, 'shared-overhead').amount, 0);
  assert.equal(line(receipt, 'fabric-capacity').basis, 'unavailable');
  assert.equal(line(receipt, 'cowork-credits').basis, 'not-applicable');
  closeTo(receipt.totals.azureEstimate, 0.002415);
  assert.equal(receipt.totals.fabricAllocation, null);
  assert.equal(receipt.totals.coworkEstimate, null);
  closeTo(receipt.totals.sharedAllocation, 0);
  closeTo(receipt.totals.knownSubtotal, 0.002415);
  assert.equal(receipt.totals.completeness, 'partial');
  assert.equal(receipt.coworkCredits, null);
  assert.equal(receipt.billingRecord, false);
  assert.ok(receipt.warnings.some(warning => warning.includes('não é fatura')));
});

test('calculateCostReceipt distinguishes missing rates from true zero and only requires necessary rates for zero quantities', () => {
  const partial = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [makeCall({ outputTokens: 1, reasoningOutputTokens: 0 })],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook({
      openAi: [{
        model: 'gpt-5.4-mini',
        inputPerMillion: 0.75,
        cachedInputPerMillion: 0.075,
        outputPerMillion: null,
      }],
    })),
  );
  assert.equal(line(partial, 'azure-openai').amount, null);

  const zeroQuantity = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [makeCall({ outputTokens: 0, reasoningOutputTokens: 0 })],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook({
      openAi: [{
        model: 'gpt-5.4-mini',
        inputPerMillion: 0.75,
        cachedInputPerMillion: 0.075,
        outputPerMillion: null,
      }],
    })),
  );
  closeTo(line(zeroQuantity, 'azure-openai').amount, 0.000615);

  const trueZero = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [makeCall({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook()),
  );
  closeTo(line(trueZero, 'azure-openai').amount, 0);
  assert.equal(trueZero.totals.knownSubtotal, 0);
});

test('calculateCostReceipt nulls the Azure line for unpriced calls, warns on missing cache and distinguishes empty calls by origin', () => {
  const unpriced = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [
        makeCall({ cachedInputTokens: null }),
        makeCall({ model: 'unknown-model', inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, requestId: 'req-2' }),
      ],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook()),
  );
  assert.equal(line(unpriced, 'azure-openai').amount, null);
  assert.equal(unpriced.totals.azureEstimate, null);
  assert.equal(unpriced.totals.completeness, 'partial');
  assert.equal(unpriced.totals.knownSubtotal, 0);
  assert.ok(unpriced.warnings.some(warning => warning.includes('cache não informado: sem desconto')));

  const meteredEmpty = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook()),
  );
  closeTo(line(meteredEmpty, 'azure-openai').amount, 0);
  assert.equal(line(meteredEmpty, 'azure-openai').basis, 'not-applicable');

  const operatorEmpty = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'operator-entered',
      modelCalls: [],
      runtime: { durationMs: 0, vcpu: 1, memoryGiB: 1, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook()),
  );
  assert.equal(line(operatorEmpty, 'azure-openai').amount, null);
});

test('calculateCostReceipt prices runtime estimates and keeps missing runtime or fabric inputs null instead of NaN', () => {
  const estimated = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [],
      runtime: { durationMs: 2_000, vcpu: 1.5, memoryGiB: 2, requests: 500_000, basis: 'wall-clock-estimate' },
    })),
    parsePriceBook(makePriceBook()),
  );
  closeTo(line(estimated, 'azure-container').amount, 1.7);
  assert.equal(line(estimated, 'azure-container').basis, 'estimated');
  assert.ok(estimated.warnings.length > 0);

  const missingInputs = calculateCostReceipt(
    parseCapture(makeAzureCapture({
      origin: 'application-metered',
      modelCalls: [],
      runtime: { durationMs: 1_000, vcpu: 1, memoryGiB: null, requests: 0, basis: 'attributed-usage' },
    })),
    parsePriceBook(makePriceBook()),
  );
  assert.equal(line(missingInputs, 'azure-container').amount, null);

  const missingFabricPricing = calculateCostReceipt(
    parseCapture(makeNativeCapture()),
    parsePriceBook(makePriceBook({ fabric: { capacityCu: 1.5, capacityHourly: null } })),
  );
  assert.equal(line(missingFabricPricing, 'fabric-capacity').amount, null);

  for (const receipt of [estimated, missingInputs, missingFabricPricing]) {
    for (const current of receipt.lines) assert.equal(typeof current.amount === 'number' && Number.isNaN(current.amount), false);
  }
});

test('calculateCostReceipt applies native fabric, cowork and shared allocation using book currency and scope rules', () => {
  const priceBook = parsePriceBook(makePriceBook({
    currency: 'EUR',
    shared: { periodLabel: '2026-09', periodCost: 20, questionCount: 10 },
  }));

  const nativeReceipt = calculateCostReceipt(parseCapture(makeNativeCapture()), priceBook);
  assert.equal(line(nativeReceipt, 'azure-openai').basis, 'not-applicable');
  assert.equal(line(nativeReceipt, 'azure-openai').amount, null);
  assert.equal(line(nativeReceipt, 'azure-container').basis, 'not-applicable');
  assert.equal(line(nativeReceipt, 'azure-container').amount, null);
  closeTo(line(nativeReceipt, 'fabric-capacity').amount, 24);
  assert.equal(line(nativeReceipt, 'fabric-capacity').basis, 'allocated');
  closeTo(line(nativeReceipt, 'cowork-credits').amount, 1);
  assert.equal(line(nativeReceipt, 'cowork-credits').basis, 'approximate-native');
  closeTo(line(nativeReceipt, 'shared-overhead').amount, 2);
  assert.equal(line(nativeReceipt, 'shared-overhead').basis, 'allocated');
  assert.equal(nativeReceipt.coworkCredits, 5);
  closeTo(nativeReceipt.totals.fabricAllocation, 24);
  closeTo(nativeReceipt.totals.coworkEstimate, 1);
  closeTo(nativeReceipt.totals.sharedAllocation, 2);
  closeTo(nativeReceipt.totals.knownSubtotal, 27);
  assert.equal(nativeReceipt.totals.completeness, 'complete-estimate');
  assert.ok(nativeReceipt.lines.every(current => current.currency === 'EUR'));

  const scopedOut = calculateCostReceipt(
    parseCapture(makeNativeCapture({
      scope: 'task',
      cowork: {
        creditsBefore: 1_000,
        creditsAfter: 1_005,
        source: 'native-cost-command',
        isolatedQuestion: true,
        concurrentActivity: false,
      },
    })),
    priceBook,
  );
  assert.equal(line(scopedOut, 'cowork-credits').amount, null);
  assert.equal(scopedOut.coworkCredits, null);

  const notIsolated = calculateCostReceipt(
    parseCapture(makeNativeCapture({
      cowork: {
        creditsBefore: 1_000,
        creditsAfter: 1_005,
        source: 'native-cost-command',
        isolatedQuestion: false,
        concurrentActivity: false,
      },
    })),
    priceBook,
  );
  assert.equal(line(notIsolated, 'cowork-credits').amount, null);
});

test('empty captures for every path stay unknown, use supplied date and do not invent prices', () => {
  for (const path of ['azure-mcp', 'cowork-fabric-iq', 'local-guided'] as const) {
    const c = createEmptyCapture(path, 'empty', NOW);
    const r = calculateCostReceipt(c, createDefaultPriceBook());
    assert.equal(c.path, path);
    assert.equal(c.startedAt, NOW);
    assert.equal(c.endedAt, NOW);
    assert.equal(r.totals.knownSubtotal, null);
    assert.equal(r.totals.completeness, 'unpriced');
    assert.equal(r.coworkCredits, null);
    if (path !== 'azure-mcp') {
      assert.equal(r.totals.azureEstimate, null);
      assert.equal(line(r, 'azure-openai').basis, 'not-applicable');
      assert.equal(line(r, 'azure-container').basis, 'not-applicable');
    }
  }
  assert.throws(() => createEmptyCapture('azure-mcp', 'empty', 'invalid'));
  assert.throws(() => createEmptyCapture('azure-mcp', 'empty', '2026-02-30T00:00:00Z'));
  const fresh = createEmptyCapture('azure-mcp', 'fresh');
  assert.ok(Number.isFinite(Date.parse(fresh.startedAt)));
});

test('every nullable property is required and all object boundaries are strict', () => {
  const c = makeAzureCapture();
  for (const key of Object.keys(c) as (keyof QuestionCostCapture)[]) {
    const value = structuredClone(c) as unknown as Record<string, unknown>;
    delete value[key];
    assert.throws(() => parseCapture(value), key);
  }
  for (const section of ['runtime', 'fabric', 'cowork'] as const) {
    const entries = c[section];
    for (const key of Object.keys(entries)) {
      const value = structuredClone(c);
      delete (value[section] as unknown as Record<string, unknown>)[key];
      assert.throws(() => parseCapture(value), `${section}.${key}`);
    }
    assert.throws(() => parseCapture({ ...c, [section]: { ...entries, prompt: 'not allowed' } }));
  }
  const p = makePriceBook();
  for (const section of ['container', 'fabric', 'cowork', 'shared'] as const) {
    for (const key of Object.keys(p[section])) {
      const value = structuredClone(p);
      delete (value[section] as unknown as Record<string, unknown>)[key];
      assert.throws(() => parsePriceBook(value), `${section}.${key}`);
    }
    assert.throws(() => parsePriceBook({ ...p, [section]: { ...p[section], secret: 'not allowed' } }));
  }
  const usage = makeCall();
  for (const key of Object.keys(usage).filter(key => key !== 'requestId')) {
    const value: Record<string, unknown> = { ...usage };
    delete value[key];
    assert.throws(() => parseCapture(makeAzureCapture({ modelCalls: [value] })), key);
  }
  assert.throws(() => parseCapture(makeAzureCapture({ modelCalls: [{ ...usage, questionText: 'not allowed' }] })));
  assert.throws(() => parsePriceBook({ ...p, openAi: [{ ...p.openAi[0], prompt: 'not allowed' }] }));
});

test('limits reject invalid dates, unsafe identifiers, fractional counts and numeric extremes', () => {
  for (const startedAt of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-09-29T24:00:00Z', '2026-09-29T17:00:00', '2026-09-29']) {
    assert.throws(() => parseCapture(makeAzureCapture({ startedAt })));
  }
  for (const id of ['', 'with spaces', '../path', 'x?token=y', 'a@b', 'x'.repeat(129)]) {
    assert.throws(() => parseCapture(makeAzureCapture({ questionId: id })));
    assert.throws(() => parseCapture(makeAzureCapture({ modelCalls: [makeCall({ requestId: id })] })));
  }
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1e12 + 1, 0.5]) {
    assert.throws(() => parseCapture(makeAzureCapture({ modelCalls: [makeCall({ inputTokens: value })] })));
  }
  assert.throws(() => parseCapture(makeAzureCapture({ modelCalls: Array.from({ length: 33 }, () => makeCall()) })));
  assert.equal(parseCapture(makeAzureCapture({ modelCalls: Array.from({ length: 32 }, () => makeCall()) })).modelCalls.length, 32);
  assert.throws(() => parseCapture(makeAzureCapture({ runtime: { basis: 'attributed-usage', requests: 0.1 } })));
  assert.throws(() => parseCapture(makeNativeCapture({ fabric: { operations: 0.1 } })));
  assert.throws(() => parsePriceBook(makePriceBook({ shared: { questionCount: 0 } })));
  assert.throws(() => parsePriceBook(makePriceBook({ shared: { questionCount: 1.5 } })));
  assert.throws(() => parsePriceBook(makePriceBook({ fabric: { capacityCu: Number.MIN_VALUE } })));
  for (const source of [' ', 'http://prices.example.com', 'https://u:p@example.com',
    'https://example.com?api-key=abc', 'https://example.com#secret', 'Bearer abc', 'file:///etc']) {
    assert.throws(() => parsePriceBook(makePriceBook({ source })));
  }
  assert.equal(parsePriceBook(makePriceBook({ source: 'Tabela pública Azure Retail' })).source, 'Tabela pública Azure Retail');
});

test('native and local paths reject runtime contradictions rather than double charging', () => {
  for (const path of ['cowork-fabric-iq', 'local-guided'] as const) {
    const c = createEmptyCapture(path, 'native', NOW);
    for (const key of ['durationMs', 'vcpu', 'memoryGiB', 'requests']) {
      assert.throws(() => parseCapture({ ...c, runtime: { ...c.runtime, [key]: 1, basis: 'attributed-usage' } }));
    }
    assert.throws(() => parseCapture({ ...c, modelCalls: [makeCall()] }));
  }
});

test('multiple calls sum only complete usage and failed calls remain chargeable', () => {
  const single = calculateCostReceipt(makeAzureCapture({ modelCalls: [makeCall()] }), makePriceBook());
  const double = calculateCostReceipt(makeAzureCapture({
    modelCalls: [makeCall(), makeCall({ outcome: 'failed', requestId: 'req-2' })],
  }), makePriceBook());
  closeTo(line(double, 'azure-openai').amount, line(single, 'azure-openai').amount! * 2);
  assert.ok(double.warnings.some(w => w.includes('falha')));
  const missingCache = calculateCostReceipt(makeAzureCapture({
    modelCalls: [makeCall({ cachedInputTokens: null })],
  }), makePriceBook());
  closeTo(line(missingCache, 'azure-openai').amount, 0.00255);
  for (const key of ['inputTokens', 'outputTokens']) {
    const missing = calculateCostReceipt(makeAzureCapture({
      modelCalls: [makeCall(), makeCall({ [key]: null })],
    }), createDefaultPriceBook());
    assert.equal(line(missing, 'azure-openai').amount, null);
    assert.equal(missing.totals.knownSubtotal, null);
    assert.equal(missing.totals.completeness, 'unpriced');
  }
});

test('fabric reports measured zero and fractional CU, and warns about attribution strength', () => {
  for (const cuSeconds of [0, 0.25, 7200]) {
    const r = calculateCostReceipt(makeNativeCapture({
      fabric: { cuSeconds, operations: 1, source: 'capacity-metrics', correlation: 'time-window' },
    }), makePriceBook());
    closeTo(line(r, 'fabric-capacity').amount, cuSeconds * 18 / (3600 * 1.5));
    assert.equal(line(r, 'fabric-capacity').quantity, cuSeconds);
    assert.equal(line(r, 'fabric-capacity').basis, 'allocated');
    assert.ok(r.warnings.some(w => w.includes('heurística')));
  }
  const strong = calculateCostReceipt(makeNativeCapture(), makePriceBook());
  assert.ok(strong.warnings.some(w => w.includes('ID de operação')));
});

test('application operation counts alone never imply known Fabric CU usage or zero cost', () => {
  for (const operations of [0, 3]) {
    const c = createEmptyCapture('azure-mcp', 'operations-only', NOW);
    c.origin = 'application-metered';
    c.fabric.operations = operations;
    const r = calculateCostReceipt(c, makePriceBook());
    assert.equal(r.capture.fabric.operations, operations);
    assert.equal(line(r, 'fabric-capacity').quantity, null);
    assert.equal(line(r, 'fabric-capacity').amount, null);
    assert.equal(line(r, 'fabric-capacity').basis, 'unavailable');
  }
});

test('credits require isolation, nonconcurrency, question scope and monotonic counters', () => {
  for (const source of ['admin-export', 'native-cost-command'] as const) {
    const c = makeNativeCapture();
    c.cowork.source = source;
    const unpriced = calculateCostReceipt(c, createDefaultPriceBook());
    assert.equal(unpriced.coworkCredits, source === 'native-cost-command' ? 5 : null);
    assert.equal(line(unpriced, 'cowork-credits').amount, null);
    for (const patch of [{ isolatedQuestion: false }, { concurrentActivity: true },
      { creditsBefore: null }, { creditsAfter: null }]) {
      const r = calculateCostReceipt({ ...c, cowork: { ...c.cowork, ...patch } }, makePriceBook());
      assert.equal(r.coworkCredits, null);
      assert.equal(line(r, 'cowork-credits').amount, null);
    }
    for (const scope of ['task', 'tool-call'] as const) {
      const r = calculateCostReceipt({ ...c, scope }, makePriceBook());
      assert.equal(r.coworkCredits, null);
      assert.ok(r.warnings.some(w => w.includes('Escopo')));
    }
    assert.throws(() => calculateCostReceipt({ ...c, cowork: { ...c.cowork, creditsAfter: 0 } }, makePriceBook()));
    const zero = calculateCostReceipt({ ...c, cowork: { ...c.cowork, creditsAfter: c.cowork.creditsBefore } }, makePriceBook());
    assert.equal(zero.coworkCredits, source === 'native-cost-command' ? 0 : null);
    assert.equal(line(zero, 'cowork-credits').amount, source === 'native-cost-command' ? 0 : null);
  }
});

test('fractional task credits are preserved and aggregate administrative exports are not attributed', () => {
  const c = makeNativeCapture({
    cowork: { creditsBefore: 1.25, creditsAfter: 3.75, source: 'native-cost-command',
      isolatedQuestion: true, concurrentActivity: false },
  });
  assert.equal(calculateCostReceipt(c, makePriceBook()).coworkCredits, 2.5);
  c.cowork.source = 'admin-export';
  assert.equal(calculateCostReceipt(c, makePriceBook()).coworkCredits, null);
});

test('all applicable components priced give a complete estimate, never an invoice', () => {
  const c = makeAzureCapture({
    origin: 'application-metered', modelCalls: [makeCall()],
    runtime: { durationMs: 1000, vcpu: 1, memoryGiB: 1, requests: 1, basis: 'attributed-usage' },
    fabric: { cuSeconds: 1, operations: 1, source: 'capacity-metrics', correlation: 'operation-id' },
  });
  const r = calculateCostReceipt(c, makePriceBook());
  assert.equal(r.totals.completeness, 'complete-estimate');
  assert.equal(r.billingRecord, false);
  assert.ok(r.warnings.some(w => w.includes('não é fatura')));
  assert.ok(r.warnings.some(w => w.includes('reconciliação')));
  assert.ok(r.lines.every(l => l.formula.length > 0 && l.label.length > 0));
});

test('large bounded inputs stay finite and currency changes never apply implicit FX', () => {
  const c = makeNativeCapture({
    fabric: { cuSeconds: 1e12, operations: 1e12, source: 'capacity-metrics', correlation: 'operation-id' },
    cowork: { creditsBefore: 0, creditsAfter: 1e12, source: 'admin-export', isolatedQuestion: true, concurrentActivity: false },
  });
  const p = makePriceBook({
    fabric: { capacityCu: 0.000001, capacityHourly: 1e12 },
    cowork: { perCredit: 1e12 },
    shared: { periodCost: 1e12, questionCount: 1 },
  });
  const usd = calculateCostReceipt(c, p);
  const brl = calculateCostReceipt(c, { ...p, currency: 'BRL' });
  assert.equal(usd.totals.knownSubtotal, brl.totals.knownSubtotal);
  assert.ok(brl.lines.every(l => l.currency === 'BRL'));
  assert.ok(brl.warnings.some(w => w.includes('BRL') && w.includes('FX')));
  for (const r of [usd, brl]) {
    for (const value of [...r.lines.map(l => l.amount), r.totals.knownSubtotal]) {
      assert.ok(value === null || Number.isFinite(value));
    }
  }
  const illustrative = calculateCostReceipt(c, { ...p, kind: 'illustrative' });
  assert.equal(line(illustrative, 'fabric-capacity').basis, 'illustrative');
  assert.ok(illustrative.warnings.some(w => w.includes('ilustrativos')));
});
