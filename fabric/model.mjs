import { createHash } from 'node:crypto';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json';
const REFERENCES = [
  'https://learn.microsoft.com/en-us/rest/api/fabric/ontology/items/create-ontology',
  'https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/ontology-old-definition',
  'https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/notebook-definition',
];
const FOREIGN_KEYS = {
  classroom: { teacherId: 'teacher' },
  space: { classId: 'classroom', teacherId: 'teacher' },
  material: { classId: 'classroom', teacherId: 'teacher', curriculumId: 'curriculum' },
  lesson: { classId: 'classroom', spaceId: 'space' },
  curriculum: { classId: 'classroom', lessonId: 'lesson' },
  activity: { classId: 'classroom', curriculumId: 'curriculum' },
  evidence: { classId: 'classroom', activityId: 'activity' },
  intervention: { classId: 'classroom', evidenceId: 'evidence' },
  'diary-entry': { classId: 'classroom', lessonId: 'lesson' },
  'support-case': { classId: 'classroom', diaryId: 'diary-entry' },
  'writing-sample': { classId: 'classroom', activityId: 'activity' },
};

function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const json = value => JSON.stringify(canonical(value));
const pascal = name => name.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join('');
const part = (path, value) => ({
  // Fabric's polymorphic JSON reader requires sourceType before its other fields.
  path, payload: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), payloadType: 'InlineBase64',
});
function guid(seed) {
  const bytes = createHash('sha256').update(`horizonte:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function platform(type, displayName) {
  return { $schema: PLATFORM_SCHEMA, metadata: { type, displayName },
    config: { version: '2.0', logicalId: guid(`platform:${type}`) } };
}
function validateGuid(value, label) {
  if (typeof value !== 'string' || !GUID.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new TypeError(`${label} must be a nonzero GUID in canonical 8-4-4-4-12 form`);
  }
  return value.toLowerCase();
}
function columnType(values) {
  const kinds = new Set(values.filter(value => value != null).map(value => {
    if (typeof value === 'string' || typeof value === 'object') return 'String';
    if (typeof value === 'boolean') return 'Boolean';
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new TypeError('Unsafe integer');
      return Number.isInteger(value) ? 'BigInt' : 'Double';
    }
    throw new TypeError('Only finite JSON values are supported');
  }));
  if (!kinds.size) return 'String';
  if (kinds.size === 1) return [...kinds][0];
  if ([...kinds].every(kind => kind === 'BigInt' || kind === 'Double')) return 'Double';
  throw new TypeError('Incompatible primitive column types');
}

/**
 * Pure, offline generation of native generation-1 ontology and ipynb definition parts.
 * References verified 2026-09-28. POST {displayName, definition: ontologyDefinition}
 * to /v1/workspaces/{workspaceId}/ontologies; never omit definition (defaults to gen2).
 * Notebook definition includes format: "ipynb" because Fabric defaults to FabricGitSource.
 * Run notebook first in the attached, schema-enabled lakehouse (default schema dbo).
 * Managed tables are overwritten on rerun; no source rows are removed.
 */
export function buildArtifacts(dataset, workspaceId, lakehouseId) {
  workspaceId = validateGuid(workspaceId, 'workspaceId');
  lakehouseId = validateGuid(lakehouseId, 'lakehouseId');
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new TypeError('Expected dataset object');
  const names = Object.keys(dataset).filter(key => Array.isArray(dataset[key])).sort();
  if (!names.length) throw new TypeError('Dataset has no entity arrays');
  let nextId = 1n;
  const allocate = () => {
    if (nextId > 9223372036854775807n) throw new RangeError('ID overflow');
    return String(nextId++);
  };
  const entities = names.map(entity => {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entity)) throw new TypeError('Unsafe entity name');
    const rows = dataset[entity];
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) {
        throw new TypeError(`Invalid or duplicate id in ${entity}`);
      }
      ids.add(row.id);
    }
    const entityTypeId = allocate();
    const columns = [...new Set(['id', ...rows.flatMap(row => Object.keys(row))])].sort();
    const properties = columns.map(name => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) throw new TypeError('Unsafe column name');
      return { id: allocate(), name, valueType: columnType(rows.map(row => row[name])) };
    });
    if (new Set(columns.map(name => name.toLowerCase())).size !== columns.length) throw new TypeError('Case-insensitive column collision');
    return { entity, entityTypeId, name: pascal(entity), table: `horizonte_${entity.replaceAll('-', '_')}`,
      rowCount: rows.length, idPropertyId: properties.find(p => p.name === 'id').id, properties };
  });
  const byName = new Map(entities.map(entity => [entity.entity, entity]));
  const tableProperties = entity => ({
    sourceType: 'LakehouseTable', workspaceId, itemId: lakehouseId,
    sourceTableName: entity.table, sourceSchema: 'dbo',
  });
  const parts = [part('definition.json', {}), part('.platform', platform('Ontology', 'EducationOntology'))];
  for (const entity of entities) {
    const { entityTypeId: id, name, idPropertyId, properties } = entity;
    parts.push(part(`EntityTypes/${id}/definition.json`, {
      id, namespace: 'usertypes', name, namespaceType: 'Custom', visibility: 'Visible',
      entityIdParts: [idPropertyId], displayNamePropertyId: idPropertyId, properties,
    }));
    const bindingId = guid(`binding:${entity.entity}`);
    parts.push(part(`EntityTypes/${id}/DataBindings/${bindingId}.json`, {
      id: bindingId, dataBindingConfiguration: {
        dataBindingType: 'NonTimeSeries',
        propertyBindings: properties.map(property => ({ sourceColumnName: property.name, targetPropertyId: property.id })),
        sourceTableProperties: tableProperties(entity),
      },
    }));
  }
  const relationships = [];
  for (const source of entities) {
    for (const [fk, parent] of Object.entries(FOREIGN_KEYS[source.entity] ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!source.properties.some(property => property.name === fk)) continue;
      const target = byName.get(parent);
      if (!target) throw new TypeError(`Missing target entity ${parent}`);
      if (source.properties.find(property => property.name === fk).valueType !== 'String') throw new TypeError(`Foreign key ${fk} must be String`);
      const id = allocate();
      const contextId = guid(`relationship:${source.entity}:${fk}:${parent}`);
      parts.push(part(`RelationshipTypes/${id}/definition.json`, {
        namespace: 'usertypes', id, name: `${source.name}${pascal(fk)}To${target.name}`,
        namespaceType: 'Custom', source: { entityTypeId: source.entityTypeId }, target: { entityTypeId: target.entityTypeId },
      }));
      parts.push(part(`RelationshipTypes/${id}/Contextualizations/${contextId}.json`, {
        id: contextId, dataBindingTable: tableProperties(source),
        sourceKeyRefBindings: [{ sourceColumnName: 'id', targetPropertyId: source.idPropertyId }],
        targetKeyRefBindings: [{ sourceColumnName: fk, targetPropertyId: target.idPropertyId }],
      }));
      const targetIds = new Set(dataset[parent].map(row => row.id));
      const rows = dataset[source.entity];
      const missingKeyRows = rows.filter(row => row[fk] == null).length;
      const matchedRows = rows.filter(row => targetIds.has(row[fk])).length;
      relationships.push({ id, source: source.entity, target: parent, foreignKey: fk, table: source.table,
        totalRows: rows.length, matchedRows, missingKeyRows, unmatchedRows: rows.length - matchedRows - missingKeyRows });
    }
  }
  const encodedDataset = Buffer.from(json(dataset)).toString('base64');
  const encodedSchemas = Buffer.from(json(entities)).toString('base64');
  const setup = [
    'import base64, json',
    'from pyspark.sql.types import StructType, StructField, StringType, LongType, BooleanType, DoubleType',
    `dataset = json.loads(base64.b64decode("${encodedDataset}").decode("utf-8"))`,
    `entities = json.loads(base64.b64decode("${encodedSchemas}").decode("utf-8"))`,
    'types = {"String": StringType, "BigInt": LongType, "Boolean": BooleanType, "Double": DoubleType}',
    'def normalize(value, kind):',
    '    if value is None: return None',
    '    if isinstance(value, (list, dict)): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))',
    '    if kind == "Double": return float(value)',
    '    return value',
  ];
  const codeCell = (id, lines) => ({
    id, cell_type: 'code', execution_count: null, outputs: [],
    metadata: { language: 'python', language_group: 'synapse_pyspark' },
    source: lines.map(line => `${line}\n`),
  });
  const notebook = {
    nbformat: 4, nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'synapse_pyspark', display_name: 'Synapse PySpark', language: 'python' },
      language_info: { name: 'python' },
      dependencies: { lakehouse: { default_lakehouse: lakehouseId, default_lakehouse_workspace_id: workspaceId } },
    },
    cells: [
      codeCell('embedded-data', setup),
      ...entities.map((entity, index) => codeCell(`load-${entity.entity}`, [
        `entity = entities[${index}]`,
        'schema = StructType([StructField(p["name"], types[p["valueType"]](), True) for p in entity["properties"]])',
        'rows = [tuple(normalize(row.get(p["name"]), p["valueType"]) for p in entity["properties"]) for row in dataset[entity["entity"]]]',
        `spark.createDataFrame(rows, schema).write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable('${entity.table}')`,
      ])),
    ],
  };
  return {
    ontologyDefinition: { parts },
    notebookDefinition: { format: 'ipynb', parts: [
      part('notebook-content.ipynb', notebook), part('.platform', platform('Notebook', 'HorizonteEducationLoad')),
    ] },
    manifest: {
      generation: 1, source: 'ontology\\dataset.json', sourceSha256: createHash('sha256').update(json(dataset)).digest('hex'),
      documentationVerifiedOn: '2026-09-28', references: REFERENCES, workspaceId, lakehouseId,
      entityCount: entities.length, rowCount: entities.reduce((sum, entity) => sum + entity.rowCount, 0),
      relationshipCount: relationships.length, entities, relationships,
      instructions: [
        'Create and run HorizonteEducationLoad with notebookDefinition (format ipynb) before creating the ontology.',
        'Use a schema-enabled attached lakehouse with dbo as the default schema. Reruns overwrite only horizonte_* managed Delta tables.',
        'POST {displayName:"EducationOntology",definition:ontologyDefinition} to /v1/workspaces/{workspaceId}/ontologies.',
        'Explicit JSON definition parts select generation 1. Omitting definition creates generation 2; do not mix TMDL parts.',
        'All source rows are preserved. Contextualizations bind original child tables; missing/nonexistent parent endpoints produce no edge, not filtered entity rows.',
        'Manifest matched/unmatched/missing counts describe input keys, not verified service ingestion results.',
        'Arrays and objects become JSON String columns; missing values are null; compatible integers/floats widen to Double.',
        'IDs use deterministic sorted entity/property/relationship indexes; schema changes may reassign IDs. GUIDs use fixed SHA-256-derived UUIDv8 seeds.',
        'Only the supplied synthetic dataset is embedded. No credentials, external tables, column mapping, network calls, or deployment are performed.',
      ],
    },
  };
}
