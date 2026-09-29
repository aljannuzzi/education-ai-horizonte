import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertModelSource, buildReportModel, buildReportDefinition, measures } from './report-model.mjs';

const dataset = JSON.parse(await readFile(new URL('../ontology/dataset.json', import.meta.url), 'utf8'));
const options = { workspaceId: '11111111-1111-4111-8111-111111111111', lakehouseId: '22222222-2222-4222-8222-222222222222', sqlEndpoint: 'example.fabric.microsoft.com', sqlDatabase: 'SyntheticDatabase' };
const decode = entry => Buffer.from(entry.payload, 'base64').toString('utf8');
test('report model deterministic Direct Lake with actual source columns and no ontology extensions', () => {
  const a = buildReportModel(dataset, options);
  assert.deepEqual(a, buildReportModel(dataset, options));
  assert.equal(a.entities.length, 11);
  const text = a.definition.parts.map(decode).join('\n');
  assert.match(text, /compatibilityLevel: 1604/);
  assert.doesNotMatch(text, /backingTable:|ref entity|namespace default|horizonte_material|teacher-other|a-foreign-print/);
  for (const entity of a.entities) {
    const table = decode(a.definition.parts.find(p => p.path === `definition/tables/${entity.table}.tmdl`));
    assert.match(table, /mode: directLake/);
    assert.ok(table.includes(`entityName: ${entity.table}`));
    for (const property of entity.properties) assert.ok(table.includes(`sourceColumn: ${property.name}`));
  }
  for (const [name, expression] of measures) assert.ok(text.includes(`measure ${name} = ${expression}`));
  assert.match(text, /No RLS configured/);
});
test('measures separate planning, calendar flags, actual missing diary and assessed denominator', () => {
  const map = Object.fromEntries(measures.map(([name, expression]) => [name, expression]));
  assert.match(map.PendenciasDiario, /"taught"/);
  assert.match(map.DenominadorAvaliacao, /\[assessed\].*"assessment"/);
  assert.equal(map.TaxaAcertoAvaliados, 'DIVIDE([AcertosAvaliacao], [DenominadorAvaliacao])');
  assert.equal(dataset.lesson.filter(row => row.status === 'planned').length, 2);
  assert.equal(dataset['diary-entry'].filter(row => !row.recorded && dataset.lesson.find(l => l.id === row.lessonId)?.status === 'taught').length, 1);
  assert.equal(dataset.evidence.filter(row => row.type === 'assessment').reduce((n, row) => n + row.assessed, 0), 35);
});
test('PBIR connects only to provided model and contains one page and eight visuals', () => {
  const definition = buildReportDefinition(options.workspaceId);
  const json = definition.parts.map(p => [p.path, JSON.parse(decode(p))]);
  assert.equal(json.filter(([p]) => p.endsWith('/page.json')).length, 1);
  assert.equal(json.filter(([p]) => p.endsWith('/visual.json')).length, 8);
  assert.equal(json[0][1].datasetReference.byConnection.connectionString, `semanticmodelid=${options.workspaceId}`);
  assert.deepEqual(definition, buildReportDefinition(options.workspaceId));
  assert.throws(() => buildReportDefinition('not-a-guid'));
  assert.throws(() => buildReportModel(dataset, { ...options, sqlEndpoint: 'bad";code' }));
});

test('reusing a model requires the exact requested SQL endpoint and catalog', () => {
  const parts = buildReportModel(dataset, options).definition.parts;
  assert.doesNotThrow(() => assertModelSource(parts, options.sqlEndpoint, options.sqlDatabase));
  assert.doesNotThrow(() => assertModelSource(parts, options.sqlEndpoint.toUpperCase(), options.sqlDatabase));
  assert.throws(() => assertModelSource(parts, 'another.fabric.microsoft.com', options.sqlDatabase), /SourceMismatch/);
  assert.throws(() => assertModelSource(parts, options.sqlEndpoint, 'AnotherCatalog'), /SourceMismatch/);
  assert.throws(() => assertModelSource(parts.filter(p => !p.path.endsWith('expressions.tmdl')), options.sqlEndpoint, options.sqlDatabase), /SourceMismatch/);
  assert.throws(() => assertModelSource([...parts, parts.find(p => p.path.endsWith('expressions.tmdl'))], options.sqlEndpoint, options.sqlDatabase), /SourceMismatch/);
});
