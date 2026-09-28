const capabilities = [
  {
    number: '01',
    title: 'Agentes especialistas',
    text: 'Skills de educação para apoiar planejamento, análise e preparação. O professor conversa e revisa o trabalho no Copilot nativo.',
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
    text: 'Conceitos, relações e proveniência dão contexto às ferramentas. O backend usa uma ontologia customizada — não o Fabric nativo.',
    detail: 'Relações explícitas. Evidências rastreáveis.',
  },
];

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">Ir para o conteúdo</a>
      <header className="site-header container">
        <a className="brand" href="#main" aria-label="Horizonte, início">
          <span className="brand-name">Horizonte<span className="brand-dot">.</span></span>
          <span className="brand-description">Education Skills for Copilot</span>
        </a>
        <a className="header-link" href="#installation">Instalação técnica <span aria-hidden="true">↗</span></a>
      </header>

      <main id="main" className="container">
        <section className="hero" aria-labelledby="hero-title">
          <div className="eyebrow"><span className="status-dot" aria-hidden="true" /> COPILOT NATIVO · INFRAESTRUTURA EDUCACIONAL</div>
          <h1 id="hero-title">O professor trabalha no Copilot.<br /><span>Os sistemas trabalham juntos.</span></h1>
          <p className="hero-description">Horizonte conecta skills, sistemas escolares e evidências ao Copilot.
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
            <p className="flow" aria-label="Copilot nativo, via MCP, para ontologia, para agentes AI e legacy sintéticos">
              <span>nativeCopilot</span><b aria-hidden="true">→</b><span>MCP</span><b aria-hidden="true">→</b>
              <span>Ontologia</span><b aria-hidden="true">→</b><span>agentes AI + legacy <small>synthetic</small></span>
            </p>
            <p>A experiência docente é exclusivamente a do Copilot nativo. Cowork, Code e Autopilot não são
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
              <li><strong>Instalar o pacote plugin no Copilot</strong><p>O administrador deve instalar o pacote e configurar a conexão MCP protegida pelos mecanismos aprovados do tenant.</p></li>
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
