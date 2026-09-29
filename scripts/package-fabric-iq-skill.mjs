import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import Ajv from 'ajv-draft-04';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaUrl = 'https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json';
const skillFolder = 'skills/horizonte-professor';
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const reportPattern = new RegExp(
  `^https://(app\\.powerbi\\.com|msit\\.powerbi\\.com|app\\.fabric\\.microsoft\\.com)/groups/${guid}/reports/${guid}(?:/ReportSection[A-Za-z0-9_-]*)?/?$`, 'i',
);

export function validateReportUrl(value) {
  // Reject all query/fragment/encoded input, not just known secret parameter names.
  if (typeof value !== 'string' || !reportPattern.test(value)
    || /[\s%?#\\]/.test(value)) {
    throw new Error('Report URL must be a direct HTTPS report link on an approved host, with GUIDs and no query, fragment, credentials or encoding.');
  }
  return new URL(value).href;
}

// Kept local: the legacy packager executes OAuth/server work on import.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, bytes) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
function icon(size, outline) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scan = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const ny = y / size;
      const stroke = ny > .23 && ny < .77 && ((nx > .23 && nx < .34) || (nx > .66 && nx < .77))
        || ny > .44 && ny < .56 && nx > .3 && nx < .7;
      const color = stroke ? [255, 255, 255, 255] : outline ? [0, 0, 0, 0] : [177, 31, 75, 255];
      scan.set(color, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(scan)), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function buildPackage(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['reportUrl', 'schema'].includes(key))) {
    throw new Error('Only reportUrl and schema options are supported; no OAuth configuration.');
  }
  const reportUrl = options.reportUrl === undefined ? undefined : validateReportUrl(options.reportUrl);
  const manifest = JSON.parse(await readFile(resolve(root, 'copilot', 'fabric-iq', 'manifest.template.json'), 'utf8'));
  const allowedKeys = ['$schema', 'manifestVersion', 'version', 'id', 'developer', 'name', 'description', 'icons', 'accentColor', 'agentSkills'];
  if (Object.keys(manifest).some(key => !allowedKeys.includes(key))
    || manifest.$schema !== schemaUrl || manifest.manifestVersion !== '1.28'
    || manifest.name?.short !== 'Horizonte Professor'
    || JSON.stringify(manifest.agentSkills) !== JSON.stringify([{ folder: skillFolder }])
    || manifest.icons?.color !== 'color.png' || manifest.icons?.outline !== 'outline.png') {
    throw new Error('Manifest must remain skill-only with the declared Horizonte Professor skill.');
  }
  if (options.schema !== undefined) {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    if (!ajv.validate(options.schema, manifest)) {
      throw new Error(`Manifest schema validation failed: ${JSON.stringify(ajv.errors)}`);
    }
  }
  const source = (await readFile(resolve(root, 'copilot', 'fabric-iq', 'horizonte-professor.txt'), 'utf8')).replace(/\r\n?/g, '\n');
  const frontmatter = /^---\nname: horizonte-professor\ndescription: ([^\n]+)\n---\n/.exec(source);
  if (!frontmatter || frontmatter[1].length > 1024 || source.split('\n').length > 160) {
    throw new Error('Invalid skill frontmatter or size: description <=1024 characters, source <=160 lines.');
  }
  const entries = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'color.png': icon(192, false),
    'outline.png': icon(32, true),
    [`${skillFolder}/SKILL.md`]: strToU8(source),
  };
  if (reportUrl) {
    entries[`${skillFolder}/references/REPORT.txt`] = strToU8(`Report: Horizonte Professor\nURL: ${reportUrl}\n`);
  }
  // SKILL.md is emitted only inside the native ZIP; public source stays .txt.
  return { manifest, bytes: zipSync(entries, { level: 6 }) };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--report-url')) {
    throw new Error('Usage: node scripts/package-fabric-iq-skill.mjs [--report-url HTTPS_REPORT_URL]');
  }
  const reportUrl = args.length ? validateReportUrl(args[1]) : undefined;
  const response = await fetch(schemaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Official manifest schema unavailable: ${response.status}`);
  const { manifest, bytes } = await buildPackage({ reportUrl, schema: await response.json() });
  const output = resolve(root, '.runtime', 'horizonte-fabric-iq-skill.zip');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  console.log(JSON.stringify({
    package: output, appId: manifest.id, skills: manifest.agentSkills.length,
    connectors: 0, auth: 'existing Fabric IQ capability; no new OAuth',
    schemaValidated: true, installed: false,
  }, null, 2));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Avoid echoing sensitive CLI input or network exception details.
    console.error('Package not created. Check arguments, HTTPS report link, skill source and official schema availability.');
    process.exitCode = 1;
  });
}
