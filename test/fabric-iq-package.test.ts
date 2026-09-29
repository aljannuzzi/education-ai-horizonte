import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { buildPackage, main, validateReportUrl } from '../scripts/package-fabric-iq-skill.mjs';

const reportPath = '/groups/11111111-1111-4111-8111-111111111111/reports/22222222-2222-4222-8222-222222222222';
const reportUrl = `https://app.powerbi.com${reportPath}`;
const skillPath = 'skills/horizonte-professor/SKILL.md';

test('offline package contains only one named skill, icons and manifest; no connector or OAuth', async () => {
  const { bytes, manifest } = await buildPackage();
  const entries = unzipSync(bytes);
  assert.deepEqual(Object.keys(entries).sort(), ['color.png', 'manifest.json', 'outline.png', skillPath].sort());
  assert.deepEqual(JSON.parse(strFromU8(entries['manifest.json'])), manifest);
  assert.equal(manifest.manifestVersion, '1.28');
  assert.equal(manifest.name.short, 'Horizonte Professor');
  assert.equal(manifest.id, 'd64d2e93-e3d4-47fa-95a9-2371309b4e68');
  const legacy = JSON.parse(await readFile(new URL('../copilot/manifest.template.json', import.meta.url), 'utf8'));
  assert.notEqual(manifest.id, legacy.id);
  assert.deepEqual(manifest.agentSkills, [{ folder: 'skills/horizonte-professor' }]);
  for (const key of ['agentConnectors', 'copilotAgents', 'permissions', 'webApplicationInfo', 'validDomains']) {
    assert.equal(Object.hasOwn(manifest, key), false);
  }
  for (const key of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
    assert.ok(manifest.developer[key].startsWith('https://github.com/aljannuzzi/education-ai-horizonte'));
  }
  assert.doesNotMatch(JSON.stringify(manifest), /OAuthPluginVault|remoteMcpServer|localhost|\{\{/);
  assert.doesNotMatch(strFromU8(entries[skillPath]), /https:\/\/(?:app\.powerbi|msit\.powerbi|app\.fabric)|tenantId|client_secret/);
});

test('source stays plain text; native skill is bounded, discoverable and read-only', async () => {
  const entries = unzipSync((await buildPackage()).bytes);
  const text = strFromU8(entries[skillPath]);
  const source = await readFile(new URL('../copilot/fabric-iq/horizonte-professor.txt', import.meta.url), 'utf8');
  assert.equal(text, source.replace(/\r\n?/g, '\n'));
  const match = /^---\nname: horizonte-professor\ndescription: ([^\n]+)\n---\n/.exec(text);
  assert.ok(match);
  assert.ok(match[1].length <= 1024);
  assert.ok(text.split('\n').length <= 160);
  for (const term of ['preparar aula', 'diário', '7A/7B', 'laboratório', 'espaço indisponível', 'material', 'recomposição', 'plano de aula', 'Escola Horizonte', 'Marina']) {
    assert.ok(match[1].includes(term), term);
  }
  for (const term of ['Fabric IQ', 'menos de 500', 'snapshot', '29 de setembro de 2026', 'Fatos', 'Proposta', 'O que o professor revisa', 'Confidential/InternalOnly', 'Somente leitura', 'Não faça HTTP bruto', 'Não consulte diretamente Data Agent', 'joins', 'Habilite o plugin Fabric IQ existente']) {
    assert.ok(text.includes(term), term);
  }
  for (const scene of ['plano B', 'Aula sobre água', 'Frações e recomposição', 'Apoio ao diário']) {
    assert.ok(text.includes(scene), scene);
  }
});

test('optional report binding is confined to an in-ZIP reference, never the source or manifest', async () => {
  const baseline = await buildPackage();
  const bound = await buildPackage({ reportUrl });
  const entries = unzipSync(bound.bytes);
  assert.deepEqual(bound.manifest, baseline.manifest);
  assert.deepEqual(entries[skillPath], unzipSync(baseline.bytes)[skillPath]);
  const reference = 'skills/horizonte-professor/references/REPORT.txt';
  assert.deepEqual(Object.keys(entries).sort(), ['color.png', 'manifest.json', 'outline.png', skillPath, reference].sort());
  assert.equal(strFromU8(entries[reference]), `Report: Horizonte Professor\nURL: ${reportUrl}\n`);
  assert.equal(strFromU8(unzipSync((await buildPackage()).bytes)[skillPath]).includes(reportUrl), false);
});

test('approved Power BI/Fabric report hosts and report pages are accepted', () => {
  for (const host of ['app.powerbi.com', 'msit.powerbi.com', 'app.fabric.microsoft.com']) {
    for (const suffix of ['', '/', '/ReportSection', '/ReportSectionabc_123']) {
      const url = `https://${host}${reportPath}${suffix}`;
      assert.equal(validateReportUrl(url), url);
    }
  }
});

test('reject credentials, auth/client secrets, encoded queries, redirects and arbitrary URLs', async () => {
  const invalid = [
    '', undefined, null, 123, 'not-a-url', reportUrl.replace('https:', 'http:'),
    reportUrl.replace('app.powerbi.com', 'app.powerbi.com.evil.example'),
    reportUrl.replace('app.powerbi.com', 'evil.example'),
    reportUrl.replace('https://', 'https://user:password@'),
    reportUrl.replace('app.powerbi.com', 'app.powerbi.com:443'),
    reportUrl.replace('/groups/', '/oauth2/'),
    reportUrl.replace('/groups/', '/groups/../groups/'),
    reportUrl.replace('11111111-1111-4111-8111-111111111111', 'me'),
    reportUrl + '?client_id=forbidden',
    reportUrl + '?client_secret=forbidden',
    reportUrl + '?access_token=forbidden',
    reportUrl + '?experience=power-bi',
    reportUrl + '?%63lient_secret=forbidden',
    reportUrl + '%3Fclient_secret%3Dforbidden',
    reportUrl + '%253Fclient_secret%253Dforbidden',
    reportUrl + '#access_token=forbidden',
    reportUrl + '/secret', reportUrl + '\n', ' ' + reportUrl,
    reportUrl.replace('/groups/', '\\groups\\'),
  ];
  for (const url of invalid) {
    assert.throws(() => validateReportUrl(url));
    if (url !== undefined) await assert.rejects(buildPackage({ reportUrl: url }));
  }
  await assert.rejects(buildPackage({ clientSecret: 'forbidden' }), /Only reportUrl/);
  await assert.rejects(buildPackage({ oauthReference: 'forbidden' }), /Only reportUrl/);
  for (const args of [['--oauth-reference', 'forbidden'], ['--report-url'], ['--origin', 'https://example.org'], ['--report-url', reportUrl, '--report-url', reportUrl]]) {
    await assert.rejects(main(args), /Usage/);
  }
});

test('schema validation can be supplied offline; official schema is fetched only by CLI', async () => {
  // Unit tests exercise validation without a network dependency; CLI uses the full official schema.
  const schema = {
    type: 'object',
    required: ['manifestVersion', 'id', 'developer', 'agentSkills'],
    properties: { manifestVersion: { enum: ['1.28'] }, agentSkills: { type: 'array', minItems: 1, maxItems: 1 } },
  };
  await buildPackage({ schema });
  await assert.rejects(buildPackage({ schema: { type: 'object', required: ['agentConnectors'] } }), /Manifest schema validation failed/);
});

test('PNG icons contain valid CRCs, dimensions, RGBA scanlines and transparent outline', async () => {
  const entries = unzipSync((await buildPackage()).bytes);
  function crc32(bytes: Uint8Array) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  for (const [name, size] of [['color.png', 192], ['outline.png', 32]] as const) {
    const png = Buffer.from(entries[name]);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks: Record<string, Buffer> = {};
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      chunks[type] = png.subarray(offset + 8, offset + 8 + length);
      assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
      offset += length + 12;
    }
    assert.deepEqual(Object.keys(chunks), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(chunks.IHDR.readUInt32BE(0), size);
    assert.equal(chunks.IHDR.readUInt32BE(4), size);
    assert.equal(chunks.IHDR[8], 8);
    assert.equal(chunks.IHDR[9], 6);
    const scan = inflateSync(chunks.IDAT);
    assert.equal(scan.length, (size * 4 + 1) * size);
    assert.equal(scan[4], name === 'outline.png' ? 0 : 255);
    for (let y = 0; y < size; y++) assert.equal(scan[y * (size * 4 + 1)], 0);
  }
});
