import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArtifacts } from './model.mjs';
import { buildArtifactsV2 } from './model-v2.mjs';

const dataset = JSON.parse(readFileSync(new URL('../ontology/dataset.json', import.meta.url), 'utf8'));
const options = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  lakehouseId: '22222222-2222-4222-8222-222222222222',
  sqlEndpoint: 'synthetic.datawarehouse.fabric.microsoft.com',
  sqlDatabase: 'synthetic_catalog',
};
const decode = result => new Map(result.ontologyDefinition.parts.map(part => [
  part.path, Buffer.from(part.payload, 'base64').toString('utf8'),
]));
const result = buildArtifactsV2(dataset, options);
const parts = decode(result);
const legacy = buildArtifacts(dataset, options.workspaceId, options.lakehouseId);

test('generation 2 contains only native TMDL and platform, with required namespace and model refs', () => {
  assert.equal(result.manifest.generation, 2);
  assert.equal(result.manifest.status, 'generated');
  assert.equal(result.manifest.label, 'TMDL native world');
  assert.equal(result.manifest.documentationVerifiedOn, '2026-09-29');
  assert.equal(result.ontologyDefinition.parts.length, 31);
  assert.equal(parts.size, 31);
  assert.equal(JSON.parse(parts.get('.platform')).metadata.type, 'Ontology');
  assert.equal(JSON.parse(parts.get('.platform')).config.version, '2.0');
  assert.equal(parts.get('database.tmdl'), 'database\n\tcompatibilityLevel: 1000000\n');
  assert.equal(parts.get('namespaces/default.tmdl'), 'namespace default\n\tlineageTag: default\n');
  assert.match(parts.get('model.tmdl'), /^ref namespace default$/m);
  for (const part of result.ontologyDefinition.parts) {
    assert.equal(part.payloadType, 'InlineBase64');
    assert.equal(Buffer.from(part.payload, 'base64').toString('base64'), part.payload);
    assert.ok(part.path === '.platform' || part.path.endsWith('.tmdl'));
    assert.doesNotMatch(parts.get(part.path), /sourceType|LakehouseTable|wind_|entityIdParts/);
  }
});

test('preserves 12 entities, 52 rows, 22 relations, names, metadata and the identical notebook', () => {
  assert.equal(result.manifest.entityCount, 12);
  assert.equal(result.manifest.rowCount, 52);
  assert.equal(result.manifest.relationshipCount, 22);
  assert.deepEqual(result.manifest.entities, legacy.manifest.entities);
  assert.deepEqual(result.manifest.relationships, legacy.manifest.relationships);
  assert.equal(result.manifest.sourceSha256, legacy.manifest.sourceSha256);
  assert.deepEqual(result.notebookDefinition, legacy.notebookDefinition);
});

test('all property bindings use real columns, documented singular keys and dbo DirectLake partitions', () => {
  const types = { String: 'string', BigInt: 'int64', Boolean: 'boolean', Double: 'double' };
  for (const entity of result.manifest.entities) {
    const table = parts.get(`tables/${entity.table}.tmdl`);
    const definition = parts.get(`entities/${entity.name}.tmdl`);
    assert.ok(parts.get('model.tmdl').includes(`ref entity ${entity.name}\n`));
    assert.ok(parts.get('model.tmdl').includes(`ref table ${entity.table}\n`));
    assert.ok(definition.startsWith(`entity ${entity.name}\n`));
    assert.ok(definition.includes(`\tbackingTable: ${entity.table}\n\tkeyProperty: id\n`));
    assert.equal((definition.match(/keyProperty:/g) ?? []).length, 1);
    assert.equal((table.match(/isKey: true/g) ?? []).length, 1);
    assert.match(table, /\tcolumn id\n\t\tdataType: string\n[\s\S]*?\t\tisKey: true\n\t\tisNullable: false/);
    assert.ok(table.includes(`\tpartition ${entity.table} = entity\n\t\tmode: directLake\n\t\tsource\n\t\t\tentityName: ${entity.table}\n\t\t\tschemaName: dbo\n\t\t\texpressionSource: DatabaseQuery\n`));
    assert.equal((definition.match(/^\tproperty /gm) ?? []).length, entity.properties.length);
    assert.equal((table.match(/^\tcolumn /gm) ?? []).length, entity.properties.length);
    for (const property of entity.properties) {
      assert.ok(table.includes(`\tcolumn ${property.name}\n\t\tdataType: ${types[property.valueType]}\n`));
      assert.ok(table.includes(`\t\tsourceColumn: ${property.name}\n`));
      assert.ok(definition.includes(`\tproperty ${property.name}\n\t\tdataType: ${types[property.valueType]}\n`));
      assert.ok(definition.includes(`\t\tbackingConfiguration\n\t\t\tvalueColumn: ${entity.table}.${property.name}\n`));
    }
    assert.doesNotMatch(definition, /annotation|keyProperties|propertyId|entityIdParts/);
  }
  assert.ok(parts.get('expressions.tmdl').includes(`Sql.Database("${options.sqlEndpoint}", "${options.sqlDatabase}")`));
  assert.ok(!parts.get('expressions.tmdl').includes(options.lakehouseId));
});

test('all 22 explicit ontology relationships bind FK-to-id TOM relations, without active cycles', () => {
  const tom = parts.get('relationships.tmdl');
  const ontology = parts.get('entityRelationships.tmdl');
  assert.equal((tom.match(/^relationship /gm) ?? []).length, 22);
  assert.equal((tom.match(/^\tisActive: false$/gm) ?? []).length, 22);
  assert.equal((ontology.match(/^entityRelationship /gm) ?? []).length, 22);
  for (const relation of result.manifest.relationships) {
    const from = result.manifest.entities.find(entity => entity.entity === relation.source);
    const to = result.manifest.entities.find(entity => entity.entity === relation.target);
    const name = `${from.name}_${relation.foreignKey}_To_${to.name}`;
    assert.ok(tom.includes(`relationship ${name}\n\tfromColumn: ${from.table}.${relation.foreignKey}\n\ttoColumn: ${to.table}.id\n\tfromCardinality: many\n\ttoCardinality: one\n`));
    assert.ok(ontology.includes(`\tfromEntity: ${from.name}\n\ttoEntity: ${to.name}\n\n\tbackingConfiguration\n\t\trelationship: ${name}\n`));
  }
  assert.ok(result.manifest.relationships.some(relation => relation.unmatchedRows > 0));
  assert.ok(result.manifest.relationships.some(relation => relation.missingKeyRows > 0));
});

test('primitive types match notebook including double widening, nested JSON strings and optional nulls', () => {
  const input = { teacher: [
    { id: 'first', ratio: 1, enabled: true, nested: [1], optional: null },
    { id: 'second', ratio: 1.5, enabled: false, nested: { a: 1 } },
  ] };
  const text = decode(buildArtifactsV2(input, options));
  for (const [name, type] of Object.entries({ id: 'string', ratio: 'double', enabled: 'boolean', nested: 'string', optional: 'string' })) {
    assert.ok(text.get('tables/horizonte_teacher.tmdl').includes(`column ${name}\n\t\tdataType: ${type}\n`));
    assert.ok(text.get('entities/Teacher.tmdl').includes(`property ${name}\n\t\tdataType: ${type}\n`));
  }
});

test('deterministic ordering, stable lineage and no input mutation', () => {
  const before = JSON.stringify(dataset);
  assert.deepEqual(buildArtifactsV2(dataset, options), result);
  const reordered = Object.fromEntries(Object.entries(dataset).reverse().map(([key, value]) => [
    key, Array.isArray(value) ? value.map(row => Object.fromEntries(Object.entries(row).reverse())) : value,
  ]));
  assert.deepEqual(buildArtifactsV2(reordered, options), result);
  assert.equal(JSON.stringify(dataset), before);
  const tags = [...parts.values()].flatMap(text => [...text.matchAll(/lineageTag: ([^\n]+)/g)].map(match => match[1]));
  assert.equal(tags.length, new Set(tags).size);
});

test('rejects malicious connection parameters, GUIDs, schema identifiers and invalid IDs', () => {
  for (const key of ['workspaceId', 'lakehouseId']) {
    for (const value of ['', 'not-guid', '00000000-0000-0000-0000-000000000000', `${options[key]}\nannotation x = y`]) {
      assert.throws(() => buildArtifactsV2(dataset, { ...options, [key]: value }), /GUID/);
    }
  }
  for (const value of ['', 'https://evil.example', 'host.fabric.microsoft.com.evil.example', 'user:secret@host.fabric.microsoft.com', 'x"\nexpression evil', 'x.fabric.microsoft.com;password=x']) {
    assert.throws(() => buildArtifactsV2(dataset, { ...options, sqlEndpoint: value }), /sqlEndpoint/);
  }
  for (const value of ['', 'db"\nentity Evil', '../escape', 'db;password=secret']) {
    assert.throws(() => buildArtifactsV2(dataset, { ...options, sqlDatabase: value }), /sqlDatabase/);
  }
  assert.throws(() => buildArtifactsV2(dataset), /sqlEndpoint/);
  assert.throws(() => buildArtifactsV2({ '../evil': [{ id: 'a' }] }, options), /name/);
  assert.throws(() => buildArtifactsV2({ teacher: [{ id: 'a', 'bad\ncolumn': 1 }] }, options), /name/);
  assert.throws(() => buildArtifactsV2({ teacher: [{ id: 'a\nentity Evil' }] }, options), /id/);
  assert.throws(() => buildArtifactsV2({ teacher: [{ id: 'a' }, { id: 'a' }] }, options), /id/);
  assert.throws(() => buildArtifactsV2({ 'a-1': [{ id: 'a' }], a1: [{ id: 'b' }] }, options), /colliding/);
  assert.throws(() => buildArtifactsV2({ teacher: [{ id: 'a', ID: 'b' }] }, options), /collision/);
  assert.throws(() => buildArtifactsV2({ teacher: [{ id: 'a', score: Infinity }] }, options), /finite/);
  const injection = `id' ; ../entity Evil`;
  const safe = decode(buildArtifactsV2({ teacher: [{ id: injection }] }, options));
  assert.ok(!safe.get('entities/Teacher.tmdl').includes(injection));
});

test('CLI help and invalid invocation do not generate or deploy anything', () => {
  const script = fileURLToPath(new URL('../scripts/fabric-generate-v2.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--sql-endpoint HOST --sql-database DATABASE/);
  const invalid = run([]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--workspace GUID/);
});
