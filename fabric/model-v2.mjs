import { createHash } from 'node:crypto';
import { buildArtifacts } from './model.mjs';

const TYPES = { String: 'string', BigInt: 'int64', Boolean: 'boolean', Double: 'double' };
const DOCUMENTATION = 'https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/ontology-definition';
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
const part = (path, text) => ({
  path, payload: Buffer.from(text, 'utf8').toString('base64'), payloadType: 'InlineBase64',
});
function lineage(seed) {
  const hex = createHash('sha256').update(`horizonte:tmdl-v2:${seed}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Offline TMDL native generation 2, documented 2026-09-29.
 * sqlEndpoint is the SQL analytics endpoint hostname, NOT a connection string.
 * sqlDatabase is its actual database/catalog name (not an inferred lakehouse item ID).
 * Reuses generation 1 metadata and the identical schema-enabled dbo Delta notebook.
 * Returns generated definitions only; no TOM parser, Fabric validation or activation.
 */
export function buildArtifactsV2(dataset, { workspaceId, lakehouseId, sqlEndpoint, sqlDatabase } = {}) {
  if (typeof sqlEndpoint !== 'string' || sqlEndpoint.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+fabric\.microsoft\.com$/i.test(sqlEndpoint)) {
    throw new TypeError('sqlEndpoint must be a Fabric SQL analytics endpoint hostname, without credentials, URL or port');
  }
  if (typeof sqlDatabase !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sqlDatabase)) {
    throw new TypeError('sqlDatabase must be the SQL endpoint database name (1-128 letters, digits, underscores or hyphens)');
  }
  const legacy = buildArtifacts(dataset, workspaceId, lakehouseId);
  const { entities, relationships } = legacy.manifest;
  const names = new Set();
  const tables = new Set();
  for (const entity of entities) {
    if (!identifier(entity.name) || !identifier(entity.table) ||
        names.has(entity.name.toLowerCase()) || tables.has(entity.table.toLowerCase())) {
      throw new TypeError('Unsafe or colliding entity/table name');
    }
    names.add(entity.name.toLowerCase());
    tables.add(entity.table.toLowerCase());
    for (const property of entity.properties) {
      if (!identifier(property.name) || !Object.hasOwn(TYPES, property.valueType)) {
        throw new TypeError('Unsafe property name or unsupported type');
      }
    }
    // Row IDs are values, never identifiers or TMDL code. No value is interpolated.
    if (dataset[entity.entity].some(row => !row.id.trim() || /[\u0000-\u001f\u007f]/.test(row.id))) {
      throw new TypeError('Invalid id: empty or control characters');
    }
  }
  const byName = new Map(entities.map(entity => [entity.entity, entity]));
  const parts = [
    legacy.ontologyDefinition.parts.find(entry => entry.path === '.platform'),
    part('database.tmdl', 'database\n\tcompatibilityLevel: 1000000\n'),
    part('model.tmdl', [
      'model Model', '',
      ...entities.map(entity => `ref table ${entity.table}`), '',
      ...entities.map(entity => `ref entity ${entity.name}`), '',
      'ref namespace default', '',
    ].join('\n')),
    part('namespaces/default.tmdl', 'namespace default\n\tlineageTag: default\n'),
    part('expressions.tmdl', [
      'expression DatabaseQuery =',
      '\t\tlet',
      `\t\t    database = Sql.Database("${sqlEndpoint.toLowerCase()}", "${sqlDatabase}")`,
      '\t\tin',
      '\t\t    database',
      `\tlineageTag: ${lineage('DatabaseQuery')}`, '',
    ].join('\n')),
  ];
  for (const entity of entities) {
    const table = [
      `table ${entity.table}`,
      `\tlineageTag: ${lineage(`table:${entity.table}`)}`, '',
    ];
    const definition = [
      `entity ${entity.name}`,
      `\tlineageTag: ${lineage(`entity:${entity.name}`)}`,
      `\tbackingTable: ${entity.table}`,
      // Official singular EntityType.keyProperty, not an invented key annotation.
      '\tkeyProperty: id', '',
    ];
    for (const property of entity.properties) {
      const type = TYPES[property.valueType];
      table.push(
        `\tcolumn ${property.name}`, `\t\tdataType: ${type}`,
        `\t\tlineageTag: ${lineage(`column:${entity.table}:${property.name}`)}`,
        `\t\tsourceColumn: ${property.name}`,
        ...(property.name === 'id' ? ['\t\tisKey: true', '\t\tisNullable: false'] : []),
        '\t\tsummarizeBy: none', '',
      );
      definition.push(
        `\tproperty ${property.name}`, `\t\tdataType: ${type}`,
        `\t\tlineageTag: ${lineage(`property:${entity.name}:${property.name}`)}`, '',
        '\t\tbackingConfiguration', `\t\t\tvalueColumn: ${entity.table}.${property.name}`, '',
      );
    }
    table.push(
      `\tpartition ${entity.table} = entity`, '\t\tmode: directLake', '\t\tsource',
      `\t\t\tentityName: ${entity.table}`, '\t\t\tschemaName: dbo',
      '\t\t\texpressionSource: DatabaseQuery', '',
    );
    parts.push(part(`tables/${entity.table}.tmdl`, table.join('\n')));
    parts.push(part(`entities/${entity.name}.tmdl`, definition.join('\n')));
  }
  const tom = [];
  const ontology = [];
  for (const relation of relationships) {
    const from = byName.get(relation.source);
    const to = byName.get(relation.target);
    const name = `${from.name}_${relation.foreignKey}_To_${to.name}`;
    tom.push(
      `relationship ${name}`, `\tfromColumn: ${from.table}.${relation.foreignKey}`,
      `\ttoColumn: ${to.table}.id`, '\tfromCardinality: many', '\ttoCardinality: one',
      '\tcrossFilteringBehavior: oneDirection',
      // Preserve all graph bindings without introducing active semantic filter cycles.
      '\tisActive: false', '',
    );
    ontology.push(
      `entityRelationship ${name}`, `\tlineageTag: ${lineage(`relationship:${name}`)}`,
      `\tfromEntity: ${from.name}`, `\ttoEntity: ${to.name}`, '',
      '\tbackingConfiguration', `\t\trelationship: ${name}`, '',
    );
  }
  parts.push(part('relationships.tmdl', tom.join('\n')));
  parts.push(part('entityRelationships.tmdl', ontology.join('\n')));
  return {
    ontologyDefinition: { parts },
    notebookDefinition: legacy.notebookDefinition,
    manifest: {
      ...legacy.manifest,
      generation: 2,
      label: 'TMDL native world',
      status: 'generated',
      format: 'TMDL',
      documentationVerifiedOn: '2026-09-29',
      references: [DOCUMENTATION],
      sqlEndpoint: sqlEndpoint.toLowerCase(),
      sqlDatabase,
      schema: 'dbo',
      semanticRelationshipPolicy: 'all-inactive',
      instructions: [
        'Generated offline, not parsed by TOM or executed/validated by Fabric or the graph wizard.',
        'Use the existing loaded dbo.horizonte_* Delta tables; notebookDefinition is unchanged from generation 1.',
        'sqlEndpoint and sqlDatabase must identify that lakehouse SQL analytics endpoint; no catalog ID is inferred.',
        'Submit ontologyDefinition.parts as InlineBase64 TMDL to the native Ontology item; do not mix generation-1 JSON parts.',
        'Entity keyProperty: id and backing column isKey: true declare string identity; no key annotations are invented.',
        'All TOM relationships are inactive to avoid ambiguous filter paths; all explicit entityRelationship bindings remain.',
        'Input matched/unmatched/missing counts do not certify ingestion; missing parents do not remove entity rows.',
        'Activation and graph-wizard verification belong to the caller. Link the native Data Agent to the native Ontology item, not a prompt fallback.',
      ],
    },
  };
}
