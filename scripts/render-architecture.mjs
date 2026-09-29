import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// Both formats share geometry and text. No network, fonts, or packages are downloaded.
const out = fileURLToPath(new URL('../docs/images/', import.meta.url));
const palette = {
  blue: ['#246095', '#E6F1FB'],
  purple: ['#725294', '#F0E8F7'],
  green: ['#39774A', '#E8F4E9'],
  amber: ['#946519', '#FFF3D8'],
  neutral: ['#596571', '#F1F3F5'],
};
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

class Diagram {
  constructor(name, height, title, desc) {
    this.name = name;
    this.width = 1760;
    this.height = height;
    this.elements = [];
    this.parts = [];
    this.title = title;
    this.desc = desc;
    this.serial = 0;
    this.labels = [];
  }
  element(type, x, y, width, height, extra = {}) {
    const id = `${this.name}-${++this.serial}`;
    const item = {
      id, type, x, y, width, height, angle: 0, strokeColor: '#596571',
      backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [],
      frameId: null, roundness: null, seed: this.serial, version: 1,
      versionNonce: this.serial, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false, ...extra,
    };
    this.elements.push(item);
    return item;
  }
  text(x, y, width, text, size = 24, bold = false) {
    const lines = text.split('\n');
    // Explicit dimensions include generous edit-space; SVG uses the same top/line spacing.
    this.element('text', x, y, width, size * 2.5 * lines.length, {
      strokeColor: '#000000', text, originalText: text, fontSize: size,
      fontFamily: 2, textAlign: 'left', verticalAlign: 'top', containerId: null,
      lineHeight: 1.4, autoResize: false,
    });
    this.parts.push(`<text x="${x}" y="${y}" fill="#000000" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${bold ? 600 : 400}">${lines.map((l, i) => `<tspan x="${x}" y="${y + size + i * size * 1.4}">${escape(l)}</tspan>`).join('')}</text>`);
  }
  rect(x, y, w, h, color, container = false) {
    const [stroke, fill] = palette[color];
    this.element('rectangle', x, y, w, h, {
      strokeColor: stroke, backgroundColor: container ? 'transparent' : fill,
      roundness: { type: 3 },
    });
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" stroke="${stroke}" stroke-width="2" fill="${container ? 'none' : fill}"/>`);
  }
  label(x, y, width, text, size = 22) {
    this.labels.push(() => {
      const h = size * 1.4 * text.split('\n').length + 4;
      this.element('rectangle', x - 4, y, width + 8, h, {
        strokeColor: '#ffffff', backgroundColor: '#ffffff', strokeWidth: 0,
      });
      this.parts.push(`<rect x="${x - 4}" y="${y}" width="${width + 8}" height="${h}" fill="#ffffff"/>`);
      this.text(x, y, width, text, size);
    });
  }
  boundary(x, y, w, h, title, color) {
    this.rect(x, y, w, h, color, true);
    this.text(x + 24, y + 16, w - 48, title, 26, true);
  }
  box(x, y, w, h, title, body, color = 'blue', size = 24) {
    this.rect(x, y, w, h, color);
    this.text(x + 24, y + 16, w - 48, title, 30, true);
    if (body) this.text(x + 24, y + 64, w - 48, body, size);
  }
  arrow(points, { dashed = false, both = false } = {}) {
    const [x, y] = points[0];
    const relative = points.map(([a, b]) => [a - x, b - y]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    this.element('arrow', x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      points: relative, startBinding: null, endBinding: null, lastCommittedPoint: null,
      startArrowhead: both ? 'arrow' : null, endArrowhead: 'arrow',
      strokeStyle: dashed ? 'dashed' : 'solid', elbowed: false,
    });
    this.parts.push(`<polyline points="${points.map(p => p.join(',')).join(' ')}" fill="none" stroke="#596571" stroke-width="2.5" stroke-linejoin="round"${dashed ? ' stroke-dasharray="9 7"' : ''}${both ? ' marker-start="url(#start)"' : ''} marker-end="url(#end)"/>`);
  }
  heading(kicker, subtitle) {
    this.text(40, 24, 1680, kicker, 22, true);
    this.text(40, 64, 1680, this.title, 38, true);
    this.text(40, 120, 1680, subtitle, 24);
  }
  save() {
    for (const label of this.labels) label();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" role="img" aria-labelledby="title desc" lang="pt-BR">
<title id="title">${escape(this.title)} — Arquitetura de referência</title>
<desc id="desc">${escape(this.desc)}</desc>
<defs>
<marker id="end" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M2 2 L10 6 L2 10" fill="none" stroke="#596571" stroke-width="1.6"/></marker>
<marker id="start" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M10 2 L2 6 L10 10" fill="none" stroke="#596571" stroke-width="1.6"/></marker>
</defs>
<rect width="1760" height="${this.height}" fill="#FFFFFF"/>
${this.parts.join('\n')}
</svg>
`;
    const source = {
      type: 'excalidraw', version: 2, source: 'education-ai-horizonte',
      elements: this.elements,
      appState: { viewBackgroundColor: '#ffffff', gridSize: 8, currentItemFontFamily: 2 },
      files: {},
    };
    assert.equal(new Set(this.elements.map(e => e.id)).size, this.elements.length);
    for (const e of this.elements) {
      assert.equal(e.roughness, 0);
      if (e.type === 'text') {
        assert.equal(e.strokeColor, '#000000');
        assert.equal(e.fontFamily, 2);
        assert.ok(e.fontSize >= 22 && e.width > 0 && e.height > 0);
        const visibleHeight = e.fontSize * (1 + (e.text.split('\n').length - 1) * 1.4);
        assert.ok(e.x >= 0 && e.x + e.width <= this.width && e.y + visibleHeight < this.height, e.text);
      }
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${this.name}.svg`), svg);
    writeFileSync(path.join(out, `${this.name}.excalidraw`), JSON.stringify(source, null, 2) + '\n');
    assert.equal(JSON.parse(readFileSync(path.join(out, `${this.name}.excalidraw`))).elements.length, this.elements.length);
    console.log(`${this.name}: ${this.width} × ${this.height}; SVG + Excalidraw; ${this.elements.length} elementos`);
    if (process.argv.includes('--png')) this.png();
  }
  png() {
    const browser = process.env.ARCHITECTURE_BROWSER ||
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    assert.ok(existsSync(browser), 'Defina ARCHITECTURE_BROWSER para um navegador Chromium local.');
    const profile = path.join(out, `.render-profile-${process.pid}-${this.name}`);
    const target = path.join(out, `${this.name}.png`);
    try {
      const result = spawnSync(browser, [
        '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--hide-scrollbars', '--force-device-scale-factor=1',
        `--user-data-dir=${profile}`, `--window-size=${this.width},${this.height}`,
        `--screenshot=${target}`, pathToFileURL(path.join(out, `${this.name}.svg`)).href,
      ], { timeout: 45000, windowsHide: true, encoding: 'utf8' });
      assert.ok(!result.error && result.status === 0, result.error?.message || result.stderr);
      const png = readFileSync(target);
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), this.width);
      assert.equal(png.readUInt32BE(20), this.height);
      console.log(`${this.name}: PNG local verificado`);
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    }
  }
}

const pattern = new Diagram('horizonte-pattern', 1536, 'O pattern completo',
  'Arquitetura de referência, não comprovação de provisionamento. O professor usa o Copilot nativo, com Skills e contexto autorizado do Work IQ. O MCP Horizonte valida argumentos e escopo, consulta o Fabric Data Agent e, separadamente, aciona especialistas de IA. O Fabric IQ fornece ontologia nativa vinculada ao lakehouse no OneLake. Fontes educacionais sintéticas alimentam o lakehouse de baixo para cima; consultas seguem para baixo. Evidências, origem e sugestões voltam pelo MCP ao Copilot. O professor revisa os resultados antes de qualquer alteração ou comunicação; não há notas automáticas.');
pattern.heading('HORIZONTE  /  01  /  ARQUITETURA DE REFERÊNCIA', 'Copilot nativo para o professor • semântica governada no Fabric • IA especializada sob escopo');
pattern.boundary(40, 176, 496, 880, 'Microsoft 365 · SaaS', 'blue');
pattern.boundary(640, 176, 496, 880, 'Azure · orquestração', 'purple');
pattern.boundary(1240, 176, 480, 960, 'Microsoft Fabric · SaaS', 'green');
pattern.box(88, 240, 400, 80, 'Professor', '', 'blue');
pattern.box(88, 384, 400, 224, 'A · Copilot nativo',
  'Home / Chat • Cowork\nCode • Autopilot¹\nExperiência e agenda nativas', 'blue');
pattern.box(88, 768, 192, 208, 'Skills', 'Rotinas\ndocentes', 'blue', 22);
pattern.box(296, 768, 192, 208, 'Work IQ', 'Documentos e\ncolaboração\nautorizados', 'blue', 22);
pattern.box(688, 384, 400, 224, 'B · MCP Horizonte',
  'HTTPS + OAuth\nValida argumentos e escopo\nRoteia; não replica o Copilot', 'purple', 23);
pattern.box(688, 768, 400, 224, 'F · IA especializada',
  'Suporte e escrita\nAzure OpenAI + agentes\npor APIs autorizadas²', 'purple');
pattern.box(1288, 384, 384, 176, 'C · Fabric Data Agent',
  'Consulta somente leitura\nDados governados', 'green');
pattern.box(1288, 704, 384, 128, 'D · Fabric IQ', 'Ontologia nativa', 'green');
pattern.box(1288, 976, 384, 128, 'E · OneLake', 'Lakehouse educacional', 'green');
pattern.boundary(1240, 1192, 480, 208, 'Fontes educacionais', 'amber');
pattern.box(1288, 1256, 384, 128, 'G · Dados sintéticos', 'Registros • aulas • materiais\nAtividades • espaços', 'amber', 22);
pattern.box(88, 1152, 1000, 216, 'Decisão do professor · retorno no Copilot',
  'Plano / kit de aula  •  ferramenta interativa  •  rascunho revisável\nRevisão humana antes de alterar dados ou comunicar.\nSem atribuição automática de notas.', 'amber', 26);
pattern.arrow([[288, 320], [288, 384]]);
pattern.arrow([[488, 440], [688, 440]]);
pattern.label(504, 368, 152, 'pergunta\n+ escopo');
pattern.arrow([[688, 552], [488, 552]]);
pattern.label(504, 560, 120, 'respostas');
pattern.arrow([[1088, 440], [1288, 440]]);
pattern.label(1104, 368, 136, 'consulta\ngovernada');
pattern.arrow([[1288, 520], [1088, 520]]);
pattern.label(1104, 536, 136, 'evidências\n+ origem');
pattern.arrow([[264, 768], [264, 608]]);
pattern.text(96, 664, 176, 'procedimentos', 22);
pattern.arrow([[472, 768], [472, 608]]);
pattern.text(304, 664, 176, 'contexto M365', 22);
pattern.arrow([[872, 608], [872, 768]]);
pattern.text(696, 664, 176, 'contexto\nmínimo', 22);
pattern.arrow([[920, 768], [920, 608]]);
pattern.text(936, 664, 176, 'sugestões', 22);
pattern.arrow([[1480, 560], [1480, 704]]);
pattern.text(1504, 608, 200, 'semântica', 22);
pattern.arrow([[1480, 832], [1480, 976]]);
pattern.text(1296, 864, 176, 'consulta ↓\nvínculo com\nlakehouse', 22);
pattern.arrow([[1648, 1256], [1648, 1104]]);
pattern.text(1456, 1144, 176, 'ingestão ↑', 22);
pattern.arrow([[88, 560], [64, 560], [64, 1120], [288, 1120], [288, 1152]]);
pattern.text(96, 1072, 952, 'Resultados retornam ao Copilot; o professor decide.', 24);
pattern.text(40, 1424, 1680, '¹ Superfícies sujeitas à disponibilidade. Autopilot agenda no Copilot, não em um job Azure.', 22);
pattern.text(40, 1464, 1680, '² Agentes independentes por APIs aprovadas. Azure OpenAI não é o cérebro do Copilot nem a ontologia.', 22);
pattern.save();

const azure = new Diagram('horizonte-azure', 1584, 'Como a TI opera em Azure e Fabric',
  'Arquitetura de referência, não prova de provisionamento. Microsoft 365 e Entra ID são serviços externos ao resource group. OAuth delegado autentica o professor no MCP Horizonte em Azure Container Apps Consumption. O aplicativo contém MCP e adapters; especialistas usam Azure OpenAI. Blob guarda rascunhos e auditoria, não é OneLake nem fonte oficial. A identidade gerenciada atribuída pelo usuário recebe RBAC em OpenAI, Blob e ACR. Um service principal dedicado, distinto da identidade gerenciada e do usuário, acessa o Fabric com permissão mínima no workspace e nos dados. O workspace SaaS contém Data Agent, ontologia nativa Fabric IQ e lakehouse no OneLake. A capacidade F2 ou superior tem provisionamento e cobrança ARM, mas não move o workspace para o Container App. GitHub e Bicep configuram recursos; ACR fornece a imagem OCI. Linhas tracejadas indicam deploy e telemetria, não consultas de dados.');
azure.heading('HORIZONTE  /  02  /  ARQUITETURA DE REFERÊNCIA', 'Fronteiras de execução, identidades e operação • nomes genéricos • dados sintéticos');
azure.boundary(40, 176, 1680, 168, 'Acesso · serviços externos ao resource group', 'blue');
azure.box(72, 232, 528, 88, '01 · Copilot nativo / M365', '', 'blue');
azure.box(848, 232, 832, 88, 'Microsoft Entra ID · usuário ≠ identidade de serviço', '', 'blue');
azure.arrow([[600, 272], [848, 272]]);
azure.text(616, 232, 224, 'OAuth delegado', 22);
azure.boundary(40, 400, 1048, 856, 'Assinatura Azure · resource group · runtime', 'purple');
azure.boundary(1160, 400, 560, 856, 'Fabric · capacidade + workspace', 'green');
azure.box(424, 496, 616, 208, '02 · Azure Container Apps',
  'Horizonte: MCP HTTPS + adaptadores de agentes\nPolítica: valida argumentos e escopo do professor\nDuas rotas: consulta Fabric ou IA especializada', 'purple', 23);
azure.text(752, 344, 336, 'OAuth: usuário → MCP', 22);
azure.text(448, 448, 568, 'Plano Consumption · HTTPS', 22);
azure.arrow([[560, 320], [560, 384], [1008, 384], [1008, 496]]);
azure.box(72, 1016, 304, 176, '06 · ACR',
  'Imagem OCI\nPull via UAMI', 'neutral');
azure.box(424, 832, 288, 160, 'Azure OpenAI',
  '03 · Modelo para\nos especialistas', 'purple', 23);
azure.box(760, 832, 280, 160, '04 · Blob',
  'Rascunhos / auditoria\nNão é OneLake', 'amber', 22);
azure.box(424, 1064, 288, 128, 'Log Analytics', '05 · Telemetria', 'neutral', 23);
azure.box(760, 1064, 280, 128, '07 · UAMI',
  'RBAC: OpenAI,\nBlob e ACR', 'neutral', 23);
azure.arrow([[552, 704], [552, 832]], { both: true });
azure.label(432, 752, 264, 'inferência especializada');
azure.arrow([[896, 704], [896, 832]], { both: true });
azure.label(784, 752, 232, 'estado operacional');
azure.arrow([[736, 704], [736, 1128], [712, 1128]], { dashed: true });
azure.text(440, 1016, 272, 'logs / métricas', 22);
azure.arrow([[216, 1016], [216, 656], [424, 656]], { dashed: true });
azure.label(88, 744, 272, 'deploy OCI\npara o aplicativo', 23);
azure.label(72, 880, 304, 'Serviços auxiliares:\nsem dados oficiais');

azure.boundary(1184, 472, 512, 544, 'Workspace · SaaS governado', 'green');
azure.box(1216, 560, 448, 112, '08 · Fabric Data Agent', 'Leitura governada', 'green');
azure.box(1216, 752, 448, 112, '09 · Fabric IQ', 'Ontologia nativa do lakehouse', 'green');
azure.box(1216, 904, 448, 96, '10 · OneLake', 'Lakehouse educacional', 'green', 22);
azure.arrow([[1040, 600], [1216, 600]], { both: true });
azure.label(1048, 520, 136, 'consulta /\nevidências');
azure.arrow([[1440, 672], [1440, 752]]);
azure.text(1464, 696, 216, 'semântica', 22);
azure.arrow([[1440, 864], [1440, 904]]);
azure.box(1184, 1064, 512, 128, '11 · Capacidade Fabric F2+',
  'ARM: provisionamento e cobrança\nWorkspace e permissões: SaaS', 'green', 23);
azure.text(1208, 1208, 480, 'Capacidade não é o workspace.', 22);

azure.box(72, 1360, 304, 136, 'GitHub',
  'Bicep + build OCI\nConfiguração / IaC', 'neutral', 23);
azure.arrow([[216, 1360], [216, 1192]], { dashed: true });
azure.text(88, 1288, 288, 'build → ACR', 22);
azure.box(424, 1312, 1272, 184, '12 · Identidade de aplicação Fabric · service principal dedicado',
  'MCP → Fabric: credencial de aplicação; não usa a UAMI nem o token delegado do professor.\nPermissões mínimas no workspace e nos dados; administração de capacidade não é papel de runtime.\nUAMI fica no Azure: acesso RBAC ao modelo, ao Blob e ao registro de imagens.', 'neutral', 24);
azure.text(40, 1520, 1680, 'Linhas: contínua = execução; tracejada = deploy / telemetria. Custos: processamento • IA • dados / operação • Fabric.', 22);
azure.save();
