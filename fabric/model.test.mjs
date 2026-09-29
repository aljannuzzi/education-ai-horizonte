import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildArtifacts } from './model.mjs';

const dataset = JSON.parse(await readFile(new URL('../ontology/dataset.json', import.meta.url), 'utf8'));
const workspace = '12345678-1234-4234-8234-123456789abc';
const lakehouse = 'abcdef12-1234-4234-8234-123456789abc';
const artifacts = buildArtifacts(dataset, workspace, lakehouse);
const decode = part => JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8'));
const definitions = new Map(artifacts.ontologyDefinition.parts.map(part => [part.path, decode(part)]));
const notebook = decode(artifacts.notebookDefinition.parts[0]);
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('native generation 1 parts, platform schema and positive unique 64-bit IDs', () => {
  assert.deepEqual(definitions.get('definition.json'), {});
  const ids = [];
  for (const entity of artifacts.manifest.entities) {
    const definition = definitions.get(`EntityTypes/${entity.entityTypeId}/definition.json`);
    assert.equal(definition.namespace, 'usertypes');
    assert.equal(definition.namespaceType, 'Custom');
    assert.equal(definition.visibility, 'Visible');
    assert.match(definition.name, /^[A-Z][A-Za-z0-9]*$/);
    assert.deepEqual(definition.entityIdParts, [entity.idPropertyId]);
    assert.equal(definition.displayNamePropertyId, entity.idPropertyId);
    ids.push(definition.id, ...definition.properties.map(p => p.id));
  }
  ids.push(...artifacts.manifest.relationships.map(r => r.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[1-9][0-9]*$/);
    assert.ok(BigInt(id) <= 9223372036854775807n);
  }
  for (const [definition, type, name] of [
    [artifacts.ontologyDefinition, 'Ontology', 'EducationOntology'],
    [artifacts.notebookDefinition, 'Notebook', 'HorizonteEducationLoad'],
  ]) {
    const platform = decode(definition.parts.find(p => p.path === '.platform'));
    assert.equal(platform.$schema, 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json');
    assert.deepEqual(platform.metadata, { type, displayName: name });
    assert.equal(platform.config.version, '2.0');
    assert.match(platform.config.logicalId, guidPattern);
    for (const p of definition.parts) assert.equal(p.payloadType, 'InlineBase64');
  }
  assert.equal(definitions.size, artifacts.ontologyDefinition.parts.length);
  assert.ok(![...definitions.keys()].some(path => /tmdl|graph/i.test(path)));
});

test('all 12 arrays have exact native bindings, types and matching managed tables', () => {
  assert.equal(artifacts.manifest.entityCount, 12);
  assert.deepEqual(artifacts.manifest.entities.map(e => e.entity), Object.keys(dataset).filter(k => Array.isArray(dataset[k])).sort());
  for (const entity of artifacts.manifest.entities) {
    const entries = [...definitions].filter(([path]) => path.startsWith(`EntityTypes/${entity.entityTypeId}/DataBindings/`));
    assert.equal(entries.length, 1);
    const [path, binding] = entries[0];
    assert.match(binding.id, guidPattern);
    assert.ok(path.endsWith(`${binding.id}.json`));
    assert.deepEqual(binding.dataBindingConfiguration, {
      dataBindingType: 'NonTimeSeries',
      propertyBindings: entity.properties.map(p => ({ sourceColumnName: p.name, targetPropertyId: p.id })),
      sourceTableProperties: { sourceType: 'LakehouseTable', workspaceId: workspace, itemId: lakehouse,
        sourceTableName: entity.table, sourceSchema: 'dbo' },
    });

    assert.equal(entity.rowCount, dataset[entity.entity].length);
    for (const p of entity.properties) {
      const values = dataset[entity.entity].map(row => row[p.name]).filter(v => v != null);
      const expected = values.every(v => typeof v === 'boolean') ? 'Boolean'
        : values.every(v => typeof v === 'number') ? 'BigInt' : 'String';
      assert.equal(p.valueType, expected);
    }
    assert.ok(notebook.cells.some(cell => cell.source.join('').includes(`saveAsTable('${entity.table}')`)));
  }
});

test('native JSON type discriminators precede all table-binding fields', () => {
  for (const part of artifacts.ontologyDefinition.parts) {
    const text = Buffer.from(part.payload, 'base64').toString('utf8');
    if (part.path.includes('/DataBindings/')) {
      assert.match(text, /"sourceTableProperties":\{"sourceType":"LakehouseTable",/);
    }
    if (part.path.includes('/Contextualizations/')) {
      assert.match(text, /"dataBindingTable":\{"sourceType":"LakehouseTable",/);
    }
  }
});

test('relationships use actual child foreign keys and parent ID properties', () => {
  const expected = {
    classroom: { teacherId: 'teacher' }, space: { classId: 'classroom', teacherId: 'teacher' },
    material: { classId: 'classroom', teacherId: 'teacher', curriculumId: 'curriculum' },
    lesson: { classId: 'classroom', spaceId: 'space' }, curriculum: { classId: 'classroom', lessonId: 'lesson' },
    activity: { classId: 'classroom', curriculumId: 'curriculum' },
    evidence: { classId: 'classroom', activityId: 'activity' },
    intervention: { classId: 'classroom', evidenceId: 'evidence' },
    'diary-entry': { classId: 'classroom', lessonId: 'lesson' },
    'support-case': { classId: 'classroom', diaryId: 'diary-entry' },
    'writing-sample': { classId: 'classroom', activityId: 'activity' },
  };
  assert.equal(artifacts.manifest.relationshipCount, Object.values(expected).reduce((sum, keys) => sum + Object.keys(keys).length, 0));
  for (const relationship of artifacts.manifest.relationships) {
    assert.equal(expected[relationship.source][relationship.foreignKey], relationship.target);
    const source = artifacts.manifest.entities.find(e => e.entity === relationship.source);
    const target = artifacts.manifest.entities.find(e => e.entity === relationship.target);
    const definition = definitions.get(`RelationshipTypes/${relationship.id}/definition.json`);
    assert.equal(definition.namespace, 'usertypes');
    assert.equal(definition.namespaceType, 'Custom');
    assert.deepEqual(definition.source, { entityTypeId: source.entityTypeId });
    assert.deepEqual(definition.target, { entityTypeId: target.entityTypeId });
    const contexts = [...definitions].filter(([path]) => path.startsWith(`RelationshipTypes/${relationship.id}/Contextualizations/`));
    assert.equal(contexts.length, 1);
    const [path, context] = contexts[0];
    assert.match(context.id, guidPattern);
    assert.ok(path.endsWith(`${context.id}.json`));
    assert.deepEqual(context.dataBindingTable, { sourceType: 'LakehouseTable', workspaceId: workspace,
      itemId: lakehouse, sourceTableName: source.table, sourceSchema: 'dbo' });
    assert.deepEqual(context.sourceKeyRefBindings, [{ sourceColumnName: 'id', targetPropertyId: source.idPropertyId }]);
    assert.deepEqual(context.targetKeyRefBindings, [{ sourceColumnName: relationship.foreignKey, targetPropertyId: target.idPropertyId }]);
    assert.equal(relationship.totalRows, relationship.matchedRows + relationship.unmatchedRows + relationship.missingKeyRows);
  }
  const unlinked = artifacts.manifest.relationships.filter(r => r.unmatchedRows);
  assert.deepEqual(unlinked.map(r => [r.source, r.foreignKey, r.unmatchedRows]), [
    ['material', 'curriculumId', 1], ['material', 'teacherId', 1],
  ]);
  assert.equal(artifacts.manifest.relationships.find(r => r.source === 'lesson' && r.foreignKey === 'spaceId').missingKeyRows, 4);
});

test('ipynb embeds only supplied JSON, attaches lakehouse and normalizes nullable typed rows', () => {
  assert.equal(artifacts.notebookDefinition.format, 'ipynb');
  assert.equal(artifacts.notebookDefinition.parts[0].path, 'notebook-content.ipynb');
  assert.equal(notebook.nbformat, 4);
  assert.deepEqual(notebook.metadata.dependencies.lakehouse, {
    default_lakehouse: lakehouse, default_lakehouse_workspace_id: workspace,
  });
  const code = notebook.cells.flatMap(cell => cell.source).join('');
  const embedded = code.match(/dataset = json.loads\(base64.b64decode\("([^"]+)"\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(embedded, 'base64').toString('utf8')), dataset);
  assert.match(code, /row.get\(p\["name"\]\)/);
  assert.match(code, /isinstance\(value, \(list, dict\)\)/);
  assert.match(code, /json.dumps\(value/);
  assert.match(code, /if value is None: return None/);
  assert.match(code, /"BigInt": LongType/);
  assert.match(code, /"Boolean": BooleanType/);
  assert.match(code, /"Double": DoubleType/);
  assert.doesNotMatch(code, /columnMapping|https?:|abfss:|spark\.read|os\.environ|requests|open\(|LOCATION|save\(/i);
  assert.equal(notebook.cells.length, 13);
});

test('double widening, nested JSON Strings, null-only and missing optional properties', () => {
  const result = buildArtifacts({ teacher: [
    { id: 'a', score: 1, active: true, details: { text: 'quoted "\n' }, tags: [], missing: null },
    { id: 'b', score: 1.25, active: false, details: null },
  ] }, workspace, lakehouse);
  assert.deepEqual(Object.fromEntries(result.manifest.entities[0].properties.map(p => [p.name, p.valueType])), {
    active: 'Boolean', details: 'String', id: 'String', missing: 'String', score: 'Double', tags: 'String',
  });
  assert.throws(() => buildArtifacts({ teacher: [{ id: 'a', value: true }, { id: 'b', value: 'false' }] }, workspace, lakehouse), /Incompatible/);
  assert.throws(() => buildArtifacts({ teacher: [{ id: 'a', value: Number.MAX_SAFE_INTEGER + 1 }] }, workspace, lakehouse), /Unsafe integer/);
});

test('strict GUID validation, determinism, no input mutation and safe identifiers', () => {
  const before = JSON.stringify(dataset);
  assert.deepEqual(buildArtifacts(dataset, workspace, lakehouse), artifacts);
  assert.deepEqual(buildArtifacts(JSON.parse(before), workspace.toUpperCase(), lakehouse.toUpperCase()), artifacts);
  const reversed = Object.fromEntries(Object.entries(dataset).reverse().map(([key, value]) => [
    key, Array.isArray(value) ? value.map(row => Object.fromEntries(Object.entries(row).reverse())) : value,
  ]));
  assert.deepEqual(buildArtifacts(reversed, workspace, lakehouse), artifacts);
  assert.equal(JSON.stringify(dataset), before);
  for (const bad of ['', null, 123, ` ${workspace}`, `${workspace}\n`, `{${workspace}}`, workspace.replaceAll('-', ''),
    '00000000-0000-0000-0000-000000000000', '../outside', workspace.replace('1', 'g')]) {
    assert.throws(() => buildArtifacts(dataset, bad, lakehouse), /GUID/);
    assert.throws(() => buildArtifacts(dataset, workspace, bad), /GUID/);
  }
  assert.throws(() => buildArtifacts({ '../escape': [{ id: 'a' }] }, workspace, lakehouse), /Unsafe entity/);
  assert.throws(() => buildArtifacts({ teacher: [{ id: 'a', 'bad col': true }] }, workspace, lakehouse), /Unsafe column/);
  assert.throws(() => buildArtifacts({ teacher: [{ id: 'a' }, { id: 'a' }] }, workspace, lakehouse), /duplicate id/);
  assert.equal(artifacts.manifest.source, 'ontology\\dataset.json');
  assert.match(artifacts.manifest.sourceSha256, /^[0-9a-f]{64}$/);
});
