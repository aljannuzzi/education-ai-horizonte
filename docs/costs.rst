Custos: pequeno não significa gratuito
======================================

Não há estimativa monetária fechada neste guia. Preços variam por região,
moeda, contrato, data, franquias compartilhadas e consumo. Consulte os
preços oficiais no momento da decisão e acompanhe a assinatura.
Nenhum gasto real ou quota foi consultado na elaboração desta documentação.

O que compõe a conta
--------------------

.. list-table::
   :header-rows: 1
   :widths: 25 45 30

   * - Componente
     - Fator de cobrança
     - Atenção
   * - ACR Basic
     - Registro provisionado, armazenamento e builds conforme a tabela vigente.
     - Continua custando mesmo com aplicação sem réplicas.
   * - Container Apps Consumption
     - Recursos alocados por tempo e requisições, conforme franquias aplicáveis.
     - 0,25 vCPU / 0,5 GiB e min 0 / max 1 limitam escala, não a conta total.
   * - Job diagnóstico opcional
     - Recursos durante cada execução, inclusive novas tentativas.
     - Harness, não Autopilot nativo. ``deployDemoScheduler=false`` é
       padrão Bicep; não remove nem desabilita jobs existentes.
   * - Blob Storage
     - Volume, operações e transferência aplicáveis.
     - Rascunhos e auditoria persistem mesmo quando o app está em zero.
   * - Azure OpenAI referenceAI
     - Tokens de entrada/saída e demais medidores aplicáveis ao deployment.
     - GPT-5.4-mini provisionado para especialistas REFERENCE; separado
       dos modelos nativos. LIVE consome modelo com evidências sintéticas.
   * - Copilot nativo
     - Licenciamento e consumo conforme produto, contrato e tenant.
     - Cowork acessível segundo o usuário; Code/Autopilot não confirmados.
       Não presumir disponibilidade ou inclusão na conta Azure do backend.
   * - Azure Monitor / logs
     - Ingestão, retenção e consultas conforme o plano.
     - Retenção prevista de 30 dias não significa todos os logs gratuitos.

``minReplicas=0`` permite interromper cobrança de computação da réplica
quando ela efetivamente chega a zero; não desliga ACR, Blob, logs ou jobs.
Também não torna gratuitas chamadas ao modelo: LIVE é inferência real,
enquanto GUIDED é seleção explícita sem substituição silenciosa em falhas.
Requisições, sondagens externas e uso contínuo podem manter atividade.
``maxReplicas=1`` limita concorrência, mas não limita tokens por solicitação.

``GlobalStandard`` é consumo pay-as-you-go, não compromisso de capacidade
provisionada PTU. ``capacity=10`` é configuração de capacidade/quota do
deployment, não preço mensal nem reserva financeira.
O usuário relata quota verificada; não fizemos consulta nem validação
independente neste trabalho. Quota não representa crédito financeiro.

A configuração prevista separa app no Brasil (``brazilsouth``) de recurso
Azure OpenAI em ``eastus2``: ``gpt-5.4-mini``, versão ``2026-03-17``,
``GlobalStandard``, capacidade 10. Processamento global não oferece promessa
de residência no Brasil nem na região do recurso.

Modelo simples de acompanhamento
--------------------------------

Antes de operar, anote por período:

* horas de existência do ACR e armazenamento de imagens;
* segundos ativos de app e job, vCPU/GiB alocados e novas tentativas;
* solicitações e tokens de entrada/saída LIVE;
* volume e operações de Blob, crescimento de rascunhos e auditoria;
* ingestão e retenção de logs, transferência e outros medidores observados.

Multiplique cada consumo pelo medidor vigente da assinatura, considerando
franquias já consumidas por outros recursos. Não converta capacidade do
modelo diretamente em uma estimativa de tokens sem conferir a unidade.
Mantenha separado o custo do backend MCP e landing técnica Azure do
licenciamento/consumo do Copilot nativo, que orquestra a experiência.
``referenceAI`` atende agentes genéricos ``teacher-support`` e ``writing-coach``,
não representa serviços do cliente. Integrações futuras com serviços de IA
independentes exigem contratos de API aprovados, orçamento próprio e
credenciais fora do repositório; adaptadores legados são sintéticos.
Não contabilizar Fabric nativo como recurso entregue por esta demonstração.

Controles recomendados
----------------------

Defina orçamento e alertas, limites de solicitação e revisão periódica dos
medidores. Alertas de orçamento não são garantia de bloqueio de gastos.
Use prompts sintéticos curtos, observe falhas repetidas e mantenha somente
regras opt-in necessárias. Não reduza auditoria indiscriminadamente para
economizar: aplique a política de retenção aprovada.

Revise jobs, imagens, estado e logs preservando a base já implantada em
``rg-education-ai-horizonte``. ``deployDemoScheduler`` é parâmetro Bicep,
não switch do script; ``false`` não comprova ausência de jobs ou custos.
Autopilot nativo é dono das agendas da experiência e prepara somente
rascunhos para revisão humana, sem envio externo. O harness diagnóstico
não comprova disponibilidade nem substitui o produto nativo.
Veja `implantação <deployment.rst>`_; não há limpeza destrutiva neste guia.

Fontes oficiais de preços
-------------------------

Referências para consulta pelo operador. Algumas tabelas dependem de
região/moeda ou de renderização interativa; não verificamos preços nem
extraímos cotação numérica nesta revisão:

* `Azure OpenAI <https://azure.microsoft.com/en-us/pricing/details/azure-openai/>`_.
* `Azure Container Apps <https://azure.microsoft.com/en-us/pricing/details/container-apps/>`_.
* `Azure Container Registry <https://azure.microsoft.com/en-us/pricing/details/container-registry/>`_.
* `Azure Monitor <https://azure.microsoft.com/en-us/pricing/details/monitor/>`_.
* `Azure Blob Storage <https://azure.microsoft.com/en-us/pricing/details/storage/blobs/>`_.
