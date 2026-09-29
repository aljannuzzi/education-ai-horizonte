Consumo e custo por pergunta
===========================

Esta feature produz um **comprovante de consumo e estimativa**, não uma fatura.
Cada comprovante informa o caminho executado, o escopo de atribuição, as
quantidades disponíveis, as tarifas aplicadas e as parcelas ainda desconhecidas.
Não armazena o texto da pergunta, a resposta, dados de estudantes ou credenciais.

Três contas diferentes
---------------------

.. list-table::
   :header-rows: 1
   :widths: 24 40 36

   * - Parcela
     - O que gera consumo
     - Como atribuir
   * - Cowork
     - Modelo e contexto da conversa, raciocínio, ferramentas, iterações,
       artefatos e execuções de trabalho delegado.
     - ``/cost`` fornece aproximação acumulada da tarefa. Não é uma medição
       exata por ação e não corresponde ao uso do Azure OpenAI da demo.
   * - Fabric
     - Consultas e operações dos itens na capacidade, inclusive modelos
       semânticos usados pelo plugin Fabric IQ.
     - CU(s) por operação, quando disponíveis, e rateio explícito da
       capacidade. Tempo da conversa não equivale a CU(s).
   * - Azure da demo
     - Chamadas reais aos agentes próprios, modelo Azure OpenAI, execução
       do Container Apps e serviços compartilhados.
     - Tokens informados pelo provedor; tempo e recursos com base declarada;
       infraestrutura fixa em linha separada.

O caminho **Cowork + Fabric IQ nativo → Power BI** não chama automaticamente
o backend Horizonte. Portanto, Azure OpenAI e Container Apps próprios são
**não aplicáveis nessa rota**, e não zero por falta de telemetria. ACR, logs,
armazenamento, licenças e capacidade provisionada podem continuar gerando
custos mesmo quando uma pergunta não passa pelo backend.

Copilot Credits podem ser faturados em uma assinatura Azure, conforme o
financiamento configurado. Isso não autoriza somar os mesmos créditos novamente
ao total extraído de Cost Management. O comprovante separa domínios de consumo
para permitir reconciliação sem duplicação.

Fluxo no Cowork nativo
---------------------

1. Inicie preferencialmente uma tarefa nova para a pergunta da demonstração.
2. Consulte ``/cost`` antes e depois, quando o total da tarefa estiver disponível.
   O próprio comando não consome créditos.
3. Registre o total acumulado da **tarefa**, nunca a diferença do saldo mensal
   ou do limite de um grupo. Saldo compartilhado pode mudar por outros usuários.
4. Marque se a pergunta ficou isolada e se houve atividade concorrente.
   Totais atrasados, múltiplos turnos e automações prejudicam a atribuição.
5. No painel técnico ``/costs``, selecione **Cowork + Fabric IQ nativo**,
   informe as observações e, se disponível, a evidência de CU(s).
6. Aplique uma tabela de preços apropriada ao contrato, moeda e período.
   Exporte o comprovante para o local autorizado pela sua política.

``/cost`` é aproximado, posterior à execução e agregado por tarefa; não
fornece detalhamento faturado de cada operação. Se a experiência apresentar
somente consumo mensal, saldo ou nenhum total de tarefa, o campo fica
**não disponível**. Uma skill não recebe um medidor privilegiado de cobrança
nem consegue executar um comando de interface apenas por mencioná-lo.

A skill Horizonte Professor acrescenta **Consumo desta pergunta** à resposta:
declara o caminho, as chamadas observáveis e os campos que dependem dos
medidores da plataforma. Não inventa preços, créditos ou unidades Fabric.

Instrumentação do backend Azure
------------------------------

``COST_METERING_ENABLED=true`` habilita medição por operação do backend.
``/api/chat`` devolve ``costReceipt`` e o cabeçalho ``X-Question-Id``;
operações MCP devolvem o comprovante em ``_meta["horizonte/costReceipt"]``.
O escopo **tool-call** identifica uma chamada MCP: não se afirma que uma
chamada seja toda a pergunta do Cowork.

O contexto assíncrono isola requisições concorrentes. As chamadas ao modelo
capturam ``usage.prompt_tokens``, tokens de entrada em cache, tokens de saída
e tokens de raciocínio quando o provedor os informa. A captura ocorre antes da
validação da resposta; uma saída inválida pode ter consumido tokens.

Falha, cancelamento ou timeout sem ``usage`` não significa custo zero.
O comprovante conserva a lacuna e a operação continua falhando explicitamente.
Não existe fallback silencioso para modo guiado ou para uma estimativa inventada.

``COST_LOG_RECEIPTS=true`` emite eventos estruturados
``horizonte.cost.receipt`` nos logs da aplicação, sem prompts ou respostas.
No Container Apps, a retenção depende da configuração de logs do ambiente.
Esses eventos são telemetria operacional, não ledger de faturamento.
Essa captura não depende de escrever no Blob de rascunhos.

O painel também oferece **Medir uma chamada real ao Azure da demo**. Após
autenticação diagnóstica, ``POST /api/costs/probe`` executa uma pergunta sintética
fixa, sem leitura/gravação de registros escolares, e carrega o recibo. Essa ação
gera consumo normal do modelo; não simula uso nem intercepta o Copilot.
Somente essa ação explícita utiliza a API; o cálculo/importação manual fica
na memória do navegador. A chave diagnóstica não é persistida no navegador.

Variáveis de dimensionamento ``COST_CONTAINER_VCPU`` e
``COST_CONTAINER_MEMORY_GIB`` devem refletir a réplica configurada.
Tempo de parede multiplicado por esses recursos é uma **estimativa de
atribuição**, não consumo faturado por consulta: concorrência, active/idle,
franquias e escala mudam o resultado.

Tarifas e fórmulas
-----------------

A tabela padrão contém somente os preços retail públicos de Azure OpenAI
**GPT-5.4 mini Global**, em USD, região de referência East US 2, consultados
em 29/09/2026 e com vigência registrada em 01/03/2026:

.. list-table::
   :header-rows: 1
   :widths: 55 45

   * - Medidor / unidade
     - Preço por 1 milhão de tokens
   * - ``5.4 mini Inp Gl 1M Tokens``
     - USD 0,75
   * - ``5.4 mini cd Inp Gl 1M Tokens``
     - USD 0,075
   * - ``5.4 mini Opt Gl 1M Tokens``
     - USD 4,50

Fonte: `Azure Retail Prices API <https://prices.azure.com/api/retail/prices>`_.
Preço retail não é preço negociado. Não se aplicam automaticamente tarifas
Batch, Priority, Data Zone, descontos, impostos ou câmbio. Outras tarifas
ficam sem valor até configuração explícita. ``COST_PRICEBOOK_JSON`` permite
definir a tabela do backend; o painel permite ajustar sua própria estimativa.

::

   Azure OpenAI estimado =
     ((input - cached_input) * preco_input
       + cached_input * preco_cache
       + output * preco_output) / 1_000_000

   Fabric rateado =
     CU_segundos_associados * preco_capacidade_hora
       / (3600 * CUs_provisionadas)

   Creditos aproximados atribuiveis =
     total_tarefa_depois - total_tarefa_antes

   Infraestrutura compartilhada rateada =
     custo_do_periodo / perguntas_do_periodo

**Tokens de raciocínio já fazem parte dos tokens de saída:** não são somados
novamente. Se o cache não foi informado, a ausência de desconto deve estar
explícita; ela não prova cache igual a zero.

Créditos atribuíveis exigem observações coerentes e atividade isolada.
A conversão em dinheiro exige preço por crédito e condições de financiamento
do cliente. Capacity packs, P3 e PAYG não implicam o mesmo preço efetivo.

O rateio Fabric expressa uma parcela equivalente da capacidade; não comprova
aumento marginal na fatura. Ociosidade, reservas, overages e armazenamento
precisam de tratamento próprio. Em trial, custo de teste não deve ser
apresentado como custo de produção.

Exemplo aritmético, não uma consulta faturada: 1.000 tokens de entrada,
200 deles em cache, e 400 de saída, nas tarifas acima, resultam em
USD 0,002415 de inferência estimada. Isso não inclui Cowork, Fabric,
container, serviços compartilhados, impostos ou descontos.

Origem, certeza e incompletude
-----------------------------

.. list-table::
   :header-rows: 1
   :widths: 27 73

   * - Situação
     - Como interpretar
   * - Uso medido × tarifa
     - Quantidade informada pelo provedor, convertida em estimativa monetária.
   * - Aproximado nativo
     - Créditos expostos pelo Cowork, sujeitos a agregação e atraso.
   * - Rateado
     - Parte de um custo compartilhado, calculada com a metodologia indicada.
   * - Não disponível
     - O componente se aplica, mas falta quantidade, tarifa ou atribuição.
   * - Não aplicável
     - O componente não participa do caminho executado.
   * - Exemplo fictício
     - Valores de demonstração; não são telemetria nem preços contratados.

O total é apresentado como **subtotal conhecido** enquanto houver parcelas
desconhecidas. Uma tarifa não configurada e uma leitura indisponível nunca
viram zero. Nenhum comprovante desta feature é marcado como faturamento final.

Onde conferir os valores oficiais
---------------------------------

* **Cowork:** ``/cost`` e Cost Management no Microsoft 365. O Overview
  administrativo atualiza aproximadamente a cada quatro horas.
* **Fabric:** Capacity Metrics ou eventos de operações autorizados.
  Usar ``Total CU(s)`` por operação, ou ``capacityUnitMs / 1000``.
  Não somar novamente as janelas de smoothing. Correlação somente por
  usuário/horário/item é heurística e deve ser marcada como tal.
* **Azure:** métricas do serviço e Cost Management. Dados de custo chegam
  com atraso e permanecem estimados até a fatura. Não há medidor universal
  de fatura instantânea por prompt.

O modelo interno do aplicativo Capacity Metrics não é usado como uma API
customizada. Importações devem vir de fontes/exportações suportadas e
permissões já concedidas; a feature não solicita papel administrativo.

O que aumenta os créditos do Cowork
----------------------------------

O modelo selecionado, o contexto processado, o esforço de raciocínio, chamadas
de ferramentas, geração de artefatos, iterações e execuções de automações
influenciam consumo. Não existe aqui conversão fixa de “uma pergunta”,
“um minuto” ou “uma chamada de ferramenta” em créditos.

Para reduzir custo, comparar tarefas equivalentes, evitar consultas repetidas,
limitar o escopo dos dados, usar o esforço adequado e reaproveitar contexto
válido. Não sacrificar revisão humana, segurança ou proveniência para reduzir
um contador. Medir também o custo por **tarefa útil concluída**, inclusive
tentativas com erro e retrabalho.

Referências oficiais
--------------------

* `Créditos por tarefa com /cost
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-copilot-credits-cost>`_.
* `Gestão de créditos e financiamento
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-manage-copilot-credits>`_.
* `Modelos e esforço de raciocínio no Cowork
  <https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-models>`_.
* `Operações e CU(s) no Fabric
  <https://learn.microsoft.com/en-us/fabric/enterprise/fabric-operations>`_.
* `Eventos de capacidade Fabric
  <https://learn.microsoft.com/en-us/fabric/real-time-hub/explore-fabric-capacity-operation-events>`_.
* `Cobrança do Container Apps
  <https://learn.microsoft.com/en-us/azure/container-apps/billing>`_.
* `Tokens de raciocínio Azure OpenAI
  <https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning>`_.
* `Latência e reconciliação Cost Management
  <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data>`_.
