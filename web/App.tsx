import { CostPanel } from './CostPanel';
import './costs.css';

const capabilities = [
  {
    number: '01',
    title: 'Agentes especialistas',
    text: 'No Cowork, o professor solicita um relatório, acompanha o trabalho e revisa as evidências na experiência nativa do Copilot.',
    detail: 'Contexto compartilhado. Especialidades distintas.',
  },
  {
    number: '02',
    title: 'Sistemas escolares',
    text: 'Adaptadores conectam agentes AI e serviços legacy à mesma camada semântica. Neste ambiente, todos os sistemas e dados são sintéticos.',
    detail: 'Integração demonstrável, sem sistemas reais.',
  },
  {
    number: '03',
    title: 'Ontologia e evidências',
    text: 'O fluxo principal usa Fabric IQ nativo para contextualizar o relatório. A ontologia customizada via MCP é uma variante de integração.',
    detail: 'Relações explícitas. Evidências rastreáveis.',
  },
];

export function App() {
  if (window.location.pathname === '/costs' || window.location.pathname === '/costs/') {
    return <CostPanel />;
  }

  return (
    <>
      <a className="skip-link" href="#main">Ir para o conteúdo</a>
      <header className="site-header container">
        <a className="brand" href="#main" aria-label="Horizonte, início">
          <span className="brand-name">Horizonte<span className="brand-dot">.</span></span>
          <span className="brand-description">Education Skills for Copilot</span>
        </a>
        <nav className="cost-header-nav" aria-label="Navegação principal">
          <a className="header-link" href="/costs">Custo por pergunta</a>
          <a className="header-link" href="#installation">Instalação técnica <span aria-hidden="true">↗</span></a>
        </nav>
      </header>

      <main id="main" className="container">
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow"><span className="status-dot" aria-hidden="true" /> COPILOT NATIVO · INFRAESTRUTURA EDUCACIONAL</div>
          <h1 id="hero-title">O professor trabalha no Copilot.<br /><span>Os sistemas trabalham juntos.</span></h1>
          <p className="hero-description">No fluxo principal, Cowork + Fabric IQ nativo produzem um relatório com evidências para revisão do professor.
            Esta página é um ponto de instalação e diagnóstico técnico — não um aplicativo docente substituto.</p>
          <div className="hero-actions">
            <a className="button primary" href="https://copilot.cloud.microsoft/" target="_blank" rel="noopener noreferrer">
              Abrir Copilot nativo <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#architecture">Entender a arquitetura <span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-note">Ambiente sintético <span aria-hidden="true">/</span> Instalação no tenant não verificada</p>
        </section>

        <section className="capabilities" aria-label="Camadas do Horizonte">
          {capabilities.map(card => (
            <article className="capability-card" key={card.number}>
              <span className="card-number">{card.number} /</span>
              <h2>{card.title}</h2>
              <p>{card.text}</p>
              <p className="card-detail">{card.detail}</p>
            </article>
          ))}
        </section>

        <section id="architecture" className="architecture section-block" aria-labelledby="architecture-title">
          <div className="section-heading">
            <p className="eyebrow">UMA SUPERFÍCIE. SISTEMAS CONECTADOS.</p>
            <h2 id="architecture-title">Nativo na experiência.<br />Aberto na integração.</h2>
          </div>
          <div className="architecture-content">
            <p className="flow" aria-label="Cowork, Fabric IQ nativo, relatório com evidências, revisão docente">
              <span>Cowork</span><b aria-hidden="true">→</b><span>Fabric IQ nativo</span><b aria-hidden="true">→</b>
              <span>Relatório com evidências</span><b aria-hidden="true">→</b><span>Revisão docente <small>dados sintéticos</small></span>
            </p>
            <p>A experiência principal acontece no Cowork com Fabric IQ nativo. O backend de ontologia customizada
              via MCP é uma variante, não uma implementação do Fabric. Cowork, Code e Autopilot não são
              reproduzidos aqui: o Code nativo cria artefatos e ferramentas na própria superfície;
              o Autopilot nativo gerencia os agendamentos, não um job Azure desta web.</p>
            <aside className="product-note">
              <strong>Disponibilidade do produto · 28 set 2026</strong>
              <p>Home e Code: Frontier. Autopilot: private preview. A disponibilidade das experiências nativas
                depende do tenant e das permissões. Esta landing não habilita esses recursos.</p>
            </aside>
          </div>
        </section>

        <section id="installation" className="installation section-block" aria-labelledby="installation-title">
          <div className="section-heading">
            <p className="eyebrow">SOMENTE PARA ADMINISTRADORES E DESENVOLVEDORES</p>
            <h2 id="installation-title">Preparar. Instalar.<br />Verificar no Copilot.</h2>
            <p className="installation-status">Pacote a instalar · não verificado</p>
          </div>
          <div>
            <ol className="install-steps">
              <li><strong>Validar o ambiente</strong><p>Confira a saúde do serviço e a configuração de acesso com o responsável pelo backend. Todos os dados desta demonstração são sintéticos.</p></li>
              <li><strong>Configurar a integração escolhida</strong><p>No fluxo principal, valide o acesso ao Fabric IQ nativo. Na variante MCP, instale o pacote plugin e configure a conexão protegida pelos mecanismos aprovados do tenant.</p></li>
              <li><strong>Confirmar na superfície nativa</strong><p>Verifique autenticação, catálogo de ferramentas e leitura de evidências no Copilot antes de considerar a integração instalada.</p></li>
            </ol>
            <div className="security-notice">
              <strong>MCP protegido; pacote plugin a instalar no Copilot; nunca colocar chave no URL.</strong>
              <p>Não há login docente nem campo de chave nesta página. Nenhum dado protegido é carregado ou embutido aqui.</p>
            </div>
            <div className="diagnostic-links" aria-label="Diagnóstico técnico">
              <a href="/healthz" target="_blank" rel="noopener noreferrer">Saúde do serviço <code>/healthz</code> ↗</a>
              <a href="#mcp-help">Ajuda do endpoint <code>/mcp</code> ↓</a>
            </div>
            <details id="mcp-help">
              <summary>Como verificar o MCP</summary>
              <p><code>/mcp</code> é um endpoint de protocolo protegido, não uma página de trabalho.
                Configure-o no cliente Copilot com a autenticação definida pelo administrador.
                Abrir o endereço no navegador não comprova a conexão nem a instalação.</p>
              <p>Bootstrap, catálogo/grafo e evidências são diagnósticos técnicos: use somente as APIs
                de leitura documentadas, com autorização. Não envie credenciais por query string,
                não as cole em prompts e não as registre em logs.</p>
            </details>
          </div>
        </section>

        <section className="legal-grid section-block" aria-label="Privacidade e termos">
          <article id="privacy">
            <p className="eyebrow">PRIVACIDADE</p>
            <h2>Dados sintéticos. Limites explícitos.</h2>
            <p>Esta demonstração não usa dados pessoais de alunos ou professores nem se conecta a sistemas escolares reais.
              Não envie PII, registros reais ou segredos. Logs técnicos devem excluir credenciais e dados pessoais;
              a retenção e o acesso devem ser definidos pelo operador do ambiente.</p>
          </article>
          <article id="terms">
            <p className="eyebrow">TERMOS DE USO</p>
            <h2>Avaliação técnica, não produção.</h2>
            <p>Ambiente destinado à avaliação com dados sintéticos, sem garantia de disponibilidade ou adequação
              a decisões escolares reais. A instalação depende da validação do administrador, das políticas
              do tenant e dos termos aplicáveis ao Copilot. Revise evidências e resultados antes de qualquer uso.</p>
          </article>
        </section>
      </main>

      <footer className="site-footer container">
        <p>Horizonte <span aria-hidden="true">|</span> Education Skills for Copilot</p>
        <nav aria-label="Informações legais"><a href="#privacy">Privacidade</a><a href="#terms">Termos</a></nav>
      </footer>
    </>
  );
}
