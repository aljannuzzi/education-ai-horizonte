import { buildArtifactsV2 } from './model-v2.mjs';

export const ownershipMarker = 'education-ai-horizonte teacher-report synthetic-only v1';
export const modelName = 'HorizonteProfessorModel';
export const reportName = 'Horizonte Professor';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const part = (path, value) => ({
  path, payloadType: 'InlineBase64',
  payload: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64'),
});
const schema = (kind, version) => `https://developer.microsoft.com/json-schemas/fabric/item/report/definition/${kind}/${version}/schema.json`;
export const measures = [
  ['Turmas', 'DISTINCTCOUNT(horizonte_classroom[id])', 'Turmas / distinct classes; not a student count.'],
  ['AulasPlanejadas', 'CALCULATE(COUNTROWS(horizonte_lesson), horizonte_lesson[status] = "planned")', 'Aulas planejadas / planned lessons; not lessons taught.'],
  ['EspacosIndisponiveis', 'CALCULATE(COUNTROWS(horizonte_space), horizonte_space[status] = "unavailable")', 'Espacos indisponiveis / unavailable spaces; never recommend access.'],
  ['PendenciasCalendario', 'CALCULATE(COUNTROWS(horizonte_diary_entry), horizonte_diary_entry[calendarPending] = TRUE())', 'Calendar flags include future planned lessons; not proof of missing taught lessons.'],
  ['PendenciasDiario', 'COUNTROWS(FILTER(horizonte_diary_entry, horizonte_diary_entry[recorded] = FALSE() && LOOKUPVALUE(horizonte_lesson[status], horizonte_lesson[id], horizonte_diary_entry[lessonId]) = "taught"))', 'Aulas ministradas sem registro / taught lessons not recorded; excludes future lessons.'],
  ['RegistrosEvidencia', 'COUNTROWS(horizonte_evidence)', 'Evidence rows, not students or learning outcomes.'],
  ...['expected', 'received', 'ingested', 'assessed'].map((field, i) => [
    ['RespostasEsperadas', 'RespostasRecebidas', 'RespostasIntegradas', 'RespostasAvaliadas'][i],
    `SUM(horizonte_evidence[${field}])`,
    `Total ${field} response instances across activities; not distinct students and not learning attainment.`,
  ]),
  ['AcertosAvaliacao', 'CALCULATE(SUM(horizonte_evidence[correct]), horizonte_evidence[type] = "assessment")', 'Correct answers in assessment evidence only; excludes writing coverage.'],
  ['DenominadorAvaliacao', 'CALCULATE(SUM(horizonte_evidence[assessed]), horizonte_evidence[type] = "assessment")', 'Assessed answers in assessment evidence only; denominator for correctness, not whole-class mastery.'],
  ['TaxaAcertoAvaliados', 'DIVIDE([AcertosAvaliacao], [DenominadorAvaliacao])', 'Correct / assessed assessment answers; blank without assessed evidence. Never infer learning from activity or coverage.'],
];

export function assertModelSource(parts, sqlEndpoint, sqlDatabase) {
  if (!Array.isArray(parts) || typeof sqlEndpoint !== 'string' || typeof sqlDatabase !== 'string') {
    throw new Error('SemanticModelSourceMismatch');
  }
  const expressions = parts.filter(entry => entry.path === 'definition/expressions.tmdl');
  if (expressions.length !== 1 || typeof expressions[0].payload !== 'string') {
    throw new Error('SemanticModelSourceMismatch');
  }
  const text = Buffer.from(expressions[0].payload, 'base64').toString('utf8');
  const sources = [...text.matchAll(/\bSql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)];
  if (sources.length !== 1 || !/\bexpression DatabaseQuery\s*=/.test(text)
    || sources[0][1].toLowerCase() !== sqlEndpoint.toLowerCase()
    || sources[0][2] !== sqlDatabase) {
    throw new Error('SemanticModelSourceMismatch');
  }
}

// Official contracts: Microsoft Learn Fabric item-management/definitions/{semantic-model,report}-definition.
export function buildReportModel(dataset, options) {
  const source = buildArtifactsV2(dataset, options);
  // Omit the entire material binding: hiding a column or filtering a visual is not security.
  const entities = source.manifest.entities.filter(entity => entity.entity !== 'material');
  const keep = new Set(entities.map(entity => entity.table));
  const parts = [
    part('definition.pbism', { version: '4.0', settings: {} }),
    part('definition/database.tmdl', 'database\n\tcompatibilityLevel: 1604\n'),
    part('definition/model.tmdl', [
      '/// Synthetic school operations / operacoes escolares sinteticas. No RLS configured; workspace permissions apply.',
      '/// Material table excluded. Activity, collection, ingestion and learning are distinct concepts.',
      'model Model', '\tculture: pt-BR', '\tdefaultPowerBIDataSourceVersion: powerBI_V3',
      '\tsourceQueryCulture: en-US', '', ...entities.map(e => `ref table ${e.table}`), '',
    ].join('\n')),
  ];
  for (const entry of source.ontologyDefinition.parts) {
    if (entry.path === 'expressions.tmdl') parts.push({ ...entry, path: `definition/${entry.path}` });
    if (!entry.path.startsWith('tables/') || !keep.has(entry.path.slice(7, -5))) continue;
    let text = Buffer.from(entry.payload, 'base64').toString('utf8');
    if (entry.path === 'tables/horizonte_classroom.tmdl') {
      text += '\n' + measures.map(([name, dax, description]) => [
        `\t/// ${description}`, `\tmeasure ${name} = ${dax}`,
        `\t\tformatString: ${name === 'TaxaAcertoAvaliados' ? '0.0%' : '0'}`, '',
      ].join('\n')).join('\n');
    }
    parts.push(part(`definition/${entry.path}`, text));
  }
  // One unambiguous classroom star; no graph extensions or ambiguous active paths.
  parts.push(part('definition/relationships.tmdl', entities
    .filter(e => e.properties.some(p => p.name === 'classId')).map(e => [
      `relationship ${e.table}_classroom`, `\tfromColumn: ${e.table}.classId`,
      '\ttoColumn: horizonte_classroom.id', '\tfromCardinality: many',
      '\ttoCardinality: one', '\tcrossFilteringBehavior: oneDirection', '',
    ].join('\n')).join('\n')));
  return { definition: { parts }, entities, excludedEntities: ['material'], measures };
}

export function buildReportDefinition(semanticModelId) {
  if (!uuid.test(semanticModelId)) throw new TypeError('InvalidSemanticModelId');
  const page = 'ProfessorOverview';
  const parts = [
    part('definition.pbir', {
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
      version: '4.0', datasetReference: { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } },
    }),
    part('definition/version.json', { $schema: schema('versionMetadata', '1.0.0'), version: '2.0.0' }),
    part('definition/report.json', { $schema: schema('report', '3.1.0'), themeCollection: {} }),
    part('definition/pages/pages.json', { $schema: schema('pagesMetadata', '1.0.0'), pageOrder: [page], activePageName: page }),
    part(`definition/pages/${page}/page.json`, {
      $schema: schema('page', '2.0.0'), name: page,
      displayName: 'Professor | Dados sinteticos / Synthetic data', displayOption: 'FitToPage', width: 1280, height: 900,
    }),
  ];
  const projection = (table, column, measure = false) => ({
    field: { [measure ? 'Measure' : 'Column']: { Expression: { SourceRef: { Entity: table } }, Property: column } },
    queryRef: `${table}.${column}`, nativeQueryRef: column,
  });
  function visual(name, visualType, projections, x, y, width, height) {
    parts.push(part(`definition/pages/${page}/visuals/${name}/visual.json`, {
      $schema: schema('visualContainer', '2.0.0'), name,
      position: { x, y, width, height, z: parts.length, tabOrder: parts.length },
      visual: { visualType, query: { queryState: { Values: { projections } } }, drillFilterOtherVisuals: true },
    }));
  }
  ['Turmas', 'AulasPlanejadas', 'EspacosIndisponiveis', 'PendenciasDiario'].forEach((name, i) =>
    visual(name, 'card', [projection('horizonte_classroom', name, true)], 20 + i * 315, 15, 300, 125));
  visual('Aulas', 'tableEx', ['classId', 'title', 'date', 'status'].map(c => projection('horizonte_lesson', c)), 20, 160, 780, 320);
  visual('TurmasDetalhes', 'tableEx', ['label', 'grade', 'studentCount'].map(c => projection('horizonte_classroom', c)), 820, 160, 440, 320);
  visual('Espacos', 'tableEx', ['label', 'status', 'reason', 'next'].map(c => projection('horizonte_space', c)), 20, 500, 780, 350);
  visual('Diario', 'tableEx', ['classId', 'lessonId', 'calendarPending', 'recorded'].map(c => projection('horizonte_diary_entry', c)), 820, 500, 440, 350);
  return { parts };
}
