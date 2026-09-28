Implantação Azure: contrato operacional
=======================================

Este guia descreve a interface de implantação reproduzível do projeto.
A base Azure foi provisionada durante a preparação da demo; o estado de cada
ambiente deve ser confirmado pelos outputs de sua própria implantação.
Use somente dados sintéticos e uma assinatura autorizada.

Experiência nativa e fronteira do backend
--------------------------------------------

O Copilot nativo orquestra; este app fornece backend MCP e landing técnica,
não um clone de Copilot. As cinco camadas são: ``nativeCopilot`` -> MCP
autenticado -> gatekeeper semântico -> ontologia -> agentes especialistas
de referência e adaptadores de dados. Cowork está acessível pelo navegador
durante a preparação; disponibilidade de Code e Autopilot ainda não confirmada
bloqueia esses percursos, sem emulação pela aplicação.

O contrato implementado inclui ``list_skills``, ``list_classes``,
``describe_ontology``, ``execute_skill`` e ``invoke_education_agent``.
Os especialistas genéricos REFERENCE ``teacher-support`` e ``writing-coach``
usam Azure OpenAI real com evidências sintéticas; não são serviços do cliente.
Adaptadores legados continuam sintéticos, sem Fabric nativo. O GPT-5.4-mini
provisionado é ``referenceAI``, separado dos modelos do Copilot nativo.
Validar o contrato final antes de declarar as ferramentas disponíveis.

Conexão nativa autenticada
--------------------------

O manifesto Microsoft 365 v1.28 usa
``agentConnectors.remoteMcpServer.authorization`` com
``type: OAuthPluginVault`` e ``referenceId``. API-key auth não é suportada para
MCP no Cowork, mesmo que apareça no schema. O backend valida JWT Entra v2 e
lista explícita de usuários; nunca use ``None`` ou token na URL.
Complete registro e consentimento conforme `conexão nativa <native-copilot.rst>`_.
O gerador ``npm run package:copilot`` exige a referência real do vault.

Recursos e limites previstos
----------------------------

.. list-table::
   :header-rows: 1
   :widths: 25 75

   * - Recurso
     - Configuração
   * - Resource group
     - Já existente; padrão ``rg-education-ai-horizonte``; prefixo ``horizonte``.
       O script não cria resource groups.
       Nomes globais incorporam ``uniqueString`` do resource group.
   * - Azure Container Registry
     - Basic; conta admin desabilitada; acesso de serviço por identidade/RBAC.
   * - Container Apps
     - Ambiente existente Consumption em ``brazilsouth``; aplicação com HTTPS,
       0,25 vCPU, 0,5 GiB, mínimo 0 e máximo 1 réplica.
   * - Container Apps Job
     - Harness diagnóstico opcional, não Copilot Autopilot.
       0,25 vCPU, 0,5 GiB; retry 1; timeout 180 segundos.
       Entrada ``node dist/server/job.js``; erro encerra com código não zero.
   * - Agenda
     - Autopilot nativo é dono das agendas da experiência.
       O harness, se implantado deliberadamente, usa ``30 9 * * 1-5`` UTC
       (06:30 em dias úteis em ``America/Sao_Paulo``), somente para diagnóstico.
   * - Blob
     - StorageV2, Standard_LRS; container privado ``demo-state``;
       shared key desabilitada; RBAC com identidade gerenciada atribuída
       pelo usuário (UAMI). Concorrência otimista por ETags.
   * - Azure OpenAI
     - Recurso em ``eastus2``; ``gpt-5.4-mini``, versão ``2026-03-17``;
       ``GlobalStandard``, capacidade 10, ``disableLocalAuth``.
       Deployment lógico ``teacher-reasoning``.
   * - Logs
     - Retenção prevista de 30 dias. Não registrar chaves ou dados pessoais.

Container privado significa ausência de acesso anônimo ao Blob; não implica
private endpoint nem isolamento de rede já implantado. UAMI e RBAC não
substituem autenticação e autorização docente na aplicação.

A localização do recurso de modelo não restringe o processamento global.
``GlobalStandard`` não oferece aqui promessa de residência.
A quota foi consultada durante a preparação. Capacidade 10 não significa
dez tokens ou dez usuários; confirme a
unidade e a disponibilidade do SKU/modelo na assinatura.

Separação dos templates
-----------------------

``infra\main.bicep``
   Base implantada em ``rg-education-ai-horizonte``:
   preservar recursos e template, sem recriar a base para conectar o Copilot.
   Seus outputs não secretos
   fornecem os nomes/identificadores necessários à etapa da aplicação.

``infra\app.bicep``
   Fase 2: cria app e, opcionalmente, harness diagnóstico após o build no ACR.
   Recebe imagem completa e
   nomes dos recursos existentes obtidos da base.
   ``demoAccessKey`` e ``mcpAccessKey`` são parâmetros seguros, sem outputs
   de segredo. Recebe URI completa com tag explícita; o script gera tag única
   por padrão. Não reutilize tags: elas não são imutáveis no registro.

``scripts\deploy.ps1``
   Orquestra validação, infraestrutura, imagem e aplicação. O contrato
   abaixo é a interface informada; a forma interna de transportar parâmetros
   seguros deve ser revisada no script final, sem expor chaves em logs,
   linha de comando ou arquivos do repositório.

O contrato da imagem usa Node.js 24 e mantém ``ontology`` e ``skills`` na raiz
de dados da imagem, acessíveis à entrada compilada. O contrato de CI também
usa Node.js 24 para testes/build; não comprova implantação nem integração real.

Parâmetros e outputs Bicep
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

``main.bicep`` recebe somente ``location`` (padrão e único valor aceito:
``brazilsouth``). O script fixa o grupo já existente e passa a assinatura
explicitamente, sem alterar a assinatura padrão da CLI.

Outputs da base: ``location``, ``acrName``, ``acrLoginServer``,
``environmentName``, ``environmentId``, ``environmentDefaultDomain``,
``identityName``, ``identityId``, ``identityClientId``, ``storageAccountName``,
``storageBlobEndpoint``, ``storageContainerName``, ``openAiAccountName``,
``openAiEndpoint``, ``openAiDeploymentName``, ``openAiApiVersion``,
``appName`` e ``jobName``. Nenhum segredo é exportado.

``app.bicep`` recebe os nomes da base: ``acrName``, ``environmentName``,
``identityName``, ``storageAccountName``, ``openAiAccountName``, ``appName`` e
``jobName``; recebe também ``image`` (URI completa com tag),
``demoAccessKey`` e ``mcpAccessKey`` (secureString), além de
``mcpEntraTenantId``, ``mcpEntraClientId`` e ``mcpEntraAllowedOids``.
A chave MCP de diagnóstico não é aceita quando Entra está habilitado.
Parâmetros com padrão: ``location=brazilsouth``,
``storageContainerName=demo-state``, ``openAiDeploymentName=teacher-reasoning``
e ``openAiApiVersion=2025-04-01-preview``; ``deployDemoScheduler`` é booleano
com padrão ``false`` e condiciona a implantação do job diagnóstico.
É parâmetro Bicep somente, não novo switch de ``scripts\deploy.ps1``.
``false`` não remove nem desabilita jobs existentes.
Outputs: ``appName``, ``jobName``, ``schedulerDeployed`` (booleano),
``appFqdn``, ``appUrl`` e ``identityClientId``.
``jobName`` retorna o nome de entrada mesmo sem implantação do job;
não comprova existência. ``schedulerDeployed`` descreve esta implantação,
não o inventário ou estado operacional de jobs anteriores.
Endpoints/domínio não disponíveis retornam ``null``; o script rejeita outputs
obrigatórios nulos/vazios, sem inventar uma implantação bem-sucedida.

Validação local sem implantação e sem arquivo ARM intermediário:

.. code-block:: powershell

   az bicep build --file .\infra\main.bicep --stdout > $null
   if ($LASTEXITCODE -ne 0) { throw "main.bicep failed" }
   az bicep build --file .\infra\app.bicep --stdout > $null
   if ($LASTEXITCODE -ne 0) { throw "app.bicep failed" }

O build local não verifica quota, políticas Azure, capacidade regional nem
propagação RBAC. Compilar por stdout não implanta recursos nem comprova
registro ou habilitação do conector nativo.

Interface PowerShell 5.1
------------------------

.. list-table::
   :header-rows: 1
   :widths: 33 67

   * - Parâmetro
     - Uso
   * - ``-SubscriptionId``
     - Obrigatório; assinatura explicitamente escolhida pelo operador.
   * - ``-SecureWorkspacePath``
     - Obrigatório; diretório Windows absoluto, externo ao repositório,
       protegido por ACL para staging transitório de credenciais.
       Não usar diretório temporário do sistema operacional.
    * - ``-McpEntraTenantId``, ``-McpEntraClientId``, ``-McpEntraAllowedOids``
      - Obrigatórios; tenant, aplicativo OAuth/API e usuários autorizados.
       Nenhum client secret do vault é enviado ao backend.
   * - ``-CredentialsOutputPath``
     - Opcional; caminho absoluto para JSON externo protegido por ACL,
       somente se o operador decidir preservar credenciais.
   * - ``-ResourceGroupName``
     - Padrão ``rg-education-ai-horizonte``; precisa existir.
   * - ``-ImageTag``
     - Opcional; tag única gerada por padrão para o build.
   * - ``-RolePropagationSeconds``
     - Padrão 90; espera por propagação de RBAC, não garantia de propagação.

Pré-requisitos: Windows/PowerShell 5.1, Node.js 24 para trabalho local,
Azure CLI autenticada, suporte Bicep já disponível e permissões para os
recursos e atribuições de papéis. Verifique políticas, orçamento e provedores
da assinatura. Execute a partir da branch ``main``; o script deve recusar
outras branches. Este guia não instala ferramentas nem executa comandos Azure.

Exemplo para execução futura e deliberada, na raiz do projeto. Substitua
os placeholders; prepare o diretório externo com ACL restritiva. Este exemplo
não solicita persistência das credenciais:

.. code-block:: powershell

   $subscriptionId = "<subscription-id>"
   $secureWorkspace = "C:\SecureCredentials\HorizonteStaging"
   $result = & .\scripts\deploy.ps1 `
       -SubscriptionId $subscriptionId `
       -SecureWorkspacePath $secureWorkspace `
       -ResourceGroupName "rg-education-ai-horizonte" `
       -RolePropagationSeconds 90

Para preservar deliberadamente as credenciais em JSON protegido, acrescente
``-CredentialsOutputPath "C:\SecureCredentials\horizonte-demo.json"`` à mesma
invocação. Não execute duas implantações apenas para obter esse arquivo.
Não use caminho dentro do repositório, pasta compartilhada/sincronizada ou
temporário do SO. ``-ImageTag`` pode ser omitido para obter uma tag única.

O script PowerShell deve sinalizar falhas; não se usa ``$LASTEXITCODE`` como
prova de sucesso de um script PowerShell. Comandos nativos, como ``az``,
``node`` e ``npm``, exigem verificação explícita desse código.

Sequência esperada e segurança
------------------------------

1. Validar branch ``main``, assinatura explícita, resource group existente e
   caminhos externos protegidos. Se o grupo não existir, parar; não criá-lo.
   Executar ``npm ci`` previamente. O script exige Node.js 24, compila ambos
   os Bicep e roda build/testes locais antes de qualquer escrita Azure;
   testes também verificam os assets compilados. Falhas bloqueiam a implantação.
   Conferir disponibilidade de modelo/versão/SKU e quota antes de operar.
   O relato prévio do usuário não garante capacidade disponível no momento.
   Nunca substituir silenciosamente modelo ou região.
2. Preservar a base já implantada e consumir seus outputs. O script mantém
   compatibilidade técnica com o fluxo de implantação da base, mas não deve
   ser executado apenas para conectar o Copilot ou confirmar disponibilidade.
3. Aguardar a propagação de RBAC (padrão 90 segundos), executar
   ``az acr build`` com tag única; passar a URI completa com essa tag.
4. Gerar chaves independentes e preparar parâmetros seguros transitoriamente
   em ``-SecureWorkspacePath``, fora do repositório, com ACL restritiva.
   Passar somente referência ao arquivo, nunca valores de chaves em argumentos.
   Implantar app por ``infra\app.bicep`` usando a imagem construída;
   o harness diagnóstico depende do parâmetro Bicep explicitamente habilitado.
5. Remover o arquivo transitório de parâmetros em ``finally``, inclusive
   após falhas. Não registrar segredos em logs, outputs Bicep, metadados,
   histórico de comandos ou arquivos do repositório.
6. Somente após sucesso, registrar metadados **não secretos** em
   ``.runtime\deployment.json``, ignorado pelo Git. Entregar credenciais por
   objeto com ``SecureString`` separado dos logs ou, mediante opção deliberada, no JSON
   externo protegido. Nunca apresentar uma falha como implantação concluída.

Não há implantação automática via credenciais Azure no GitHub.
Uma automação futura deverá usar OIDC federado com escopo mínimo, não
segredo estático de assinatura.

Entrega e guarda de credenciais
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Sem ``-CredentialsOutputPath``, não há arquivo persistente de credenciais:
capture o retorno em ``$result``. ``DemoAccessKey`` e ``McpAccessKey`` são
``SecureString``; ``AppUrl`` e ``DeploymentMetadataPath`` não são secretos.
Consuma as chaves somente por canal seguro, sem converter para texto em logs,
transcrições ou CI. Em falha, não há retorno de chaves; uma nova execução
gera outras chaves, inclusive se a tentativa anterior já as aplicou no Azure.

Com a opção, o JSON externo contém segredos e deve manter ACL restritiva.
Proteção por ACL não é criptografia DPAPI; não usar ``Import-Clixml`` nem
tratar JSON como arquivo cifrado. Confira o esquema no script final, sem
imprimir o objeto inteiro. Guarde as chaves em local aprovado e planeje
rotação. O arquivo opcional deliberado não se confunde com os parâmetros
transitórios, que são removidos em ``finally``. O JSON deliberado é gravado
antes da fase 2 e preservado mesmo após falha, para recuperação/rotação; sua
existência não comprova implantação. Não prometa reutilização de
chaves por parâmetros que não fazem parte da interface acima.

Ambiente do servidor: API v1
----------------------------

``API.txt`` é a referência exata. Variáveis são entregues ao processo:
o comando ``npm start`` não inclui carregamento de arquivo ``.env``.
Na execução local, use ``$env:NOME`` na mesma sessão; no Azure, a configuração
do app/job deve fornecer os valores e referências a segredos.

.. list-table::
   :header-rows: 1
   :widths: 38 62

   * - Variável
     - Valor ou finalidade
   * - ``PORT``
     - ``8080``.
   * - ``DEMO_ACCESS_KEY``
     - Segredo forte obrigatório; ausência deve bloquear acesso.
   * - ``MCP_ACCESS_KEY``
     - Outro segredo forte, obrigatório para MCP remoto.
   * - ``PUBLIC_ORIGIN``
     - ``https://<container-app-fqdn>``; origem exata autorizada da aplicação.
   * - ``AZURE_OPENAI_ENDPOINT``
     - ``https://<account>.openai.azure.com/``.
   * - ``AZURE_OPENAI_DEPLOYMENT``
     - ``teacher-reasoning``.
   * - ``AZURE_OPENAI_API_VERSION``
     - ``2025-04-01-preview``; não confundir com versão do modelo.
   * - ``AZURE_STORAGE_ACCOUNT``
     - Nome da conta Blob provisionada.
   * - ``AZURE_STORAGE_CONTAINER``
     - ``demo-state``.
   * - ``AZURE_CLIENT_ID``
     - Client ID da UAMI para ``DefaultAzureCredential``.
   * - ``STATE_PATH``
     - ``.runtime\state.json`` somente na persistência local.
   * - ``AUTOPILOT_SCHEDULE``
     - ``06:30 em dias uteis (America/Sao_Paulo)``.

``AUTOPILOT_SCHEDULE`` é metadado legado do harness, não configura nem
comprova Autopilot nativo. O job diagnóstico usa persistência compartilhada
para regras opt-in e rascunhos/auditoria; não é a experiência principal.
Autopilot nativo agenda consultas somente leitura e prepara rascunhos para
revisão humana, sem envio ou escrita em sistemas externos.

No Azure, ``DefaultAzureCredential`` deve usar a UAMI com os papéis necessários
ao modelo e ao Blob; acesso à imagem também depende das permissões do ACR.
Não configure API key de Azure OpenAI, shared key de Storage ou admin do ACR
como solução alternativa a RBAC.

Verificações após uma implantação futura
----------------------------------------

* Inspecionar recursos, regiões, tags, SKU, tag da imagem e configuração
  de segredos sem imprimir valores.
* Verificar ``GET /healthz`` via HTTPS e login pelo navegador com a chave DEMO.
  Saúde HTTP sozinha não comprova modelo, armazenamento ou scheduler.
* Inspecionar ``capabilities``: modelo e persistência esperados, aviso
  sintético; executar um pedido LIVE e conferir ``model`` e ``modelNotice``.
* Testar GUIDED explicitamente; uma falha LIVE não pode virar sucesso GUIDED.
* Revisar rascunho, editar e aprovar versão exata; confirmar auditoria e
  persistência após reiniciar a aplicação.
* Confirmar disponibilidade e política do Autopilot nativo antes de testar
  agendas; verificar rascunhos, revisão humana e ausência de envio externo.
  Testes do job, se habilitado, comprovam apenas o harness diagnóstico.
* Inicializar MCP por cliente Streamable HTTP autorizado; conferir ferramentas
  somente leitura. Negar bearer ausente/incorreto e não testar por segredo na URL.

Não registrar essas verificações como concluídas sem executá-las.

Preservação operacional
-----------------------

Preservar o resource group existente, a base, o estado e a auditoria.
Revisar inventário e custos sem operações destrutivas. Desabilitar uma regra
não elimina todos os custos; ``deployDemoScheduler=false`` não altera jobs
preexistentes. Este guia não fornece receitas de exclusão.
