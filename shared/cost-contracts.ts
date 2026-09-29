export type CostPath = 'cowork-fabric-iq' | 'azure-mcp' | 'local-guided';
export type CaptureOrigin = 'application-metered' | 'operator-entered' | 'synthetic-example';
export type CostOutcome = 'succeeded' | 'failed' | 'partial';

export interface ModelUsage {
  model: string;
  outcome: 'succeeded' | 'failed';
  durationMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  source: 'provider-usage' | 'operator' | 'example';
  requestId?: string;
}

export interface QuestionCostCapture {
  schemaVersion: 1;
  questionId: string;
  scope: 'question' | 'tool-call' | 'task';
  path: CostPath;
  origin: CaptureOrigin;
  startedAt: string;
  endedAt: string;
  outcome: CostOutcome;
  modelCalls: ModelUsage[];
  runtime: {
    durationMs: number | null;
    vcpu: number | null;
    memoryGiB: number | null;
    requests: number | null;
    basis: 'wall-clock-estimate' | 'attributed-usage' | 'unavailable';
  };
  fabric: {
    cuSeconds: number | null;
    operations: number | null;
    source: 'capacity-metrics' | 'operator-estimate' | 'unavailable';
    correlation: 'operation-id' | 'time-window' | 'unavailable';
  };
  cowork: {
    creditsBefore: number | null;
    creditsAfter: number | null;
    source: 'native-cost-command' | 'admin-export' | 'unavailable';
    isolatedQuestion: boolean;
    concurrentActivity: boolean;
  };
}

export interface CostPriceBook {
  id: string;
  kind: 'configured' | 'illustrative';
  currency: 'USD' | 'BRL' | 'EUR';
  effectiveDate: string;
  source: string;
  openAi: {
    model: string;
    inputPerMillion: number | null;
    cachedInputPerMillion: number | null;
    outputPerMillion: number | null;
  }[];
  container: {
    vcpuSecond: number | null;
    memoryGiBSecond: number | null;
    millionRequests: number | null;
  };
  fabric: {
    capacityCu: number | null;
    capacityHourly: number | null;
  };
  cowork: {
    perCredit: number | null;
  };
  shared: {
    periodLabel: string;
    periodCost: number | null;
    questionCount: number | null;
  };
}

export type CostComponent = 'azure-openai' | 'azure-container' | 'fabric-capacity' | 'cowork-credits' | 'shared-overhead';
export type CostBasis = 'measured-usage-estimate' | 'estimated' | 'allocated' | 'approximate-native' | 'illustrative' | 'unavailable' | 'not-applicable';

export interface CostLine {
  component: CostComponent;
  label: string;
  amount: number | null;
  currency: CostPriceBook['currency'];
  basis: CostBasis;
  quantity: number | null;
  unit: string;
  formula: string;
  notes: string[];
}

export interface QuestionCostReceipt {
  schemaVersion: 1;
  questionId: string;
  capture: QuestionCostCapture;
  pricing: CostPriceBook;
  lines: CostLine[];
  totals: {
    azureEstimate: number | null;
    fabricAllocation: number | null;
    coworkEstimate: number | null;
    sharedAllocation: number | null;
    knownSubtotal: number | null;
    completeness: 'complete-estimate' | 'partial' | 'unpriced';
  };
  coworkCredits: number | null;
  warnings: string[];
  billingRecord: false;
}
