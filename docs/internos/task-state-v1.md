# Task State v1

## O que é e por que existe

`Task State v1` é o registro operacional persistente de uma tarefa admitida. Se o processo cair, a tarefa bloquear,
o cliente cancelar ou uma tentativa precisar mudar de estratégia, é este estado que permite responder:

- em que ponto a tarefa está;
- qual `TaskRequest` imutável governa a execução;
- quais tentativas já consumiram orçamento;
- quais efeitos externos foram apenas planejados, aplicados ou confirmados;
- de qual checkpoint a retomada é segura;
- qual revisão produziu cada `TaskResult`.

Ele é um **modelo interno persistente**, não um quinto contrato público. O cliente não o cria nem o
edita. O futuro processo do Task Manager o criará somente após admitir um `TaskRequest v1` válido. O
comportamento do [`Task Manager v1`](task-manager-v1.md) está fechado, testado e já possui uma
primeira fatia executável local.

```text
TaskRequest imutável
        |
        v
Task State: planning
        |
        v
Execution Plan v1
        |
        v
Task State v1  <---- revisão esperada + comparação atômica
        |
        +---- transições
        +---- tentativas
        +---- journal de efeitos
        +---- checkpoints
        `---- referências a resultados
        |
        v
TaskResult v1
```

## O que ele referencia e o que não duplica

O vínculo `requestBinding` contém apenas `requestId` e `requestFingerprint`. Objetivo, contexto,
autoridade, critérios, orçamento e proveniência permanecem no `TaskRequest` original.

Essa separação evita duas fontes de verdade. Mudar recurso, autoridade, objetivo, critério ou orçamento
não altera o estado existente: exige novo Preflight, novo `TaskRequest` e nova `taskId`. Um
`correlationId` pode relacionar as duas tarefas sem fingir que são a mesma execução.

## Leitura rápida dos campos principais

| Campo | O que representa | Quem escreverá | Quando muda | Por que existe |
| --- | --- | --- | --- | --- |
| `taskId` | Identidade da tarefa admitida. | Admissão do Task Manager. | Nunca. | Une toda a vida operacional da tarefa. |
| `requestBinding` | Referência e fingerprint do `TaskRequest` imutável. | Admissão. | Nunca. | Impede executar silenciosamente outro pedido. |
| `stateRevision` | Versão de qualquer alteração persistida no snapshot. | Escritor autorizado do estado. | Em toda mutação. | Permite CAS e rejeita gravação baseada em leitura velha. |
| `executionEpoch` | Geração do direito de produzir efeitos. | Coordenador do runtime. | Ao invalidar executores antigos. | Impede efeito tardio depois de cancelamento ou recovery. |
| `lifecycle` | Fase operacional atual. | Coordenador. | Em transição de estado. | Diz o que pode acontecer em seguida. |
| `criterionProgress` | Situação dos critérios do pedido. | Verificador. | Quando surge evidência válida. | Impede sucesso por declaração sem prova. |
| `activePlanBinding` | Revisão do plano e enforcement do Omni atualmente ativos. | Coordenador. | Na ativação ou no replanejamento. | Impede executar outro plano ou usar autorização de outra revisão. |
| `usage` | Consumo acumulado da tarefa. | Coordenador/runtime. | Quando há consumo. | Faz orçamento sobreviver a retry e restart. |
| `ledger.transitions` | Histórico append-only de mudanças de fase. | Coordenador. | Em cada transição. | Explica como o estado atual foi alcançado. |
| `ledger.planRefs` | Histórico append-only dos planos ativados e da autorização que os habilitou. | Coordenador. | Ao entrar em `ready` com nova revisão. | Preserva qual estratégia e qual decisão do Omni governaram cada tentativa. |
| `ledger.attempts` | Estratégias que realmente entraram em execução; quando houver modelo, seu `runtimeBinding` registra motor, versão, login, sessão, modelo, consumo e evidência. | Coordenador/executor. | Ao iniciar, vincular o runtime, suspender ou encerrar tentativa. | Controla retry, orçamento e retomada sem confundir a sessão do SDK com o estado da tarefa. |
| `ledger.stepRuns` | Passos do plano que realmente começaram e, no `deliver`, a saída materializada. | Coordenador/executor. | Ao iniciar ou encerrar um passo. | Dá cursor operacional e liga a entrega lógica ao resultado real. |
| `ledger.effects` | Journal das intenções lógicas, com uma origem append-only por ciclo de aplicação. | Executor controlado. | Antes e depois de cada chamada externa mutável. | Evita repetição cega sem apagar retries anteriores. |
| `ledger.blocks` | Histórico das condições que impediram avanço. | Coordenador. | Ao bloquear. | Permite retomada explícita e auditável. |
| `ledger.checkpoints` | Pontos comprovados de retomada. | Executor/coordenador. | Ao criar checkpoint seguro. | Evita reiniciar do lugar errado. |
| `ledger.resultRefs` | Emissões públicas produzidas pela tarefa. | Emissor de resultado. | A cada `TaskResult`. | Liga resposta pública à revisão histórica correta. |

## Mapa dos estados

```text
accepted -> planning -> ready -> running -> verifying -> succeeded
                |         |         |           |
                +---------+---------+-----------+----> blocked
                |         |         |           |
                +---------+---------+-----------+----> cancelling -> cancelled
                |                   |
                `-------------------+----------------> failed

blocked -- condição restaurada --> planning | ready | verifying
```

Essa última seta só vale para bloqueio `resume-same-request`. Um bloqueio
`replacement-request-required` **não** volta a `planning`, `ready` ou `verifying`: a tarefa antiga
permanece bloqueada até ser cancelada ou encerrada como falha, e a mudança material nasce em novo
Preflight, novo `TaskRequest` e nova `taskId`.

| Estado | Significado |
| --- | --- |
| `accepted` | O pedido foi admitido, a identidade foi reservada e ainda não há tentativa. |
| `planning` | O plano limitado está sendo preparado ou corrigido. |
| `ready` | Um plano exato foi ativado por CAS e pode iniciar ou retomar uma tentativa. |
| `running` | Uma tentativa lógica está executando. |
| `verifying` | A tentativa terminou a ação e está provando os critérios. |
| `blocked` | Falta condição externa; a tarefa continua recuperável. |
| `cancelling` | O cancelamento já foi persistido e novos efeitos estão proibidos. |
| `succeeded` | Todos os critérios passaram e nenhum efeito está indefinido. |
| `failed` | A recuperação acabou ou a falha terminal foi provada. |
| `cancelled` | A execução parou e os efeitos em voo foram classificados. |

`retrying` e `recovering` são ações, não estados globais. Um retry volta ao planejamento e só abre nova
tentativa quando a estratégia realmente mudou. Uma retomada restaura a mesma tentativa e o mesmo
orçamento quando o bloqueio não mudou o pedido.

## Transições permitidas

```text
nulo        -> accepted
accepted    -> planning | cancelling
planning    -> ready | blocked | failed | cancelling
ready       -> running | blocked | cancelling
ready       -> ready somente por authorization-refreshed, preservando o mesmo plano
running     -> verifying | planning | blocked | failed | cancelling
verifying   -> succeeded | planning | blocked | failed | cancelling
blocked     -> planning | ready | verifying | failed | cancelling
cancelling  -> cancelled
```

`succeeded`, `failed` e `cancelled` são terminais. Saltos como `accepted -> running`,
`running -> succeeded`, reabrir terminal ou retomar cegamente de `blocked -> running` são inválidos.

A fase sozinha não basta: o gatilho também precisa explicar a transição. A matriz normativa é:

| Transição | Gatilho permitido |
| --- | --- |
| `nulo -> accepted` | `admission` |
| `accepted -> planning` | `planning-started` |
| `planning -> ready` | `planning-completed` |
| `ready -> running` | `execution-started` |
| `running -> verifying` | `verification-started` |
| `verifying -> succeeded` | `verification-passed` |
| qualquer origem válida `-> blocked` | `block-detected` |
| `blocked -> planning/ready/verifying` | `condition-restored` |
| `ready -> ready` com novo enforcement para o mesmo plano | `authorization-refreshed` |
| `running/verifying -> planning` | `retry-scheduled` |
| qualquer origem cancelável `-> cancelling` | `cancellation-requested` |
| `cancelling -> cancelled` | `cancellation-settled` |
| origem autorizada `-> failed` | `recovery-exhausted`, `terminal-failure` ou `policy` |

Assim, escrever `verifying -> succeeded` com gatilho `policy` não transforma uma decisão política em
prova de sucesso.

## Concorrência: revisão e fence

Cada mutação recebe uma nova `stateRevision`. O escritor deve informar a revisão que leu; a gravação
só acontece se ela ainda for a atual. Isso é comparação e troca, ou **CAS**. Uma gravação operacional
produz exatamente a revisão seguinte; saltar números esconderia mutações que nunca foram persistidas.
Todo subregistro criado nessa gravação nasce marcado com a mesma revisão atual.

```text
escritor A lê revisão 8 ---- grava revisão 9: aceito
escritor B lê revisão 8 ---- tenta revisão 9: conflito; precisa reler
```

`executionEpoch` é um segundo cadeado. Ele muda quando o direito de executar precisa ser invalidado,
por exemplo em cancelamento ou recuperação após queda. Uma ação antiga pode possuir um
`stateRevision` obsoleto e um epoch vencido; nenhum dos dois autoriza novo efeito.

Na primeira fatia executável, PostgreSQL implementa essa propriedade com transação, CAS e outbox.
O contrato continua independente do banco: outra implementação teria de preservar a mesma garantia.

### Fronteira de comandos do primeiro corte

A decisão é **fail-closed**: um `kind` desconhecido é rejeitado, e um verbo conhecido só entra nos
estados declarados abaixo. Todo comando mutável informa `expectedRevision`; comandos que tocam
execução informam também `expectedExecutionEpoch`.

| Comando | Estados admitidos |
| --- | --- |
| `update-progress` | `accepted`, `planning`, `ready`, `running`, `verifying`, `blocked` |
| `start-attempt` | `ready`, somente com plano, enforcement persistido, fingerprint e validade correspondentes |
| `reserve-effect` | `running`, com `effectId` e novo `originId` globalmente único; efeito existente precisa estar `not-applied` |
| `apply-effect` | `running`, com origem atual e ação coberta pelo enforcement; efeito `journaled` exige revogação conferida no dispatch |
| `dispatch-action` | `running`, `verifying`, com ação permitida, controles satisfeitos e autorização ainda válida |
| `reconcile-effect` | `running`, `verifying`, `blocked`, `cancelling`, com `effectId` e `expectedOriginId` da última origem |
| `complete-attempt` | `running`, `verifying` |
| `request-cancellation` | qualquer estado não terminal, exceto `cancelling` |
| `mark-cancellation-quiesced` | `cancelling`, somente sem tentativa ou efeito em voo |
| `settle-cancellation` | `cancelling`, somente depois de `quiesced` persistido |

Durante `cancelling`, somente reconciliação do que já estava em voo e fechamento do cancelamento são
admitidos. Esta é a fronteira mínima do `Task State v1`, não a implementação do futuro Task Manager;
novos comandos exigirão ampliação explícita do contrato e dos casos adversariais.

### Gate de autorização ligado

`activePlanBinding.authorizationBinding` guarda somente a identidade verificável do crachá temporário:
`enforcementId`, fingerprints do enforcement e da decisão, expiração e revisão de ativação. O conteúdo
do crachá pessoal continua no Omni.

```text
start-attempt / dispatch-action
        |
        +--> mesmo plano e mesma revisão?
        +--> mesmo enforcement persistido e fingerprint?
        +--> ainda está válido?
        +--> ação consta como permitida?
        +--> controles foram satisfeitos?
        `--> journaled: revogação está ativa agora?
                    |
             sim -> admite
             não -> rejeita sem executar
```

Expiração ou revogação impedem trabalho novo. Reconciliação e cancelamento continuam disponíveis para
estabilizar com segurança algo que já estava em voo; revogar não apaga o mundo nem abandona efeito
incerto.

Revisão e epoch não distinguem dois ciclos dentro da mesma tentativa. Por isso `originId` é um terceiro
fence: `apply-effect` e `reconcile-effect` só alcançam a última origem do efeito. Um comando atrasado da
origem 1 não pode agir sobre a origem 2 mesmo quando ambas compartilham tentativa e epoch. Ao reservar,
o novo `originId` precisa ser inédito em todo o ledger e é persistido atomicamente com o vínculo da
tentativa. Se a origem já estiver `applying`, `apply-effect` é repetição cega e será rejeitado; somente
`reconcile-effect` pode classificar o que ocorreu.

### Quatro números que não são a mesma coisa

| Número | Escopo | Avança quando | Exemplo |
| --- | --- | --- | --- |
| `stateRevision` | Snapshot inteiro. | Qualquer dado persistido muda, mesmo sem trocar de fase. | Reservar um efeito pode levar a revisão 5 sem criar transição. |
| `transition.sequence` | Histórico de lifecycle. | A tarefa troca de estado. | `ready -> running` pode ser a transição 4. |
| `emissionSequence` | Respostas públicas da tarefa. | Um novo `TaskResult` é emitido. | `blocked` é emissão 1; sucesso posterior é emissão 2. |
| `executionEpoch` | Autoridade de execução. | Executores antigos precisam perder o direito de agir. | Cancelamento troca epoch 1 por 2. |

Por isso os números podem ter valores diferentes. A revisão 15 pode conter a transição 9, a emissão 2
e ainda estar no epoch 1. Nenhum deles deve ser usado como substituto dos outros.

## Tentativas

Uma tentativa é uma estratégia que entrou de fato em `running`:

- `planRef` aponta para a revisão imutável que governa a tentativa;
- `ordinal` começa em 1 e é consecutivo;
- `attemptCount` conta somente tentativas que chegaram a `running`;
- no primeiro marco existe no máximo uma tentativa ativa;
- bloqueio e restart não criam tentativa nova por si só;
- retry fecha a tentativa anterior e exige novo `attemptId` e `strategyFingerprint` diferente;
- consumo de duração, tokens e custo nunca volta a zero ao retomar.

Uma tentativa suspensa pode ser retomada pelo checkpoint. Se a estratégia precisar mudar, ela é
fechada como falha e uma nova tentativa consome o próximo lugar no orçamento.
Cada nova tentativa recebe `executionEpoch` estritamente maior que todas as anteriores. Assim um
executor da tentativa antiga não recupera autoridade apenas porque aprendeu a revisão mais recente.

Os estados de tentativa também são monotônicos:

```text
active -> awaiting-verification -> completed
   |             |\
   +-> suspended-+ +-> failed | cancelled
```

Uma tentativa `suspended` pode voltar a `active`; `completed`, `failed` e `cancelled` são fatos
terminais e não podem ser reescritos. `attempt.effectRefs` e `effect.attemptRefs` formam um vínculo
bidirecional: nenhum dos lados pode citar trabalho que o outro lado omite. Como o primeiro marco é
sequencial, uma tentativa posterior só começa depois de `endedAt` da anterior.

O relógio também segue a proveniência: cada step run acontece dentro da janela de sua tentativa, e
cada origem de efeito acontece dentro da janela do step run que a declarou. Um ID correto com horário impossível
continua sendo um histórico inválido.

Checkpoint vinculado a tentativa também nasce depois que ela começa, antes que termine e numa revisão
que pertence à vida observada da própria tentativa.

### Materialização da entrega

`outputRefs` prova quais saídas lógicas do plano o passo produziu. Para o passo `deliver`, isso ainda
seria insuficiente: um ID como `output-readme-delivery` não prova que um arquivo chegou ao resultado.
Por isso `deliveryBindings` registra, para cada saída final:

- o `outputRef` planejado;
- o `TaskResult` que a publicou;
- tipo, mídia, destino e schema contratados;
- os artefatos concretos, quando a forma de saída os exige.

O vínculo precisa coincidir com o `Execution Plan`, apontar apenas artefatos do ledger e reaparecer no
resultado público. Em `repository-change`, o destino também possui efeito confirmado. Assim, sucesso
não pode ser declarado com uma “entrega de papel” que existe somente como nome interno.

`ledger.planRefs` e `ledger.stepRuns` também são append-only. Uma ativação já registrada não troca de
plano, fingerprint, revisão ou autorização; um passo terminal não troca de tentativa, plano, ação, saída, evidência
ou horário. Passo concluído materializa exatamente as saídas planejadas. Um `verify` concluído carrega
evidência real para as saídas de evidência previstas, e uma ação `journaled` concluída possui exatamente
um efeito lógico correspondente, com uma ou mais origens e a última delas terminal. Falha ou passo em
aberto impede iniciar seu sucessor.

## Efeitos e idempotência

Um efeito mutável deve entrar no journal **antes** da chamada externa:

```text
reserved -> applying -> confirmed
                    |-> not-applied
                    `-> unknown
```

`applying` nunca volta diretamente a `reserved`. `unknown` só pode permanecer desconhecido ou ser
reconciliado como `confirmed`/`not-applied`. Depois que `not-applied` comprova que nada ocorreu, a mesma
intenção pode voltar a `reserved` na tentativa atual ou numa tentativa posterior, desde que revisão,
epoch, autoridade, precondições e checkpoint sejam revalidados. O registro continua sendo o mesmo e
não finge que a execução anterior desapareceu.

Campos que separam intenção de execução:

- `effectId`: identidade deste registro;
- `effectKey`: chave lógica estável, reutilizada depois de restart ou retry;
- `intentFingerprint`: conteúdo exato da intenção;
- `attemptRefs`: lista ordenada e sem repetição das tentativas que trabalharam sobre a intenção;
- `executionOrigins`: histórico append-only dos ciclos reais de reserva e aplicação;
- `state`, `updatedAt`, `lastUpdatedRevision` e `evidenceRefs`: espelho exato da última origem; provas
  anteriores permanecem dentro das origens históricas;
- `planRef`, `stepRunRef`, `actionRef`, `executionEpoch` e `recordedAt` no nível do efeito: aliases
  imutáveis da **primeira** origem, mantidos para identificação histórica; nunca autorizam o ciclo atual.

Cada item de `executionOrigins` possui:

- `originId` e `ordinal`: identidade única e ordem `1..N` do ciclo;
- `attemptRef`, `planRef`, `stepRunRef` e `actionRef`: proveniência autorizada daquele ciclo;
- `executionEpoch`: fence apresentado por aquele executor;
- `recordedAt` e `recordedAtRevision`: instante e revisão em que a reserva nasceu;
- `state`, `updatedAt`, `lastUpdatedRevision` e `evidenceRefs`: evolução e prova daquele ciclo.

```text
efeito lógico: mesma effectKey
  |
  +-- origem 1 / tentativa 1 / plan r1 -> not-applied
  |
  `-- origem 2 / tentativa 2 / plan r2 -> reserved -> applying -> confirmed
```

Uma origem representa um **ciclo de reserva**, não apenas uma tentativa. Por isso a mesma tentativa pode
aparecer em mais de uma origem depois que o ciclo anterior terminou em `not-applied`; `attemptRefs`
continua sem duplicatas e apenas resume quais tentativas participaram.

Regras essenciais:

1. `confirmed` é fato histórico e nunca é apagado ou repetido.
2. Encontrar `applying` após queda exige leitura de reconciliação.
3. `not-applied` permite executar depois que a ausência foi comprovada.
4. `unknown` proíbe repetição cega e impede tanto `succeeded` quanto `failed`; primeiro é preciso
   reconciliar ou bloquear. `cancelled` pode preservá-lo para registrar honestamente que o efeito não
   pôde ser classificado antes da interrupção.
5. Compensar cria outro efeito autorizado com `compensatesEffectRef`; não reescreve o efeito original.
   A v1 admite no máximo um compensador por efeito, não admite cadeias de compensação e só permite
   reservar o compensador depois de o alvo estar comprovadamente `confirmed` em revisão anterior.
6. Cancelar não significa desfazer automaticamente efeitos confirmados.
7. Nova origem só pode ser acrescentada depois de a anterior terminar em `not-applied`; origem anterior
   terminal não muda mais.
8. Repetição na mesma tentativa conserva o epoch. Origem em tentativa diferente usa epoch maior, para
   invalidar o executor anterior.
9. A tentativa da nova origem pode ter sido criada antes da reserva, mas precisa ser a tentativa ativa,
   usar o plano e step run correspondentes e possuir o epoch atual.
10. Cancelamento congela também `executionOrigins`; reconciliação pode fechar a origem em voo, mas não
    acrescenta um novo ciclo.
11. `updatedAt` é monotônico: nem o efeito agregado nem uma origem já existente podem voltar no tempo
    quando a revisão avança.

A v1 limita cada efeito a **20 ciclos de aplicação**. Esse número é um teto próprio do journal, não
`budget.maxAttempts`: uma tentativa pode conter mais de um ciclo. Ao alcançar o teto, nova reserva é
rejeitada com `task-state-effect-origin-limit-reached`; o coordenador precisa concluir com o que foi
provado ou encerrar a recuperação como falha, sem apagar ciclos para abrir espaço.

Se o efeito já está `confirmed` e uma falha posterior exige replanejamento, o plano novo **omite a
mutação** e consome o efeito confirmado como fato/checkpoint. A v1 não cria origem de “reuso” nem
repete a escrita; essa extensão só será considerada se aparecer um caso real que não caiba na regra.

Quando há retry, ele não cria uma segunda `effectKey`: acrescenta uma nova `executionOrigin` ao mesmo
efeito lógico depois que `not-applied` foi comprovado. Se outra tentativa participar, ela também entra
uma única vez em `attemptRefs`. Assim o histórico preserva cada ciclo e cada plano sem duplicar a
intenção idempotente nem reescrever sua origem anterior.

Isso oferece execução idempotente. Não promete “exactly once” quando o sistema externo não fornece
chave idempotente nem leitura confiável do estado.

## Bloqueio e retomada

Cada ocorrência possui `blockId`, revisão, evidência e `resumeTarget`. Existem dois modos:

- `resume-same-request`: a condição original foi restaurada; a mesma `taskId` pode continuar;
- `replacement-request-required`: a resposta mudaria campo material; a tarefa antiga não é
  reescrita e uma nova cadeia Draft → Preflight → Request precisa nascer.

`resumeTarget` volta para uma fase segura (`planning`, `ready` ou `verifying`), nunca diretamente para
`running`, e só pode ser aplicado no modo `resume-same-request`. No modo
`replacement-request-required`, o `resumeTarget` registra apenas onde a tarefa poderia ter retomado
se o pedido não tivesse mudado; ele não autoriza a retomada da tarefa antiga. O runtime precisa
revalidar revisão, epoch, checkpoint e journal antes de produzir efeito.
O alvo também não salta à frente do ponto onde o bloqueio nasceu: `planning` retoma em `planning`;
`ready` pode voltar a `planning/ready`; `running` volta no máximo a `ready`; `verifying` pode voltar a
qualquer uma das três fases seguras.

Quando o bloqueio nasceu em `running` ou `verifying`, as referências precisam concordar: bloco e
checkpoint usam o mesmo `attemptId`; o checkpoint já existia na revisão e no horário do bloqueio; e o
`resumeTarget` do bloco é igual ou mais conservador que o checkpoint (`planning < ready < verifying`).
Cada bloco histórico continua ligado ao próprio checkpoint sem ser reescrito, enquanto
`attempt.checkpointRef` aponta para o checkpoint mais recente daquela tentativa. Sem essa coerência,
“retomar” seria apenas um salto para um ponto possivelmente errado.
Ao sair de `blocked`, `condition-restored.triggerRef` aponta especificamente para o bloco da entrada
imediatamente anterior — nunca para outro bloqueio antigo da mesma tarefa.

## Cancelamento seguro

Cancelamento não é um salto imediato para `cancelled`:

1. persistir a solicitação;
2. incrementar o fence e entrar em `cancelling`;
3. impedir novas tentativas e reservas de efeito;
4. pedir parada cooperativa do trabalho ativo;
5. classificar efeitos em voo como `confirmed`, `not-applied` ou `unknown`;
6. quando não houver tentativa não terminal nem efeito `reserved`/`applying`, persistir `quiesced`;
7. em uma mutação posterior, entrar em `cancelled`.

O novo `executionEpoch` deve ser maior que o epoch anterior e que o de todas as tentativas existentes.
Depois de `cancellation.requestedAt`, nenhuma tentativa pode começar e nenhuma intenção de efeito pode
ser reservada. Entre revisões consecutivas, a presença do cancelamento também congela o conjunto de
`attemptId`, `effectId` e `effectKey`: retrodatá-los não burla a regra. O trabalho já em voo pode
somente parar e classificar o que realmente ocorreu.
Um efeito que ainda estava `reserved` pode permanecer assim até ser classificado ou virar
`not-applied`; ele não pode começar (`applying`) depois da linearização. Somente um efeito que já
estava `applying` pode ser reconciliado como `confirmed`, `not-applied` ou `unknown`.
Se ainda houver tentativa ativa durante `cancelling`, `activeAttemptId` precisa identificá-la; quando
ela para, o ponteiro desaparece.

Se sucesso foi linearizado primeiro, um cancelamento atrasado não reabre a tarefa. Se o cancelamento
venceu a corrida, uma conclusão atrasada usa revisão/epoch antigos e é rejeitada.

## Checkpoint

Checkpoint guarda referência, digest, fingerprint do pedido, revisão, tentativa, fase de retomada e
último efeito confirmado conhecido. Ele preserva contexto operacional, mas não substitui o journal:
um arquivo de checkpoint sozinho não comprova que o efeito aconteceu no sistema externo.
`latestCheckpointRef` aponta para o checkpoint mais recente de toda a tarefa; cada
`attempt.checkpointRef`, para o mais recente daquela tentativa.

Quando existe tentativa, o checkpoint também registra `planRef` e `resumeStepRef`. Ele pode retomar o
mesmo plano no passo comprovado; não atravessa automaticamente para uma revisão nova.

Antes de uma ação mutável ser reservada, já deve existir um checkpoint do mesmo plano e tentativa que
autorize retomar no passo da mutação. Assim o sistema não descobre somente depois do efeito que não
sabe de onde recuperar.

## Relação com TaskResult

`TaskResult.stateRef` contém a revisão, a transição e a sequência de emissão que produziram a resposta.
O Ledger registra a referência inversa em `resultRefs`.

```text
Task State blocked   -> TaskResult blocked
Task State succeeded -> TaskResult succeeded
Task State failed    -> TaskResult failed
Task State cancelled -> TaskResult cancelled
```

Um resultado terminal é idempotente: repetir a leitura devolve o mesmo `resultId`. Um `blocked` pode
ser sucedido por outro resultado; a sequência cresce e `supersedesResultId` deixa a ordem explícita.
Revisão, `emissionSequence` e horário de emissão crescem na mesma ordem. Uma emissão nunca antecede a
transição que a produziu, e nada pode ser emitido depois de um resultado terminal.
Quando `execution.checkpointArtifactRef` existe, o artefato público e o checkpoint interno repetem o
mesmo ID **e o mesmo digest**; acertar o nome e trocar o conteúdo não é uma projeção válida.

Evidências e artefatos públicos não podem anteceder `execution.startedAt` nem ultrapassar
`reportedAt`. Quando uma evidência é atribuída a um step run, `capturedAt` precisa cair dentro da janela
desse passo. O resultado não pode apresentar como prova algo observado antes da execução ou depois do
verificador que afirma tê-lo produzido.

`failed` é terminal e, portanto, `failure.retryable` deve ser `false`. Retry ocorre antes da transição
terminal. Se depois for necessária uma nova execução, ela nasce como nova tarefa — não reabre a falha.

Quando uma compensação aparece no `TaskResult`, a visão pública projeta o efeito original como
`rolled-back` e aponta `compensationEffectRef` para o efeito compensador, que também é listado como
`confirmed`. No journal interno, o fato original permanece `confirmed`; um segundo efeito confirmado
aponta de volta por `compensatesEffectRef`. Assim a API comunica o resultado líquido sem reescrever a
história operacional.

## Exemplo completo, revisão por revisão

O cenário em
[`../../internos/exemplos/task-state-succeeded.json`](../../internos/exemplos/task-state-succeeded.json)
mostra uma alteração que bloqueia, retoma e termina com sucesso:

```text
rev 1   accepted
rev 2   planning
rev 3   ready
rev 4   running; tentativa 1 iniciada
rev 5-6 intenção de efeito registrada e chamada iniciada
rev 7   blocked; checkpoint + TaskResult blocked (emissão 1)
rev 8   ready; condição externa restaurada
rev 9   running; mesma tentativa retomada
rev 10-12 nova origem reservada, aplicada e confirmada
rev 13  verifying
rev 14  critérios confirmados
rev 15  succeeded + TaskResult succeeded (emissão 2)
```

As lacunas na sequência de transições não são lacunas de auditoria: são revisões que alteraram journal,
checkpoint ou critérios sem mudar o lifecycle. O resultado de bloqueio continua ligado à projeção da
revisão 7; ele não é reinterpretado usando o snapshot final da revisão 15.

## Métricas temporais

- `acceptedAt`: admissão da tarefa;
- `startedAt` no `TaskResult`: início da primeira tentativa, se alguma entrou em `running`;
- `finishedAt`: transição terminal;
- `lastTransitionAt`: horário da transição que gerou a emissão;
- `activeDurationMs`: tempo operacional acumulado fora de `blocked`;
- `TaskResult.execution.durationMs`: projeção de `activeDurationMs` na revisão emitida;
- deadline: continua correndo em tempo de parede mesmo durante bloqueio.

Planejamento, verificação e cancelamento contam como tempo operacional. Espera por condição externa em
`blocked` não conta. Assim a métrica mede trabalho, enquanto o deadline mede tempo real.

## Invariantes além do JSON Schema

1. O último `transitionId` e seu destino correspondem ao estado atual.
2. Sequências e revisões crescem sem lacunas reescritas.
3. A mesma `taskId` nunca troca de request ou fingerprint.
4. IDs, ordinais, `effectKey` e sequências de emissão são únicos no escopo da tarefa.
5. Toda referência aponta para registro existente.
6. No máximo uma tentativa está ativa ou aguardando verificação.
7. `usage.attemptCount` corresponde às tentativas que entraram em `running`.
8. Retry usa estratégia diferente e respeita o orçamento do `TaskRequest`.
9. A identidade de tentativa, efeito, origem de execução, bloqueio e cancelamento já registrado não é reescrita.
10. Consumo de duração, tentativas, paralelismo, tokens e custo é monotônico e respeita o orçamento.
11. Efeito confirmado, transição passada e emissão pública são append-only.
12. Escrita exige `expectedRevision`; comandos de execução exigem também `executionEpoch` atual e os
    comandos de efeito usam `originId` como fence do ciclo.
13. Resultado da revisão atual repete exatamente `taskId`, request, conjunto e estado dos efeitos,
    iniciador de cancelamento quando aplicável e revisão da projeção, sem omissão silenciosa.
14. Timestamps respeitam a ordem causal; marcadores de subregistro acompanham a revisão que os mudou.
15. Efeito interno e público usa apenas recurso e operação concedidos pelo `TaskRequest`.
16. Estado só nasce de `TaskRequest` admitido; `decisions-required` e `not-feasible` não criam tarefa.
17. Cancelamento avança o epoch antes de impedir novas tentativas e reservas de efeito.
18. Estado de origem e tentativa não regride; o resumo do efeito só volta de `not-applied` a `reserved`
    quando uma nova origem é anexada, e fatos terminais não são reescritos.
19. Bloco, checkpoint e tentativa de uma retomada operacional concordam entre si.
20. Resultados seguem a ordem causal e nenhuma emissão sucede um terminal.
21. Subregistro novo nasce na revisão atual; revisões operacionais não pulam gerações.
22. Cancelamento não permite iniciar um efeito que ainda estava apenas reservado.
23. Checkpoint público e interno possuem identidade e digest iguais.
24. Tentativas sequenciais não se sobrepõem e ponteiros de checkpoint nunca ficam para trás.
25. Retomada não avança além da fase segura alcançada antes do bloqueio.
26. Comando desconhecido ou conhecido no estado errado é rejeitado antes de mutar o estado.
27. `condition-restored` retoma exatamente o episódio de bloqueio que está sendo encerrado.
28. Cada origem, sua tentativa, step run e checkpoint causal apontam para a mesma revisão imutável; a
    origem corrente também concorda com o plano ativo.
29. `planRefs` e `stepRuns` crescem por acréscimo; identidades e fatos terminais não são reescritos.
30. Step runs formam um prefixo sequencial do plano, permanecem dentro da janela da tentativa, não se
    sobrepõem e um passo não concluído bloqueia seu sucessor no primeiro corte.
31. Passo concluído produz exatamente as saídas planejadas; verificação concluída possui evidência real.
32. Ação journaled concluída possui exatamente um efeito lógico correspondente; origens anteriores estão
    `not-applied` e a última possui desfecho terminal admitido.
33. Cada origem mutável possui checkpoint causal com horário anterior e revisão não posterior à reserva.
34. `succeeded` referencia tentativa concluída que executou todos os passos do plano ativo.
35. O `deliver` concluído materializa todas as saídas planejadas no resultado e nos artefatos públicos
    compatíveis com a forma contratada.
36. Cada efeito possui uma única chave lógica e uma sequência append-only de origens; resumo e tentativas
    são projeções exatas, enquanto cada origem preserva suas próprias evidências, plano, passo, ação,
    epoch, horários e revisões.
37. Uma nova origem nasce somente depois de `not-applied`; na mesma tentativa conserva o epoch e em nova
    tentativa usa epoch maior. Cancelamento impede acrescentar origem.
38. `originId` cerca cada ciclo: reserva exige ID novo; aplicação e reconciliação exigem o ID da última
    origem, impedindo ABA mesmo quando tentativa e epoch não mudaram.
39. Um efeito novo nasce em revisão própria com uma única origem `reserved`, sem evidências; aplicação
    ou confirmação só pode ocorrer em revisão posterior.
40. `originId` é único em todo o ledger, e `updatedAt` nunca regride entre revisões.
41. `compensatesEffectRef` faz parte da identidade imutável do compensador; a v1 admite um único
    compensador por alvo, após confirmação causal do alvo, e não admite cadeia de compensações.
42. Plano ativo e entrada histórica carregam exatamente o mesmo `authorizationBinding`.
43. A autorização nasce na mesma revisão da ativação, ainda válida, e não pode ser reaproveitada por
    outra revisão do plano.
44. `start-attempt`, `apply-effect` e `dispatch-action` exigem o enforcement persistido e seu fingerprint.
45. Dispatch só admite ação explicitamente permitida e depois de comprovar todos os controles exigidos.
46. Ação `journaled` consulta a revogação no instante do dispatch; ausência, divergência ou revogação
    falha fechada sem começar o efeito.

Os vetores adversariais em
[`../../internos/testes/task-state-domain-mutations.json`](../../internos/testes/task-state-domain-mutations.json)
registram essas rejeições sem escolher linguagem de runtime. As corridas de CAS, epoch e cancelamento
estão em
[`../../internos/testes/task-state-action-cases.json`](../../internos/testes/task-state-action-cases.json).

## Glossário mínimo

| Termo | Definição neste projeto |
| --- | --- |
| Snapshot | Retrato completo e persistido da tarefa em uma revisão. |
| Ledger | Conjunto auditável de históricos e referências da tarefa. |
| Journal | Registro antecipado da intenção de efeito e de seu desfecho observado. |
| Fence | Número que invalida ações de uma geração antiga. |
| Epoch | Geração corrente do direito de executar. |
| CAS | Gravação aceita somente se a revisão lida ainda for a atual. |
| Quiesced | Sem tentativa ativa nem efeito em estado `reserved` ou `applying`. |
| Linearização | Ponto persistido que decide qual evento venceu uma corrida. |
| Idempotência | Repetir a mesma intenção lógica sem duplicar seu efeito. |

## O que ainda não foi escolhido

- banco, formato físico do Ledger e estratégia de compactação;
- linguagem, SDK e API;
- executores, agentes, skills, modelos e ferramentas;
- leases distribuídos, filas e DAG;
- motor automático de compensação;
- transporte e implementação executável da porta `Authority Provider` que consultará o Omni;
- integração com Oracle.

Também fica reservada para o futuro contrato de plano/tentativa a projeção canônica que forma
`intentFingerprint`. A projeção canônica de `strategyFingerprint` já foi fechada no
[`Execution Plan v1`](execution-plan-v1.md). A intenção concreta ainda deverá conter somente campos
semanticamente materiais; nonce, timestamp ou outro detalhe cosmético não poderá fingir que existe
efeito novo.

O snapshot final demonstra o estado atual e aponta para as emissões anteriores, mas não carrega por si
só o conteúdo integral de toda revisão intermediária. A futura persistência física deverá conservar
essas revisões ou um log equivalente para sustentar auditoria histórica sem lacunas.

Essas decisões permanecem para as próximas etapas, discutidas uma a uma.
