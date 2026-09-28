import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifacts } from '../fabric/model.mjs';

// Usage from the repository: node scripts\fabric-generate.mjs --workspace GUID --lakehouse GUID
// Offline only: no environment variables, credentials, authentication, or API calls.
async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--workspace', '--lakehouse'].includes(name) || options.has(name) || !args[index + 1]) {
      throw new Error('Usage: node scripts\\fabric-generate.mjs --workspace GUID --lakehouse GUID');
    }
    options.set(name, args[index + 1]);
  }
  if (options.size !== 2) throw new Error('Both --workspace GUID and --lakehouse GUID are required');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  async function scoped(...segments) {
    let path = root;
    for (const segment of segments) {
      path = join(path, segment);
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Path escapes repository');
      const info = await lstat(path).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isSymbolicLink()) throw new Error('Repository paths must not be symbolic links');
    }
    return path;
  }
  const source = await scoped('ontology', 'dataset.json');
  const dataset = JSON.parse(await readFile(source, 'utf8'));
  const result = buildArtifacts(dataset, options.get('--workspace'), options.get('--lakehouse'));
  const outputs = [
    ['ontology-definition.json', result.ontologyDefinition],
    ['notebook-definition.json', result.notebookDefinition],
    ['manifest.json', result.manifest],
  ];
  const paths = await Promise.all(outputs.map(([name]) => scoped('fabric', 'generated', name)));
  await mkdir(await scoped('fabric', 'generated'), { recursive: true });
  for (let index = 0; index < outputs.length; index++) {
    await writeFile(paths[index], `${JSON.stringify(outputs[index][1], null, 2)}\n`, 'utf8');
  }
  console.log('Wrote fabric\\generated\\{ontology-definition.json,notebook-definition.json,manifest.json}');
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
