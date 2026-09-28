import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import Ajv from 'ajv-draft-04';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSemanticMcpServer } from '../dist/server/mcp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--origin', '--oauth-reference', '--output'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Usage: node scripts/package-copilot.mjs --origin HTTPS_ORIGIN --oauth-reference VAULT_REGISTRATION_ID [--output ZIP_PATH]');
  }
  if (values.has(args[i])) throw new Error('Duplicate parameter.');
  values.set(args[i], args[i + 1]);
}
const origin = new URL(values.get('--origin'));
const reference = values.get('--oauth-reference');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
  || origin.search || origin.hash || origin.pathname !== '/') {
  throw new Error('Supply an HTTPS origin, never a URL containing a token.');
}
if (!reference || !/^[A-Za-z0-9_.:-]{1,128}$/.test(reference) || /placeholder|replace|example/i.test(reference)) {
  throw new Error('A real OAuth client registration ID from the Microsoft plugin vault is required.');
}
const template = await readFile(resolve(root, 'copilot', 'manifest.template.json'), 'utf8');
const manifest = JSON.parse(template
  .replaceAll('{{ORIGIN}}', origin.origin)
  .replaceAll('{{HOST}}', origin.hostname)
  .replaceAll('{{OAUTH_REFERENCE_ID}}', reference));
const schemaResponse = await fetch(manifest.$schema, { signal: AbortSignal.timeout(30_000) });
if (!schemaResponse.ok) throw new Error(`Official manifest schema unavailable: ${schemaResponse.status}`);
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
if (!ajv.validate(await schemaResponse.json(), manifest)) {
  throw new Error(`Manifest schema validation failed: ${JSON.stringify(ajv.errors)}`);
}

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

const entries = {
  'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  'color.png': icon(192, false),
  'outline.png': icon(32, true),
};
const server = createSemanticMcpServer({ env: {} });
const client = new Client({ name: 'horizonte-packager', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  entries['toolDescription.json'] = strToU8(JSON.stringify(await client.listTools(), null, 2));
} finally {
  try { await client.close(); } finally { await server.close(); }
}
const declared = new Set(manifest.agentSkills.map(skill => skill.folder.replace(/^\.\/skills\//, '').replace(/^skills\//, '')));
const skillFiles = await readdir(resolve(root, 'copilot', 'skills'));
for (const name of skillFiles) {
  if (!name.endsWith('.txt')) continue;
  const id = name.slice(0, -4);
  const source = (await readFile(resolve(root, 'copilot', 'skills', name), 'utf8')).replace(/\r\n?/g, '\n');
  if (!declared.delete(id) || !source.startsWith(`---\nname: ${id}\n`)
    || !/^description: .{1,1024}$/m.test(source) || source.split('\n').length > 500) {
    throw new Error(`Invalid or undeclared skill source: ${name}`);
  }
  // Native package format requires this entry; source remains plain text in the repo.
  entries[`skills/${id}/SKILL.md`] = strToU8(source);
}
if (declared.size) throw new Error('A declared skill is missing its source.');
const output = resolve(root, values.get('--output') ?? '.runtime\\horizonte-copilot.zip');
if (!output.endsWith('.zip')) throw new Error('Output must be a ZIP package.');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(entries, { level: 6 }));
console.log(JSON.stringify({
  package: output, appId: manifest.id, connector: `${origin.origin}/mcp`,
  skills: manifest.agentSkills.length, auth: 'OAuthPluginVault', installed: false,
}, null, 2));
