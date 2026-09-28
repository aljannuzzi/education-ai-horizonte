Horizonte: AI para quem ensina
=============================

**O professor trabalha no Copilot. Os sistemas trabalham juntos.**

Horizonte é uma demonstração de educação com dados sintéticos. Sua arquitetura
de referência combina **Copilot nativo, skills, MCP, ontologia no Fabric IQ,
Fabric Data Agent e agentes educacionais especializados**. O objetivo é reduzir
a fragmentação entre informações, tarefas e sistemas sem criar mais um portal
para o professor.

Este README define a arquitetura final e o contrato do pattern. Não é um
relatório de provisionamento. Recursos, permissões e capacidades necessários
à execução estão descritos como pré-requisitos, não como certificação de
disponibilidade em qualquer ambiente.

O pattern completo
------------------

.. code-block:: text

   PROFESSOR
      |
      v
   COPILOT NATIVO
   Home / Chat / Cowork | Code | Autopilot
      |                                |
      | contexto de trabalho           | skills de educacao
      v                                v
   Microsoft 365 / Work IQ        CONECTOR MCP NO AZURE
   documentos e colaboracao      identidade, contratos e escopo
                                       |
                         +-------------+-------------+
                         |                           |
                         v                           v
                  FABRIC DATA AGENT           AGENTES ESPECIALISTAS
                  consulta governada          suporte / escrita / outros
                         |                           |
                         v                           |
                  ONTOLOGIA FABRIC IQ <--- contexto e evidencias
                  entidades, relacoes,
                  significado e proveniencia
                         |
                         v
                  DADOS GOVERNADOS
                  OneLake / Lakehouse
                  ingestao ou federacao autorizada
                         |
                         v
                  FONTES EDUCACIONAIS
                  registros | atividades | materiais | espacos

**Caminho principal:** Copilot nativo -> skills/MCP -> Fabric Data Agent e
ontologia Fabric IQ -> dados educacionais governados.

**Caminho especializado:** Copilot nativo -> skill/MCP -> agente educacional,
recebendo somente o contexto autorizado e as evidências necessárias.
As respostas especializadas voltam ao Copilot para composição e revisão.

O desenho representa responsabilidades e fluxo lógico; não implica que todos
os componentes sejam um único serviço. O Data Agent não é tratado como um
executor genérico de agentes externos. A orquestração desses agentes pertence
às skills e aos contratos de integração.

Responsabilidade de cada camada
------------------------------

**Copilot nativo: a experiência do professor**
   Chat atende consultas; Cowork executa trabalho delegado; Code cria
   ferramentas adequadas à tarefa; Autopilot acompanha objetivos de forma
   persistente e proativa. Não são abas reimplementadas por Horizonte.
   A adaptação da experiência acontece nas capacidades nativas disponíveis.

**Skills: o procedimento pedagógico**
   Definem quando consultar evidências, qual especialista acionar, como
   compor a resposta e quais decisões exigem revisão humana. Uma skill não
   substitui autorização nem transforma uma recomendação em ação aprovada.

**MCP: o contrato entre Copilot e os sistemas**
   Expõe descoberta e ferramentas com parâmetros validados. Transporta
   pedidos e resultados; não armazena a semântica como substituto do Fabric.
   Mantém contratos estáveis mesmo quando os sistemas de origem evoluem.

**Fabric Data Agent: acesso orientado à pergunta**
   Interpreta perguntas sobre dados governados e usa as fontes e a semântica
   configuradas no Fabric. A integração deve preservar permissões e
   proveniência. Respostas sem evidência suficiente devem explicitar a
   limitação, não completar números ou relações por inferência.

**Fabric IQ: semântica educacional**
   A ontologia nativa define entidades, relacionamentos e o significado dos
   dados, vinculados às fontes governadas. O contrato final exige ontologia
   e Data Agent publicados e conectados no Fabric; um grafo ilustrativo ou
   um arquivo JSON isolado não satisfaz essa responsabilidade.

**Dados e agentes educacionais: capacidades especializadas**
   Sistemas transacionais continuam sendo fontes de registro. Agentes
   especialistas continuam responsáveis por sua função. A integração
   reúne essas capacidades sem presumir que um agente deva ser reescrito
   ou que todos os sistemas compartilhem a mesma base.

Ontologia: de tabelas a significado
----------------------------------

O domínio conecta **Professor, Turma, Aula, Habilidade Curricular, Atividade,
Evidência, Material, Espaço Escolar, Pendência e Intervenção Pedagógica**.

.. code-block:: text

   Professor -- leciona --> Turma -- possui --> Aula
   Aula -- desenvolve --> Habilidade Curricular
   Atividade -- avalia --> Habilidade Curricular
   Atividade -- produz --> Evidencia -- fundamenta --> Intervencao
   Aula -- utiliza --> Material
   Aula -- depende de --> Espaco Escolar
   Pendencia -- afeta --> Aula
   Intervencao -- propoe --> Material / Atividade / Rascunho

Uma **habilidade curricular** descreve uma aprendizagem. Uma **skill de AI**
descreve um procedimento executável. São conceitos distintos.

As relações permitem responder perguntas que nenhum sistema isolado resolve:
qual objetivo preservar quando o laboratório fecha, que evidência justifica
retomar frações ou se uma pendência resulta de calendário, registro ou suporte.

Cada evidência deve conservar fonte, período, granularidade, identificador e
versão da regra aplicável. Indicadores mantêm numerador e denominador.
**Acesso à plataforma, atividade concluída e presença não equivalem a
aprendizagem demonstrada.**

Ingestão, federação e contexto de trabalho
----------------------------------------

O pattern não exige copiar tudo para um único banco.

* **Ingestão:** consolida dados quando histórico, qualidade e atualização
  controlada justificam materialização em OneLake/Lakehouse.
* **Federação ou referências a dados:** utiliza mecanismos suportados pela
  fonte e pelo Fabric, com credenciais e permissões governadas. Não significa
  que qualquer sistema possua API pública ou acesso sem cópia.
* **Contexto Microsoft 365:** materiais e colaboração autorizados complementam
  o trabalho pelo Copilot/Work IQ. Não substituem a ontologia dos dados.
* **Integração de agentes:** invoca serviços por contratos aprovados, limitando
  contexto, ferramentas e permissões. Estar ligado a um lakehouse não concede
  autoridade para agir em sistemas externos.

Nesta demonstração, registros, turmas, textos e situações escolares são
sintéticos. Os agentes de suporte e escrita são referências genéricas.
Conectar sistemas reais exige APIs, contratos e autorização institucional.

Uma pergunta, vários sistemas, uma resposta
------------------------------------------

1. O professor expressa um objetivo no Copilot nativo.
2. A skill identifica a turma e o escopo autorizado.
3. MCP encaminha a consulta ao Data Agent, fundamentado na ontologia Fabric IQ.
4. O resultado reúne evidências dos dados governados, com sua proveniência.
5. Quando necessário, a skill aciona um agente especialista com esse contexto.
6. Copilot compõe explicação, alternativas e um artefato adequado ao trabalho.
7. O professor revisa; qualquer ação externa segue autorização específica.

**Evidência, interpretação, sugestão e execução são estados diferentes.**
A resposta deve permitir reconhecer cada um, inclusive quando há falha,
informação ausente ou dados de períodos distintos.

Cenários que mostram o valor
---------------------------

**“O laboratório ficou indisponível. Como mantenho minha aula?”**
   A ontologia conecta espaço, aula, turma, objetivo curricular e materiais.
   Cowork prepara uma alternativa offline, como um escape room da água com
   materiais comuns e seguros. Um encaminhamento de suporte fica em rascunho.
   Não se afirma que uma sala foi reservada ou um chamado enviado.

**“Meu diário está pendente. É calendário, registro ou problema técnico?”**
   Copilot reúne os fatos e consulta o agente de suporte docente.
   A triagem explica dependências e prepara próximos passos. Suporte ao
   diário não significa preenchimento autônomo de frequência ou registro.

**“Quero retomar frações sem transformar alunos em rótulos.”**
   Evidências por habilidade orientam atividades e agrupamentos temporários.
   Cowork prepara estações e uma pergunta de saída; o professor decide a
   adequação. Uso de plataforma não vira diagnóstico de aprendizagem.

**“Preciso de uma ferramenta que ainda não existe.”**
   Code nativo cria, por exemplo, um organizador de estações, um laboratório
   interativo de frações ou uma oficina de rubricas, usando contexto
   autorizado. A necessidade define o artefato, não uma lista fixa de widgets.
   Credenciais nunca são embutidas no código gerado.

**“Antecipe minha semana, mas deixe as decisões comigo.”**
   Autopilot nativo acompanha um objetivo explicitamente autorizado, consulta
   evidências e prepara opções de aula, pendências e rascunhos. O professor
   define frequência, escopo, limites e condição de parada. Uma skill, sozinha,
   não cria uma agenda; um job Azure não é apresentado como Autopilot.

**“Quero uma oficina de reescrita, não uma fábrica de notas.”**
   O agente especialista relaciona texto sintético, rubrica e evidências.
   Copilot organiza feedback e alternativas de revisão, preservando a voz
   do autor. A devolutiva exige revisão docente e não publica nota automática.

Identidade, segurança e revisão humana
-------------------------------------

**Usuário e serviço têm identidades diferentes.** OAuth autentica o acesso
do Copilot ao MCP. Identidades gerenciadas e permissões específicas protegem
as chamadas Azure. Acesso ao Fabric exige configuração e autorização próprias;
um token válido no MCP não concede automaticamente acesso aos dados.

O conector nativo usa ``OAuthPluginVault``: o manifesto contém apenas a
referência da configuração de autenticação, nunca client secret ou token.
O backend valida emissor, audiência, expiração, tenant, escopo e usuário.
Autorização por professor/turma deve ser aplicada em cada fronteira relevante.

As ferramentas de consulta e os agentes de referência não alteram registros
oficiais. Para qualquer integração de escrita, o pattern exige mostrar
**destino, conteúdo exato, versão e efeito**, obter aprovação e validar essa
aprovação no serviço executor, com idempotência e auditoria.

Dados de estudantes exigem finalidade, minimização, retenção e governança
apropriadas. Não inferir condições clínicas, deficiência, contexto familiar
ou capacidade fixa. Documentos e saídas de ferramentas são dados não confiáveis,
não instruções para ampliar permissões ou executar ações.

Pré-requisitos para executar o pattern
-------------------------------------

* Ambiente Microsoft 365 com as capacidades nativas utilizadas habilitadas,
  licenciamento, política de uso e instalação do plugin compatíveis.
* Workspace e capacidade Fabric adequados, dados sintéticos governados,
  ontologia Fabric IQ e Data Agent nativos publicados e conectados pelo
  mecanismo suportado no ambiente.
* Backend Azure com HTTPS, OAuth, autorização, conectividade e identidades
  de serviço; agentes especialistas com contratos explicitamente configurados.
* Consentimento para o conector e acesso às fontes necessárias.
* Orçamento e governança para capacidade Fabric, modelos, armazenamento,
  logs e execução. Escalar uma aplicação a zero não elimina esses custos.

A disponibilidade de uma experiência Copilot não implica a disponibilidade
das demais, nem garante que um plugin instalado em uma superfície funcione
automaticamente em todas. Uma capacidade indisponível não deve ser emulada
e apresentada como nativa.

Leitura e operação
-----------------

* `Conexão do plugin ao Copilot nativo <docs/native-copilot.rst>`_.
* `Provisionamento e contratos nativos Fabric <docs/fabric-operations.rst>`_.
* `Cenários e roteiro de demonstração <docs/scenarios.rst>`_.
* `Operação Azure <docs/deployment.rst>`_.
* `Custos e dimensionamento <docs/costs.rst>`_.
* `Governança para sistemas reais <docs/production.rst>`_.

Referências oficiais
--------------------

* `Home, Code e Autopilot
  <https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/>`_.
* `Extensibilidade do Copilot
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview>`_.
* `Plugins nativos Cowork
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development>`_.
* `OAuth para MCP
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth>`_.
* `OneLake e referências a dados
  <https://learn.microsoft.com/en-us/fabric/onelake/onelake-shortcuts>`_.
* `Ontologia no Fabric Data Agent
  <https://learn.microsoft.com/en-us/fabric/iq/ontology/tutorial-4-create-data-agent>`_.
* `Endpoint MCP do Fabric Data Agent
  <https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server>`_.
