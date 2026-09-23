# Primeira fatia executável

## Objetivo

Provar uma tarefa completa antes de separar dezenas de componentes:

```text
TaskDraft v1
  -> executar Preflight somente de descoberta
  -> agrupar decisões previsíveis
  -> formar TaskRequest v1 pronto
  -> validar e persistir
  -> criar plano sequencial limitado
  -> selecionar um executor declarado
  -> solicitar ao Omni autorização para o plano exato
  -> validar e persistir o enforcement da decisão
  -> executar uma tentativa autorizada
  -> registrar evidência e artefatos
  -> verificar critérios de aceitação
  -> TaskResult v1
```

## Quatro módulos iniciais

### 1. Ledger da tarefa

Mantém a solicitação, o estado atual, transições, tentativas, efeitos confirmados e referências a
artefatos. O primeiro corte usa uma instância PostgreSQL dedicada ao Overcore, capaz de coordenar
trabalhadores e tarefas de muitos projetos sem espalhar o estado por bancos dos projetos atendidos.

Estados da tarefa:

```text
accepted -> planning -> ready -> running -> verifying -> succeeded
              |          |         |           |
              +----------+---------+-----------+-> blocked
              +----------+---------+-----------+-> cancelling -> cancelled
              +--------------------+-----------+-> failed
```

`failed` pode nascer de `planning`, `running`, `verifying` ou `blocked`, conforme o grafo detalhado.

`retrying` e `recovering` são ações sobre uma tentativa, não novos donos do estado global.
`blocked` retoma uma fase segura registrada; nunca salta cegamente para `running`. O cancelamento é
persistido em `cancelling`, invalida executores antigos e só vira `cancelled` após estabilizar os
efeitos em voo. O modelo completo está em [`../internos/task-state-v1.md`](../internos/task-state-v1.md).

### 2. Task Manager / Coordenador

Valida o contrato, cria um plano linear, avança o próximo passo, escolhe um executor por capacidade e
decide concluir, repetir com estratégia diferente ou bloquear.

O formato desse plano já está fechado no
[`Execution Plan v1`](../internos/execution-plan-v1.md). Ele declara operações e capacidades
necessárias, mas não escolhe agente, skill, modelo ou ferramenta concreta.

No primeiro corte, Planner, Scheduler e Router são funções internas. Só viram serviços separados
quando houver comportamento independente comprovado.

O ciclo completo, suas portas e a razão de cada etapa estão definidos em
[`../internos/task-manager-v1.md`](../internos/task-manager-v1.md). O Task Manager não mantém status
paralelo: ele calcula a próxima operação a partir dos documentos imutáveis e do `Task State`.

### 3. Executor controlado

Expõe uma porta única:

```text
execute(step, context, authority) -> outcome
```

O Harness cria o ambiente necessário, aplica autoridade, timeout e cancelamento, captura a saída e
produz recibos. Worktree é usado para mutação de repositório; não é tratado como isolamento universal.

Antes que o executor receba qualquer passo, a porta `Authority Provider` consulta o Omni e o Overcore
valida a decisão conforme [`Authorization v1`](../contratos/authorization-v1.md). O Omni decide; o
Overcore faz enforcement; o Harness não interpreta nem amplia a permissão.

### 4. Verificador

Compara o resultado real com os critérios de aceitação e as evidências exigidas. Verificação da tarefa
é parte do runtime; a futura plataforma ampla de evals fica fora do caminho crítico inicial.

## Propriedades obrigatórias

- idempotência: retomar não repete efeito já confirmado;
- cancelamento: a execução pode ser interrompida;
- limite: há timeout e número máximo de tentativas;
- rastreabilidade: conclusão aponta para evidência;
- minimização: evento não guarda segredo ou conversa bruta;
- proveniência: draft, relatório e request permanecem ligados por revisão e fingerprints;
- não ampliação: preparação não inventa contexto, autoridade ou orçamento;
- independência: nenhum componente do Omni ou Oracle é importado.

## Definition of Done do primeiro marco executável

Este DoD é do marco completo. A fundação passou a incluir Preflight persistente, retry, retomada e
cancelamento cooperativo para os três executores existentes. As provas estão nos testes locais e
gates de integração descritos no README; cada novo executor deverá comprovar essas propriedades.

1. Receber um `TaskDraft v1` e mapear decisões previsíveis antes da execução.
2. Produzir um `TaskRequest v1` somente quando os sete checks de prontidão passarem.
3. Preservar a chave idempotente executável e registrar a derivação de cada campo material do request.
4. Rejeitar resposta cruzada, proveniência divergente ou expansão de contexto, autoridade e orçamento.
5. Receber um `TaskRequest v1` válido e rejeitar um inválido.
6. Criar e validar um `Execution Plan v1` ligado ao Task State.
7. Pedir ao Omni uma decisão vinculada à revisão exata e persistir o enforcement.
8. Ativar e executar uma tarefa representativa com um executor real.
9. Bloquear um plano com ação negada, decisão expirada, revogada ou destinada a outro ambiente.
10. Cancelar uma execução em andamento — implementado para os executores existentes, com
   reconciliação e evidências pela [ADR-018](../decisoes/ADR-018-cancelamento-cooperativo-e-reconciliacao-v1.md).
11. Fazer no máximo um retry com estratégia diferente e obter nova decisão para a nova revisão.
12. Reiniciar o processo e retomar sem repetir um efeito confirmado.
13. Verificar cada critério de aceitação com evidência.
14. Devolver um `TaskResult v1` válido.

## Fora deste marco

- DAG arbitrário, branching e paralelismo geral;
- múltiplos agentes ou provedores;
- routing por custo e histórico;
- memória semântica, RAG e descoberta de skills;
- autoaperfeiçoamento completo;
- integração conversacional com Omni ou qualquer integração com Oracle;
- interface gráfica.

Esses pontos permanecem previstos como extensões, não como dependências do primeiro corte.

Antes de introduzir agentes, skills, modelos, ferramentas, capabilities ou procedures, o projeto deve
parar para definir com o proprietário: o problema real, a fronteira, o contrato, a organização física
e o teste que comprova a necessidade. A arquitetura futura não autoriza sua criação antecipada.
