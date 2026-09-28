Conectar ao Copilot nativo
=========================

Este é o caminho principal da demonstração. A página Azure é técnica:
o professor continua no Microsoft Copilot, não em uma interface substituta.

Pré-requisitos
--------------

* Cowork habilitado para a conta e upload pessoal de plugins permitido.
* Backend HTTPS acessível ao serviço Microsoft 365, sem acesso anônimo ao MCP.
* App OAuth Entra registrado estaticamente, com escopo delegado
  ``api://<client-id>/access_as_user`` e access tokens v2.
* Callback Web: ``https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect``.
* Backend com ``MCP_ENTRA_TENANT_ID``, ``MCP_ENTRA_CLIENT_ID``,
  ``MCP_ENTRA_ALLOWED_OIDS`` e ``MCP_ENTRA_SCOPE=access_as_user``.
* Usuário presente no tenant do recurso, inclusive como convidado quando
  autorizado. Consentimento pode exigir administrador.

O mesmo registro atua como API e cliente OAuth nesta demonstração restrita.
O validador exige ``azp`` igual ao client ID configurado, além de assinatura,
expiração, emissor, audiência, tenant, usuário permitido e escopo. ID tokens,
tokens app-only e a chave de diagnóstico não autorizam acesso.

Registro no cofre Microsoft
--------------------------

No `Developer Portal <https://dev.teams.microsoft.com/tools>`_, abra
**OAuth client registration** e crie um registro:

* Base URL: ``https://<app-host>/mcp``.
* Restrição de organização: **My organization only**.
* Restrição de aplicativo: **Any Teams app**, conforme documentação MCP.
  Isso não elimina a autorização de usuário e cliente no backend.
* Client ID e client secret: os do registro OAuth, nunca no pacote ou GitHub.
* Authorization endpoint:
  ``https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize``.
* Token e refresh endpoint:
  ``https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token``.
* Scopes: ``api://<client-id>/access_as_user`` e ``offline_access``
  (separados conforme o controle do portal).
* PKCE: habilitado. Autenticação do cliente: parâmetros no corpo.

Salve e copie apenas o **OAuth client registration ID**. Esse é o
``referenceId`` do manifesto, não o client ID Entra nem uma credencial.
Proteja e rotacione o segredo segundo sua validade; atualizar o segredo no
Entra exige atualizar a configuração correspondente no cofre.

O schema contém ``ApiKeyPluginVault``, mas o guia específico do Cowork declara
que autenticação por API key não é suportada para MCP. O pacote usa
``OAuthPluginVault``; não há fallback anônimo.

Gerar e instalar
----------------

.. code-block:: powershell

   npm ci
   npm run build
   npm test
   npm run package:copilot -- --origin https://<app-host> --oauth-reference <vault-id>

O gerador baixa o schema oficial v1.28, valida o manifesto, verifica as cinco
skills e produz ``.runtime\horizonte-copilot.zip``. Fontes ficam em texto no
repositório; entradas ``SKILL.md`` são geradas somente dentro do ZIP.
Nenhum segredo integra o pacote.

No Cowork nativo:

1. Abra **Customize**, **Add/Upload** (ou **Plugins/Upload plugin**).
2. Selecione o ZIP; mantenha compartilhamento **Only you**.
3. Habilite as skills/conector e complete **Connect** e consentimento OAuth.
4. Inicie tarefa nova e peça: “Use Horizonte para listar as turmas sintéticas
   autorizadas e explicar a ontologia. Não invente resultados se falhar.”
5. Confirme chamadas reais a ``list_classes`` e ``describe_ontology``.
6. Peça triagem de diário via ``invoke_education_agent``/``teacher-support``;
   o especialista usa Azure OpenAI de referência, separado do modelo Copilot.

O domínio público da landing não torna o MCP público: sem token delegado
válido a chamada recebe 401 com metadados OAuth. Segredos e material interno
nunca devem ser incluídos em prompts.

Skills nativas
--------------

* ``horizonte-teacher-orchestrator``: coordenação e evidências.
* ``horizonte-lesson-rescue``: laboratório indisponível e plano alternativo.
* ``horizonte-diary-support``: triagem e oficina de escrita.
* ``horizonte-create-learning-tool``: ferramentas no Code nativo.
* ``horizonte-proactive-teaching``: objetivos e limites para Autopilot nativo.

Code e Autopilot só participam quando realmente habilitados. Instalar o
plugin no Cowork não prova disponibilidade ou compatibilidade em todas as
superfícies. Não substituir Autopilot por Cowork Automations nem por job Azure.
As skills orientam a execução; não criam agendas por si mesmas.

Fontes oficiais consultadas
--------------------------

* `Desenvolvimento de plugins Cowork
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development>`_.
* `OAuth para MCP
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth>`_.
* `Instalação pessoal
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugins>`_.
