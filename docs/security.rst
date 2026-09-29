Segurança do código e do ambiente
==================================

Este repositório contém uma demonstração didática com dados escolares
sintéticos. Disponibilizar o código não disponibiliza contas, capacidade
Fabric, assinaturas Azure, credenciais ou acesso ao Microsoft 365.
O projeto não é uma certificação de segurança nem uma solução pronta
para tratar dados reais de estudantes.

Fronteiras de acesso
------------------------------

* A landing técnica e ``/healthz`` não fornecem o conjunto de dados escolar.
* ``/mcp`` exige autenticação. A implantação com Entra valida assinatura,
  emissor, audiência, expiração, escopo delegado, cliente e usuário autorizado.
  A chave local de diagnóstico não substitui OAuth quando Entra está habilitado.
* APIs de diagnóstico usam uma chave gerada pelo operador, sessão, origem
  validada e CSRF. Os valores fictícios dos testes não são credenciais operacionais.
* Permissão no MCP não implica permissão no Fabric. Cada implantação configura
  identidades e acesso ao workspace e às fontes explicitamente.
* Agentes especialistas retornam sugestões; ferramentas MCP não aprovam
  registros oficiais, não enviam mensagens e não executam código arbitrário.

Segredos e artefatos
------------------------------

Nunca versionar ``.env``, tokens, client secrets, chaves, arquivos de
credenciais, dumps, logs ou capturas de ambientes reais. O ``.gitignore``
exclui artefatos conhecidos, mas não impede um ``git add --force`` nem remove
conteúdo de commits anteriores. Antes de divulgar uma nova versão, revisar
o conteúdo e o histórico alcançável, inclusive imagens e arquivos gerados.

As fontes dos diagramas são editáveis e podem conter textos não aparentes
em uma captura. Inspecione-as antes de compartilhar. Nunca inclua materiais
internos, nomes de clientes ou dados de estudantes em issues e exemplos.

Se uma credencial for publicada, revogue-a primeiro. Apagar o arquivo ou
tornar o repositório privado novamente não desfaz clones, caches ou forks.
Depois trate o histórico e os acessos afetados segundo o procedimento de incidente.

Pipeline e contribuições
------------------------------

O workflow usa runner hospedado, permissões de leitura, actions fixadas por
commit e checkout sem persistência de credenciais. Não usa
``pull_request_target``, não injeta segredos de implantação e não publica
recursos Azure automaticamente.

Publicar uma alteração de infraestrutura é diferente de executá-la.
Revisar scripts antes de usar credenciais e nunca executar contribuições
não confiáveis em um runner com acesso ao ambiente da demonstração.
O campo ``private: true`` em ``package.json`` impede publicação acidental
no npm; não determina a visibilidade do GitHub.

Relato responsável
------------------------------

Não publicar segredos, dados pessoais ou instruções de exploração contra
um ambiente real em issues públicas. Use **Security → Report a vulnerability**
quando o canal privado estiver habilitado. Se não estiver disponível,
solicite ao mantenedor um canal privado antes de transmitir detalhes sensíveis.

Para reproduzir um problema, use sua própria implantação e dados sintéticos.
Não testar carga, autenticação ou exploração em serviços de outra pessoa
sem autorização explícita.

Limites de uma revisão
------------------------------

Uma varredura sem achados não garante ausência de vulnerabilidades.
Alertas de dependências cobrem problemas conhecidos no momento da consulta.
Revisão de acesso, limites de consumo, governança de dados e monitoramento
continuam necessários em cada ambiente, especialmente antes de qualquer
uso com dados reais.
