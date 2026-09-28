Da demonstração para produção
=============================

Este documento descreve requisitos futuros, não controles já certificados.
O contrato v1 em ``API.txt`` e ``shared\contracts.ts`` opera com dados
sintéticos, persona docente fixa e destinos simulados.

Arquitetura nativa e evolução de produção
--------------------------------------------

O Copilot nativo orquestra; o app é backend MCP e landing técnica, não clone.
As cinco camadas são ``nativeCopilot`` -> MCP autenticado -> gatekeeper
semântico -> ontologia -> agentes especialistas de referência e adaptadores
de dados. Cowork foi acessado no navegador durante a preparação. Code e
Autopilot permanecem bloqueados até confirmar disponibilidade e política
do tenant; widgets ou jobs locais não substituem esses produtos.

O backend expõe ``list_skills``, ``list_classes``,
``describe_ontology``, ``execute_skill`` e ``invoke_education_agent``.
``teacher-support`` e ``writing-coach`` são especialistas genéricos
REFERENCE, com Azure OpenAI real e evidências sintéticas, não serviços do
cliente. Validar a entrega antes de atestar disponibilidade. Adaptadores
legados são sintéticos; não há Fabric nativo. O GPT-5.4-mini provisionado é
``referenceAI``, independente dos modelos selecionados pelo Copilot nativo.

As opções abaixo são desenho de produção, **não integrações implementadas**
nem infraestrutura entregue por estes templates:

* **Dados governados:** um lakehouse pode consolidar histórico e métricas;
  federação pode consultar fontes autorizadas sem copiar tudo; ingestão pode
  atender requisitos de atualização, qualidade e rastreabilidade. Escolher
  por fonte, latência, custo, retenção e permissão, não como pacote obrigatório.
  Fabric é uma opção a avaliar, não o backend nativo desta demonstração.
* **Contexto de trabalho:** documentos, comunicação e tarefas autorizados
  podem complementar o contexto pedagógico por contratos próprios, como uma
  integração futura com Work IQ quando disponível/licenciada. Não confundir
  esse contexto com armazenamento analítico ou permissão irrestrita de leitura.
* **Agentes operacionais:** orquestram tarefas e executores com escopo mínimo,
  evidências e aprovação humana antes de escrita real. Um agente não ganha
  acesso por existir uma conexão ao lakehouse ou ao contexto de trabalho.
  O job localmente definido é somente harness diagnóstico opcional;
  Autopilot nativo é dono das agendas, somente leitura e rascunhos para
  revisão humana, sem envio externo.
* **Autenticação e autorização:** Entra, identidade do usuário, isolamento
  por tenant e política por linha atravessam todos os módulos; são controles
  distintos da identidade gerenciada dos serviços e do código de acesso DEMO.

Hoje o gatekeeper semântico próprio valida escopo da turma, relações do grafo
e rotas de skills/adaptadores sobre dados sintéticos. Ele executa de fato,
mas não entrega Fabric nativo, lakehouse, federação, ingestão real ou contexto
Microsoft 365. Evoluir cada módulo exige contratos e testes separados.

Portões obrigatórios
--------------------

Antes de qualquer dado real, exigir aprovação institucional, avaliação de
segurança e privacidade, finalidade documentada e critérios de aceitação.
Não remover simplesmente ``simulated: true`` de um adaptador.

Na conexão nativa, o manifesto Microsoft 365 v1.28 declara
``agentConnectors.remoteMcpServer.authorization`` com
``type: OAuthPluginVault`` e ``referenceId``. Registro seguro no vault do
Developer Portal, consentimento e política do tenant são portões obrigatórios.
Não usar ``None``, token na URL ou bearer colado no Copilot.
O backend valida JWT Entra v2, audiência, tenant, escopo, aplicativo chamador e
lista explícita de usuários. O mapeamento de múltiplos professores e turmas
reais ainda exige evolução: a persona desta demonstração é sintética e fixa.
Veja `configuração nativa <native-copilot.rst>`_.

* **Identidade:** Entra com validação de emissor, audiência, tenant e sessão.
  A chave compartilhada DEMO não identifica professores individualmente.
* **Autorização:** acesso docente por linhas, escola/turma e tenant em cada
  consulta e mutação, inclusive no servidor MCP, no armazenamento e no job.
  Não confiar em ``teacherId`` enviado pelo cliente.
* **Isolamento:** chaves lógicas, consultas, cache, logs, evidências e rascunhos
  devem impedir mistura entre tenants. A UAMI é identidade do serviço,
  não autorização pedagógica do usuário.
* **Dados:** base legal e finalidade sob LGPD, minimização, retenção,
  descarte, atendimento a direitos e responsabilidades contratuais.
* **Menores:** melhor interesse, acesso estritamente necessário, revisão por
  responsáveis institucionais e regras apropriadas para dados de crianças
  e adolescentes. Não tratar consentimento genérico como solução universal.
* **Operação:** limites de custo, incidentes, recuperação, observabilidade,
  testes de isolamento e de falha, e decisão explícita sobre região e
  processamento global.

GlobalStandard e dados
----------------------

A aplicação fica em ``brazilsouth``; o recurso do modelo em ``eastus2`` usa
``gpt-5.4-mini``, versão ``2026-03-17``, ``GlobalStandard``, capacidade 10.
Isso não promete residência do processamento nessa região ou no país.
O uso permitido nesta demonstração permanece **exclusivamente sintético**.
Produção depende de avaliação formal de transferência, localização,
contratos, retenção e requisitos aplicáveis; não basta mudar o nome da região.

Contrato mínimo para cada conector real
---------------------------------------

Defina, revise e teste os seguintes itens antes de habilitar uma API externa:

Serviços independentes de IA de produção integram-se por contratos de API
aprovados, não por cópia dos agentes REFERENCE nem de fontes confidenciais.
Credenciais ficam fora do repositório; nomes de clientes, identificadores
reais de assinatura e mapeamentos privados não pertencem a esta documentação.

.. list-table::
   :header-rows: 1
   :widths: 27 73

   * - Área
     - Pré-requisito verificável
   * - Responsabilidade
     - Dono do sistema, finalidade, escopo de dados e autorização institucional.
   * - API
     - Versão suportada, endpoints permitidos, esquemas, paginação,
       limites, timeouts, erros e política de mudança.
   * - Permissões
     - Escopos mínimos de leitura e escrita separados; identidade técnica
       e autorização docente/tenant verificadas no servidor.
   * - Semântica
     - Mapeamento versionado de entidades, relacionamentos e identificadores;
       unidade, período, origem e atualização de cada métrica.
   * - Evidência
     - Proveniência, data da coleta, validade e identificação da versão da
       fonte; restrições de acesso preservadas em resumos e citações.
   * - Retenção
     - Prazos para fonte, cache, prompts, respostas, rascunhos, auditoria,
       backups e exclusão, com justificativa e responsável.
   * - Segurança
     - Credenciais fora de código e logs, rotação, allowlist de destinos,
       validação de conteúdo e resistência a instruções maliciosas na fonte.
   * - Escrita
     - Operações explicitamente permitidas, aprovação vinculante, idempotência,
       concorrência, verificação do resultado e compensação quando possível.
   * - Falhas
     - Retentativa limitada e segura, reconciliação de resultado incerto e
       comunicação clara; nunca retornar sucesso sem confirmação.

O v1 não aceita URLs arbitrárias, scripts, SQL, caminhos de arquivos,
``teacherId`` ou escritas brutas. Preserve essa fronteira ao evoluir:
conteúdo de uma evidência é dado, nunca autorização ou instrução executável.
O fato de MCP ser somente leitura não elimina riscos de vazamento.

Aprovação para escrita real: versão, hash e ator
------------------------------------------------

**Estado atual:** ``PATCH /api/actions/:id`` recebe ``content`` e ``version``;
aprovar e rejeitar recebem ``version``. Conflitos retornam 409. A aprovação
atinge somente o destino simulado. ``AuditEvent.actor`` existe, mas não é
vínculo enterprise entre uma pessoa autenticada e o conteúdo exato.
A API atual não recebe hash nem implementa essa vinculação de produção.

**Requisito futuro antes de qualquer chamada downstream de escrita:**

1. Congelar a representação canônica da operação, incluindo conteúdo,
   destino, tenant, contexto autorizado e versão; calcular seu hash.
2. Mostrar ao aprovador o conteúdo exato e seus efeitos, com evidências.
   Vincular aprovação ao hash, versão, identidade Entra do ator, instante,
   escopo de autorização e prazo de validade.
3. No executor, verificar novamente identidade/autorização, aprovação,
   hash e versão contra a operação prestes a ser enviada.
   Mudança de conteúdo ou destino invalida a aprovação anterior.
4. Usar idempotência e controle de concorrência no sistema de destino.
   Registrar solicitação, decisão e resultado confirmado, sem expor segredos.
5. Em timeout ou resultado incerto, reconciliar antes de repetir. Não assumir
   que ausência de resposta significa ausência de escrita.

ETags no Blob evitam colisões de persistência, mas não substituem hash
aprovado, identidade humana, autorização nem confirmação do sistema externo.
Um evento de auditoria sozinho também não torna o histórico imutável.

Limites pedagógicos
-------------------

Não fazer diagnóstico clínico, rotular estudantes ou atribuir capacidade fixa.
Não inferir aprendizagem a partir de cliques, tempo de uso, frequência de
acesso ou volume de mensagens. Métricas de uso medem uso, não domínio.

Apresente hipóteses pedagógicas com evidências observáveis, incerteza,
contrapontos e proposta de verificação docente. Não automatize notas,
encaminhamentos sensíveis, sanções ou decisões de alto impacto.
O campo/widget ``diagnosis`` é apoio à análise do cenário, não licença para
diagnosticar pessoas. Reescrita deve preservar autoria e permitir revisão.

Rotinas nativas e artefatos
------------------------------

Opt-in deve ter finalidade, turma, cadência e revogação visíveis. Desabilitar
uma regra deve impedir novas preparações dessa regra; revisar separadamente
rascunhos já existentes. Jobs não ganham autorização para aprovar por serem
agendados. Considere expiração e revalidação das evidências antes de executar.

Code nativo produz ferramentas e artefatos a partir do contexto autorizado;
não está limitado aos três widgets legados. Sua disponibilidade não foi
confirmada: bloquear o percurso em vez de emular Code no app. Widgets e modo
``code`` legados são apenas harness, não a experiência principal. Execução
de artefatos requer controles de isolamento, permissões e revisão adequados.

Autopilot nativo controla agendas opt-in, consultas somente leitura e
rascunhos com revisão humana, sem outbound. O job Azure é diagnóstico:
``deployDemoScheduler=false`` é padrão Bicep e não remove nem desabilita
jobs existentes; não há switch novo no script de implantação.

Critérios de aceite futuros
---------------------------

* Negar leitura e escrita entre tenants e entre turmas não autorizadas.
* Negar aprovação por ator sem permissão, versão antiga ou hash divergente.
* Impedir bypass de aprovação por MCP, job, chamada direta ou replay.
* Detectar origem/evidência vencida e indisponibilidade do provedor.
* Não trocar LIVE por GUIDED silenciosamente.
* Demonstrar restauração, descarte, revogação e reconciliação sem dados reais
  nos ambientes de teste.

Esta lista é um plano de verificação, não relato de testes executados.
