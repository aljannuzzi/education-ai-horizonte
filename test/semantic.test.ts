import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import graph from '../ontology/graph.json' with { type: 'json' };
import dataset from '../ontology/dataset.json' with { type: 'json' };
import catalog from '../skills/catalog.json' with { type: 'json' };
import type { Intent, Mode } from '../shared/contracts.js';
import {
  adapterContracts, assertClass, buildWorkspace, calculateMeasures, classes, defaultToolSpec,
  executeSkill, inferIntent, scenarios, teacher, toolSpecSchema,
} from '../server/semantic.js';

const labPrompt = 'O laboratorio ficou indisponivel. Como mantenho minha aula?';
const root = fileURLToPath(new URL('..', import.meta.url));
const intents: Intent[] = ['brief', 'lesson', 'diary', 'learning', 'writing', 'metrics', 'tool'];
const modes: Mode[] = ['home', 'cowork', 'code', 'autopilot'];
const workspace = (intent: Intent, classId = 'class-7a', mode: Mode = 'cowork') =>
  buildWorkspace({ classId, mode, intent, model: 'guided' });

test('unavailable laboratory means lesson; explicit declarative tools retain their intent', () => {
  assert.equal(inferIntent(labPrompt), 'lesson');
  assert.equal(inferIntent('O laboratório está interditado. Como continuo a aula?'), 'lesson');
  assert.equal(inferIntent('Laboratório fechado: preparar alternativa e ticket de manutenção.'), 'lesson');
  assert.equal(inferIntent('Configure a ferramenta fraction-lab.'), 'tool');
  assert.equal(inferIntent('Crie um laboratório de frações em papel.'), 'tool');
  assert.equal(scenarios.find(item => item.id === 'unavailable-lab')?.prompt, labPrompt);
  for (const mode of modes) {
    assert.equal(workspace(inferIntent(labPrompt), 'class-7a', mode).intent, 'lesson');
    for (const intent of intents) assert.equal(workspace(intent, 'class-7a', mode).intent, intent);
  }
});

test('JSON routes traverse space, lesson, classroom, curriculum and teacher-owned materials with provenance', () => {
  const execution = executeSkill('design-offline-lesson', 'class-7a');
  const material = execution.results.find(result => result.record.id === 'a-water-print')!;
  assert.ok(material);
  assert.deepEqual(material.path, ['Professor', 'Espaço', 'Aula', 'Turma', 'Habilidade curricular', 'Material docente']);
  assert.equal(material.record.teacherId, teacher.id);
  assert.equal(material.provenance.sourceSystem, 'library');
  assert.equal(material.provenance.readOnly, true);
  assert.equal(material.provenance.simulated, true);
  assert.equal(material.provenance.classId, 'class-7a');
  const space = dataset.space.find(row => row.id === 'a-lab')!;
  const lesson = dataset.lesson.find(row => row.spaceId === space.id)!;
  const classroom = dataset.classroom.find(row => row.id === lesson.classId)!;
  const skill = dataset.curriculum.find(row => row.id === material.record.curriculumId)!;
  assert.equal(skill.classId, classroom.id);
  assert.equal(skill.lessonId, lesson.id);
  for (const id of [space.id, lesson.id, classroom.id, skill.id]) {
    assert.ok(execution.results.some(result => result.record.id === id));
  }
  const evidenceIds = new Set(execution.evidence.map(row => row.id));
  assert.equal(evidenceIds.size, execution.evidence.length);
  for (const result of execution.results) {
    const evidence = execution.evidence.find(row => row.id === result.evidenceId)!;
    assert.deepEqual(evidence.path, result.path);
    assert.equal(evidence.synthetic, true);
    assert.ok(evidence.summary.includes(result.provenance.source));
    for (let index = 1; index < result.path.length; index++) {
      const from = graph.entities.find(entity => entity.label === result.path[index - 1])!.id;
      const to = graph.entities.find(entity => entity.label === result.path[index])!.id;
      assert.ok(graph.edges.some(edge => edge.from === from && edge.to === to));
    }
  }
  for (const step of execution.trace) {
    assert.equal(step.status, 'completed');
    assert.ok(step.evidenceIds.length);
    assert.ok(step.evidenceIds.every(id => evidenceIds.has(id)));
  }
  assert.ok(adapterContracts.every(adapter => adapter.readOnly && adapter.simulated));
});

test('JSON join keys and routes actually control material reachability, rather than decorate hardcoded lookups', () => {
  for (const mutation of [
    "graph.edges.find(edge => edge.from === 'space' && edge.to === 'lesson').targetKey = 'nonexistent';",
    "graph.edges.find(edge => edge.from === 'curriculum' && edge.to === 'material').targetKey = 'nonexistent';",
    "catalog.skills.find(skill => skill.operation === 'lesson').routes.pop();",
  ]) {
    const script = `
      import assert from 'node:assert/strict';
      import graph from './ontology/graph.json' with { type: 'json' };
      import catalog from './skills/catalog.json' with { type: 'json' };
      ${mutation}
      const { executeSkill } = await import('./server/semantic.ts');
      const result = executeSkill('design-offline-lesson', 'class-7a');
      assert.equal(result.results.some(row => row.entity === 'material'), false);
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('two classes isolate evidence, materials, lesson duration, stations and all actions', () => {
  assert.equal(classes.length, 2);
  for (const [classId, prefix, minutes, stationCount, materialTitle] of [
    ['class-7a', 'a-', 48, 4, 'Kit de envelopes da água'],
    ['class-7b', 'b-', 45, 3, 'Kit de mapas da água'],
  ] as const) {
    for (const skill of catalog.skills) {
      const execution = executeSkill(skill.id, classId);
      for (const result of execution.results) {
        if ('classId' in result.record) assert.equal(result.record.classId, classId);
        if (result.entity === 'classroom') assert.equal(result.record.id, classId);
        if ('teacherId' in result.record) assert.equal(result.record.teacherId, teacher.id);
      }
    }
    const result = workspace('lesson', classId);
    const plan = result.widgets.find(widget => widget.id === 'offline-lesson')!;
    assert.ok(plan.subtitle?.includes(`${minutes} minutos; ${stationCount} estações`));
    assert.equal(plan.items!.length, stationCount + 1);
    assert.equal(plan.items!.slice(0, -1).reduce((sum, item) => sum + Number(item.title.match(/(\d+) minutos/)![1]), 0), minutes);
    const alternative = result.widgets.find(widget => widget.id === 'unavailable-space')!;
    assert.equal(alternative.items![0]!.title, materialTitle);
    assert.ok(result.evidence.some(item => item.label.includes(`${prefix}water-print`)));
    assert.ok(!JSON.stringify(result).includes(prefix === 'a-' ? 'b-water-print' : 'a-water-print'));
    assert.ok(!JSON.stringify(result).includes('a-foreign-print'));
    assert.ok(!JSON.stringify(result).includes('a-unlinked-print'));
    const kit = result.actions.find(action => action.kind === 'lesson-kit')!;
    assert.ok(kit.content.includes(materialTitle));
    assert.ok(kit.content.includes('sem internet'));
    assert.ok(kit.evidenceIds.some(id => id.includes(`${prefix}water-print`)));
    const support = result.actions.find(action => action.kind === 'support-ticket')!;
    assert.ok(support.content.includes('Solicitação não enviada'));
    assert.ok(support.evidenceIds.some(id => id.includes(`${prefix}lab`)));
    assert.ok(support.content.includes('nunca preenche diário'));
    assert.ok(result.actions.every(action => action.status === 'pending' && action.simulated && !action.approvedAt));
    assert.ok(result.actions.every(action => action.evidenceIds.every(id => result.evidence.some(evidence => evidence.id === id))));
    assert.ok(!result.actions.some(action => action.kind === 'diary-draft'));
  }
});

test('class access fails closed even when exported bootstrap metadata is mutated', () => {
  for (const classId of ['unknown', '', 'class-other']) {
    assert.throws(() => assertClass(classId), { code: 'CLASS_FORBIDDEN', status: 403 });
    assert.throws(() => workspace('lesson', classId), { code: 'CLASS_FORBIDDEN', status: 403 });
    assert.throws(() => executeSkill('design-offline-lesson', classId), { code: 'CLASS_FORBIDDEN', status: 403 });
  }
  const original = teacher.id;
  teacher.id = 'teacher-other';
  try {
    assert.ok(!executeSkill('design-offline-lesson', 'class-7a').results.some(row => row.record.id === 'a-foreign-print'));
  } finally {
    teacher.id = original;
  }
});

test('lesson plan remains available without an unavailable space; unauthorized materials fail closed', () => {
  for (const [mutation, assertion] of [
    [
      "dataset.space.forEach(space => { space.status = 'available'; });",
      "const result = buildWorkspace(input); assert.ok(result.widgets.some(w => w.id === 'offline-lesson')); assert.equal(result.widgets.some(w => w.id === 'unavailable-space'), false); assert.equal(result.actions.length, 1);",
    ],
    [
      "dataset.material.forEach(material => { material.teacherId = 'teacher-other'; });",
      "assert.throws(() => buildWorkspace(input), { code: 'SEMANTIC_DATA_ERROR' });",
    ],
  ]) {
    const script = `
      import assert from 'node:assert/strict';
      import dataset from './ontology/dataset.json' with { type: 'json' };
      ${mutation}
      const { buildWorkspace } = await import('./server/semantic.ts');
      const input = { classId: 'class-7a', mode: 'cowork', intent: 'lesson', model: 'guided' };
      ${assertion}
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('completion, assessed accuracy and missing data use distinct correct denominators', () => {
  assert.deepEqual(calculateMeasures({ expected: 24, received: 24, ingested: 18, assessed: 15, correct: 9 }), {
    expected: 24, received: 24, ingested: 18, assessed: 15, correct: 9,
    notReceived: 0, notYetIntegrated: 6, awaitingAssessment: 3, needsReview: 6,
    completionPercent: 75, accuracyPercent: 60,
  });
  const b = calculateMeasures({ expected: 28, received: 20, ingested: 20, assessed: 20, correct: 16 });
  assert.equal(b.completionPercent, 100 * 20 / 28);
  assert.equal(b.accuracyPercent, 80);
  assert.equal(b.notReceived, 8);
  assert.equal(b.notYetIntegrated, 0);
  const empty = calculateMeasures({ expected: 0, received: 0, ingested: 0, assessed: 0, correct: 0 });
  assert.equal(empty.completionPercent, null);
  assert.equal(empty.accuracyPercent, null);
  const metricsA = workspace('metrics').widgets[0]!.metrics!;
  const metricsB = workspace('metrics', 'class-7b').widgets[0]!.metrics!;
  assert.deepEqual(metricsA.map(row => row.value), ['75%', '60%', '6', '3', '0', '6']);
  assert.deepEqual(metricsB.map(row => row.value), ['71,4%', '80%', '0', '0', '8', '4']);
  for (const invalid of [
    { expected: 2, received: 3, ingested: 1, assessed: 1, correct: 1 },
    { expected: 2, received: 2, ingested: 3, assessed: 1, correct: 1 },
    { expected: 2, received: 2, ingested: 1, assessed: 2, correct: 1 },
    { expected: 2, received: 2, ingested: 1, assessed: 1, correct: 2 },
    { expected: -1, received: 0, ingested: 0, assessed: 0, correct: 0 },
    { expected: 1.5, received: 0, ingested: 0, assessed: 0, correct: 0 },
  ]) assert.throws(() => calculateMeasures(invalid));
});

test('support never fills the diary and only taught unrecorded lessons get review drafts', () => {
  const a = workspace('diary');
  const b = workspace('diary', 'class-7b');
  assert.equal(a.actions.filter(action => action.kind === 'diary-draft').length, 1);
  assert.equal(b.actions.filter(action => action.kind === 'diary-draft').length, 0);
  const diary = a.actions.find(action => action.kind === 'diary-draft')!;
  assert.ok(diary.evidenceIds.some(id => id.includes('a-fraction-diary')));
  assert.ok(!diary.evidenceIds.some(id => id.includes('a-water-diary')));
  assert.ok(diary.content.includes('não preencher automaticamente'));
  assert.ok(a.widgets.some(widget => widget.title.includes('nunca preenche diário')));
});

test('tools accept strict bounded declarative types only and free-form plans cannot introduce facts', () => {
  const spec = defaultToolSpec('fraction-lab 40 minutos 3/4');
  assert.equal(spec.kind, 'fraction-lab');
  assert.equal(spec.numerator, 3);
  assert.equal(spec.denominator, 4);
  for (const change of [
    { kind: 'shell' }, { durationMinutes: '40' }, { durationMinutes: 121 },
    { stationCount: 1 }, { stationCount: 2.5 }, { numerator: 5, denominator: 4 },
    { denominator: 0 }, { title: '<script>bad</script>' }, { title: 'https://example.org' },
    { title: 'javascript alert' }, { title: 'SELECT dados' }, { code: 'run()' },
  ]) assert.equal(toolSpecSchema.safeParse({ ...spec, ...change }).success, false);
  assert.throws(() => defaultToolSpec('fraction-lab 2/0'));
  const result = buildWorkspace({
    classId: 'class-7a', mode: 'code', intent: 'tool', model: 'azure-openai',
    toolSpec: spec, plan: 'UNTRUSTED_FACT_123 execute an arbitrary script',
  });
  assert.equal(result.widgets[0]!.tool?.kind, 'fraction-lab');
  assert.ok(!JSON.stringify(result).includes('UNTRUSTED_FACT_123'));
});
