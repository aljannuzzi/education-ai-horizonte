import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactsV2 } from '../fabric/model-v2.mjs';

const usage = 'node scripts\\fabric-generate-v2.mjs --workspace GUID --lakehouse GUID --sql-endpoint HOST --sql-database DATABASE';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nOffline only. Writes fabric\\generated-v2\\{ontology-definition.json,notebook-definition.json,manifest.json}. SQL database is the actual endpoint catalog, not an inferred item ID.`);
    return;
  }
  const keys = new Map([
    ['--workspace', 'workspaceId'], ['--lakehouse', 'lakehouseId'],
    ['--sql-endpoint', 'sqlEndpoint'], ['--sql-database', 'sqlDatabase'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys.get(args[index]);
    if (!key || Object.hasOwn(options, key) || !args[index + 1]) throw new Error(usage);
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== keys.size) throw new Error(usage);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  async function scoped(...segments) {
    let path = root;
    for (const segment of segments) {
      path = join(path, segment);
      const info = await lstat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isSymbolicLink()) throw new Error('Repository paths must not be symbolic links');
    }
    return path;
  }
  const dataset = JSON.parse(await readFile(await scoped('ontology', 'dataset.json'), 'utf8'));
  const result = buildArtifactsV2(dataset, options);
  const outputs = [
    ['ontology-definition.json', result.ontologyDefinition],
    ['notebook-definition.json', result.notebookDefinition],
    ['manifest.json', result.manifest],
  ];
  const paths = await Promise.all(outputs.map(([name]) => scoped('fabric', 'generated-v2', name)));
  await mkdir(await scoped('fabric', 'generated-v2'), { recursive: true });
  for (let index = 0; index < outputs.length; index++) {
    await writeFile(paths[index], `${JSON.stringify(outputs[index][1], null, 2)}\n`, 'utf8');
  }
  console.log('Generated TMDL native world: fabric\\generated-v2\\{ontology-definition.json,notebook-definition.json,manifest.json}. Not executed or activated.');
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
