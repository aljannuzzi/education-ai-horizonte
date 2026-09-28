Cenário nativo em cinco minutos
================================================================================

Execute **dentro do Copilot nativo**, não nos modos locais do harness.
Cowork foi acessado pelo browser durante a preparação; Code e Autopilot ainda
precisam ter disponibilidade confirmada. Se produto, permissão, ferramenta
ou conexão faltar, registre a etapa como **bloqueada**, sem emular o resultado.

Antes do cronômetro
--------------------------------------------------------------------------------

Confirme o registro seguro do conector MCP no Developer Portal, referência
``OAuthPluginVault`` e política do tenant conforme `integração <native-copilot.rst>`_.
A instalação/validação nativa está pendente; não colar bearer no Copilot.
Descubra o catálogo real com ``tools/list``: são esperados ``list_skills``,
``list_classes``, ``describe_ontology``, ``execute_skill`` e
``invoke_education_agent``. Não inventar esquemas de chamada ainda não publicados.

Use exclusivamente turmas, textos e evidências sintéticos, sem identificadores
de clientes ou estudantes reais. Os especialistas ``teacher-support`` e
``writing-coach`` são referências genéricas com Azure OpenAI real, não serviços
de produção do cliente. O modelo ``referenceAI`` é separado dos modelos nativos.

0:00–1:00 — Cowork: contexto e evidências
--------------------------------------------------------------------------------

No Cowork:

“Descubra as turmas sintéticas autorizadas, as habilidades e a ontologia.
Prepare minha próxima aula em vinte minutos usando as evidências disponíveis.
Separe fatos, sugestões e incertezas; mostre a origem de cada observação.”

Copilot orquestra MCP autenticado, gatekeeper, ontologia e agentes/adaptadores.
Inspecione evidências e percurso semântico; métricas não são fatos inventados
pelo modelo. Não apresentar execução Fabric nativa.

1:00–2:00 — Cowork: especialista pedagógico
--------------------------------------------------------------------------------

“Use o agente de referência teacher-support para investigar a pendência no
diário: calendário, aula realizada ou suporte técnico? Mostre a evidência e
prepare uma proposta de encaminhamento. Não escreva no diário nem envie nada.”

A atividade pode ser offline; o serviço não promete funcionar sem internet.
O docente revisa a adequação. Não inferir diagnóstico clínico ou capacidade
fixa; métricas de uso não medem aprendizagem.

2:00–3:00 — Cowork: devolutiva de escrita
--------------------------------------------------------------------------------

“Use writing-coach para sugerir uma devolutiva a um texto sintético: uma
qualidade observável, uma pergunta e duas opções de revisão. Preserve a voz
do autor, indique evidências, não atribua nota nem envie a ninguém.”

A geração de IA é somente leitura dos registros: devolve sugestões, não
correção oficial. Se LIVE falhar, mostrar a falha; não substituir por GUIDED.

3:00–4:00 — Code: criar ferramenta com contexto
--------------------------------------------------------------------------------

Se Code estiver disponível, execute **nele**:

“Crie ferramenta estações usando evidências sintéticas autorizadas obtidas pelo
MCP: organize leitura, manipulação e conversa; permita ajustar duração e número
de estações. Produza os artefatos apropriados no ambiente nativo, explique
premissas e limites e não publique nem envie nada externamente.”

Code nativo produz ferramentas e artefatos usando contexto. Não limitar a
experiência aos três widgets declarativos do harness. Inspecione o artefato
efetivamente gerado e as evidências, sem prometer formato ou execução não vistos.
Se indisponível, marcar bloqueado; a landing não oferece um Code substituto.

4:00–5:00 — Autopilot: agenda nativa
--------------------------------------------------------------------------------

Se Autopilot estiver disponível, execute **nele**:

“Configure, após meu opt-in, preparação às segundas-feiras às 06:30 no meu
fuso confirmado, para a turma sintética autorizada. Consulte o MCP somente
para leitura e prepare rascunhos com evidências para revisão humana.
Não aprove, não altere registros e não envie mensagens ou conteúdo externamente.”

Confira na experiência nativa turma, fuso, cadência, permissões e opt-in antes
de ativar. A agenda pertence ao Autopilot nativo, não ao job Azure deste repo.
Se não puder configurá-la, a etapa está bloqueada. Não usar
``/api/autopilot/run`` como prova de Autopilot nativo nem de execução agendada.

Fechamento
----------

Mostre o que realmente foi consultado e gerado, o que continua sintético e o
que ficou bloqueado. As APIs legadas de aprovação são somente diagnóstico
simulado; não fazem parte desta demonstração principal. Sistemas independentes
de IA em produção exigem APIs aprovadas, contratos e credenciais fora do repo.
