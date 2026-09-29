import type { QuestionCostReceipt } from './cost-contracts.js';

export type Mode = 'home' | 'cowork' | 'code' | 'autopilot';
export type Intent = 'brief' | 'lesson' | 'diary' | 'learning' | 'writing' | 'metrics' | 'tool';

export interface Teacher {
  id: string;
  name: string;
  school: string;
  subject: string;
}

export interface Classroom {
  id: string;
  label: string;
  grade: string;
  studentCount: number;
}

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
  mode: Mode;
  tag: string;
}

export interface SystemDescriptor {
  id: string;
  name: string;
  kind: 'legacy' | 'ai' | 'content' | 'analytics';
  description: string;
  simulated: true;
}

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  systems: string[];
  ontologyPath: string[];
  readOnly: boolean;
}

export interface OntologyEntity {
  id: string;
  label: string;
  description: string;
  systemId: string;
}

export interface OntologyEdge {
  from: string;
  to: string;
  label: string;
}

export interface Evidence {
  id: string;
  label: string;
  sourceSystem: string;
  sourceKind: SystemDescriptor['kind'];
  path: string[];
  summary: string;
  synthetic: true;
}

export interface TraceStep {
  id: string;
  label: string;
  skill: string;
  system: string;
  evidenceIds: string[];
  status: 'completed';
}

export interface ToolSpec {
  kind: 'station-planner' | 'fraction-lab' | 'rubric-studio';
  durationMinutes: number;
  stationCount: number;
  numerator: number;
  denominator: number;
  title: string;
}

export interface Widget {
  id: string;
  type: 'metrics' | 'plan' | 'table' | 'diagnosis' | 'writing' | 'tool' | 'timeline';
  title: string;
  subtitle?: string;
  items?: { title: string; body: string; meta?: string }[];
  metrics?: { label: string; value: string; detail: string }[];
  columns?: string[];
  rows?: string[][];
  tool?: ToolSpec;
}

export interface ActionDraft {
  id: string;
  version: number;
  title: string;
  kind: 'diary-draft' | 'support-ticket' | 'lesson-kit' | 'feedback-draft';
  target: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  evidenceIds: string[];
  simulated: true;
  approvedAt?: string;
}

export interface Workspace {
  costReceipt?: QuestionCostReceipt;
  id: string;
  title: string;
  summary: string;
  mode: Mode;
  intent: Intent;
  model: 'azure-openai' | 'guided';
  modelNotice: string;
  widgets: Widget[];
  evidence: Evidence[];
  trace: TraceStep[];
  actions: ActionDraft[];
  followUps: string[];
}

export interface WatchRule {
  id: string;
  name: string;
  kind: 'diary-pending' | 'learning-gap' | 'week-prep';
  classId: string;
  enabled: boolean;
  description: string;
  lastRunAt?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  type: string;
  detail: string;
  actionId?: string;
}

export interface AutopilotRun {
  id: string;
  at: string;
  source: 'manual' | 'schedule';
  summary: string;
  actionIds: string[];
}

export interface AutopilotState {
  rules: WatchRule[];
  runs: AutopilotRun[];
  drafts: ActionDraft[];
  audit: AuditEvent[];
  schedule: string;
}

export interface Bootstrap {
  teacher: Teacher;
  classes: Classroom[];
  scenarios: Scenario[];
  systems: SystemDescriptor[];
  skills: SkillDescriptor[];
  ontology: { entities: OntologyEntity[]; edges: OntologyEdge[] };
  capabilities: {
    model: 'azure-openai' | 'guided';
    modelName: string;
    persistence: 'azure-blob' | 'local';
    synthetic: true;
    notices: string[];
  };
}

export interface SessionInfo {
  authenticated: boolean;
  csrfToken?: string;
}

export interface ChatRequest {
  message: string;
  classId: string;
  mode: Mode;
  guided?: boolean;
}

// The API transports only these declarative widgets, never executable model output.
export interface ApiError {
  error: { code: string; message: string };
}
