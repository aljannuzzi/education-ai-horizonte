Horizonte Professor: skill-only para Fabric IQ
================================================

Este caminho usa o plugin existente **Fabric IQ**, sem novo OAuth.
O Cowork interpreta o pedido,
carrega a skill por sua descrição e usa a capacidade nativa Fabric IQ
disponível na sessão. Não é necessário escolher um ``@agent``.
O roteamento depende do host; o pacote não garante que a capacidade exista.

O manifesto v1.28 declara somente ``agentSkills``, sem ``agentConnectors``
ou ``copilotAgents``. O ID é distinto do pacote legado. Não há servidores,
registros OAuth, permissões adicionais, implantação ou publicação automática.
O pacote não inclui dados escolares, IDs de tenant ou classificações reais.

Fonte e geração
-----------------

A fonte pública é ``copilot\fabric-iq\horizonte-professor.txt``.
O gerador produz ``skills/horizonte-professor/SKILL.md`` somente dentro
do ZIP, como exige o formato nativo. Não cria arquivo Markdown separado.
As dependências existentes são Node, ``fflate`` e ``ajv-draft-04``.
Não é necessário compilar o servidor nem executar o empacotador legado.

Na raiz do repositório::

    node scripts\package-fabric-iq-skill.mjs
    npx --no-install tsx --test test\fabric-iq-package.test.ts

Saída: ``.runtime\horizonte-fabric-iq-skill.zip``, já ignorada pelo Git.
O CLI consulta o schema oficial Microsoft v1.28 por HTTPS e só grava
um novo ZIP após validação. Falha de rede/schema não é ignorada.
Uma falha não remove um ZIP anterior: use apenas a saída de uma execução
bem-sucedida. Testes unitários são offline; não simulam validação de host.

O ZIP padrão contém somente ``manifest.json``, ``color.png``,
``outline.png`` e a skill. O gerador exporta ``buildPackage(options)``
sem efeitos colaterais de importação; retorna manifesto e bytes em memória.
Uma opção ``schema`` permite validação injetada nos testes; o CLI sempre
usa o schema oficial completo. O desenho dos ícones é duplicado localmente
porque importar o gerador legado executaria trabalho OAuth/servidor.

Vínculo opcional com relatório
--------------------------------

Sem parâmetros, a skill procura o nome exato ``Horizonte Professor``.
O relatório e seu modelo semântico precisam existir e estar acessíveis;
este pacote não cria nem publica o relatório desenvolvido separadamente.

Para vincular uma implantação, execute com seu link direto autorizado::

    node scripts\package-fabric-iq-skill.mjs --report-url "https://app.powerbi.com/groups/WORKSPACE_GUID/reports/REPORT_GUID"

Substitua os dois marcadores por GUIDs válidos. Hosts aceitos:
``app.powerbi.com``, ``msit.powerbi.com`` e ``app.fabric.microsoft.com``.
O caminho deve ser ``/groups/GUID/reports/GUID``, opcionalmente com página
``/ReportSection...``. Remova parâmetros de experiência antes de usar.
Links curtos, apps compartilhados, queries, fragmentos, escapes percentuais,
portas, credenciais e parâmetros de cliente/token são rejeitados, não limpos
silenciosamente. Não passe segredos na linha de comando.

O link fica apenas em ``skills/horizonte-professor/references/REPORT.txt``
dentro do ZIP, nunca no manifesto ou fonte pública. Esse ZIP passa a conter
identificadores da implantação: mantenha-o privado e respeite sua política.
O gerador não autentica nem testa acesso ao relatório.

Uso e limites
-------------

Disponibilize o ZIP pelo mecanismo de instalação permitido no seu ambiente,
sem publicar ou compartilhar automaticamente. Habilite o plugin Fabric IQ
existente na sessão, se disponível. O pacote não concede acesso nem contorna
bloqueios de política. Não há promessa de consentimento administrativo.

Experimente pedidos naturais:

* "Prepare um plano B para a aula da Marina na 7A: laboratório indisponível."
* "Prepare a aula sobre água da Escola Horizonte usando o relatório."
* "Proponha recomposição de frações para a 7B com evidências do relatório."
* "Ajude a revisar as pendências do diário da aula que eu identificar."

Confirme que a skill é carregada, o relatório correto é localizado e uma
consulta real precede a resposta em ``Fatos``, ``Proposta`` e
``O que o professor revisa``. Sem ferramenta/resposta, espere uma limitação
explícita, não fatos inventados. Perguntas nativas ficam abaixo de 500
caracteres; pedidos maiores são divididos. Não são necessários anexos.

O roteiro toma a aula de 29/09/2026 como referência; essa data não representa
a atualização de todas as fontes. O dataset não tem relógio atualizado.
Pedidos relativos a "hoje" ou "próxima aula" exigem data/ID explícitos,
sem filtro futuro automático. Evidências são campos/tabelas/joins do modelo
semântico confirmados pela resposta, nunca travessia de ontologia presumida.
O caminho direto Data Agent/ontologia permanece separado e não é usado aqui.

Somente leitura, com revisão docente; sem escrita de notas, frequência ou
diário, buscas privadas M365 não relacionadas, remoção de rótulos,
exportação pública ou emails sem aprovação. Confidential/InternalOnly
continua valendo para conteúdo derivado. Artefatos Code são opcionais,
somente quando habilitados e permitidos. Não há job Azure simulando Autopilot.

Os links de desenvolvedor apontam ao repositório público real e ao documento
``docs/security.rst``, que descreve fronteiras e limites da demonstração;
não representam licença concedida, certificação ou termos jurídicos novos.
Validação de schema e testes locais não comprovam instalação, roteamento,
permissões ou resposta real do Fabric IQ: esses passos exigem verificação
no host com o relatório disponível.

Consumo e custo
---------------

A skill acrescenta **Consumo desta pergunta**: distingue Azure próprio não
acionado nesta rota, CU(s) Fabric ainda não informadas e créditos aproximados
da tarefa quando disponíveis. ``/cost`` não é uma API de fatura por pergunta;
se o host mostrar apenas total mensal, não atribuir esse saldo à pergunta.
Uma tarefa nova por pergunta facilita a comparação.

O painel técnico ``/costs`` permite calcular/exportar um comprovante com as
métricas e tarifas disponíveis, preservando parcelas desconhecidas. Veja
`Consumo e custo por pergunta <cost-per-question.rst>`_ para as fórmulas,
fontes, drivers de créditos e captura automática no backend instrumentado.
