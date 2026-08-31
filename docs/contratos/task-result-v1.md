# TaskResult v1

## O que é

`TaskResult v1` é a resposta pública do OverCore para uma tarefa já aceita. Ele pode comunicar sucesso,
falha terminal, bloqueio recuperável ou cancelamento. Uma rejeição estrutural do `TaskRequest` acontece
antes da criação da tarefa e, portanto, não é um `TaskResult`.

```text
TaskRequest aceito
        |
        v
execução e verificação
        |
        +--> succeeded
        +--> blocked -- resume-same-request ------> retoma a mesma taskId
        |          `-- replacement-request-required -> novo Preflight e nova taskId
        +--> failed
        `--> cancelled
```

## Estados

| Estado | Significado |
| --- | --- |
| `succeeded` | Todos os critérios do pedido passaram com evidência. |
| `blocked` | A tarefa permanece recuperável, mas falta uma condição que o OverCore não pode criar sozinho. |
| `failed` | A recuperação automática terminou ou a falha foi classificada como terminal. |
| `cancelled` | A interrupção foi solicitada pelo cliente, política, runtime ou prazo. |

`blocked` não encerra a tarefa. Um resultado posterior só usa a mesma `taskId` quando o modo é
`resume-same-request`. Se a resposta muda objetivo, autoridade, critério, recurso ou orçamento, o modo
é `replacement-request-required` e nasce outro Preflight, outro pedido e outra tarefa. `resultId`
identifica cada resposta emitida.

## Campos principais

| Campo | Função |
| --- | --- |
| `resultId` | Identifica esta emissão do resultado. |
| `requestId` | Liga o resultado à solicitação recebida. |
| `requestFingerprint` | Prova qual conteúdo exato do pedido foi executado. |
| `taskId` | Identifica a tarefa persistente, inclusive entre bloqueio e retomada. |
| `stateRef` | Liga a emissão à revisão, transição e sequência exatas do `Task State`. |
| `reportedAt` | Momento em que esta resposta foi formada. |
| `status` | Estado comunicado ao cliente. |
| `summary` | Explicação curta; nunca substitui evidência. |
| `criteria` | Resultado de cada critério do `TaskRequest`. |
| `evidence` | Evidências sanitizadas, identificadas e vinculadas por digest. |
| `artifacts` | Referências imutáveis ao que foi produzido. |
| `effects` | Efeitos externos tentados e seu estado observável. |
| `execution` | Métricas e tempos da execução, sem raciocínio interno. |

## Vínculo com o pedido

`requestFingerprint` usa `sha256-jcs-v1`: SHA-256 do `TaskRequest` serializado segundo a forma JSON
canônica adotada pelo contrato. Isso impede que um `requestId` seja reutilizado para um conteúdo
diferente sem que a divergência apareça.

O conjunto de `criteria[].criterionId` deve ser exatamente o conjunto recebido em
`TaskRequest.acceptanceCriteria`. Critério ausente não é interpretado como aprovado.

## Evidência, artefato e efeito

São conceitos diferentes:

```text
EVIDENCE = observação que sustenta uma afirmação
ARTIFACT = objeto produzido ou preservado
EFFECT   = mudança realizada sobre um recurso autorizado
```

Exemplo: um arquivo alterado é um artefato; a leitura posterior de seu conteúdo é uma evidência; a
gravação confirmada é um efeito. Uma mensagem dizendo “terminei” não cumpre nenhum desses papéis.

Cada efeito expõe `effectKey` e `intentFingerprint`. A primeira é a identidade lógica estável consultada
antes de repetir uma operação; o segundo prova qual intenção exata foi reservada. A emissão referente
à revisão atual projeta o conjunto completo do journal de efeitos daquela revisão, até o mesmo limite
de 256 itens do estado interno. Não existe paginação nem omissão silenciosa de efeito; uma futura
compactação exigirá outro contrato explícito.

Quando um efeito confirmado é compensado, o resultado público projeta o original como `rolled-back`,
preenche `compensationEffectRef` e inclui o efeito compensador confirmado. Isso descreve o resultado
líquido para o cliente. O journal interno não apaga nem rebaixa o fato original: ele continua
`confirmed`, e o novo efeito aponta para ele por `compensatesEffectRef`. Essa projeção é bidirecional:
um compensador confirmado no journal obriga `rolled-back` e a referência exata no resultado; sem esse
compensador, o resultado não pode inventar rollback.

Cada emissão, inclusive histórica, projeta o journal **na revisão indicada por `stateRef`**. O estado e
as evidências de cada efeito vêm da última origem já encerrada naquela revisão; uma origem criada ou
atualizada depois não pode alterar retroativamente um resultado antigo.
Uma auditoria completa usa o snapshot ou log correspondente à revisão referida. Quando só existe um
snapshot posterior e uma origem atravessa as duas revisões, ele prova presença e identidade, mas não
autoriza inventar qual era o estado intermediário; essa parte permanece não verificável até recuperar
a revisão histórica.

O resultado guarda resumos, digests e referências. Saída extensa, logs ou recibos completos ficam em
artefatos com sensibilidade e retenção próprias. Segredos, conversa bruta e raciocínio interno não
entram no envelope.

## Bloqueio

`inputRequired` informa ao cliente:

- qual `blockId` identifica esta ocorrência específica;
- qual `mode` informa se a tarefa atual pode retomar ou se uma nova admissão é obrigatória;
- que tipo de condição falta;
- por que ela é necessária;
- qual pergunta precisa ser resolvida;
- opções conhecidas e consequências;
- impacto de permanecer bloqueado;
- evidência que comprovou o bloqueio.

O OverCore não inicia conversa direta com o usuário. O cliente decide como apresentar a questão.
No modo `resume-same-request`, restaurar a condição original permite continuar a mesma tarefa. Uma
opção alternativa ainda pode abandonar essa retomada e abrir outro pedido. No modo
`replacement-request-required`, nenhuma resposta reabre a tarefa antiga: o cliente deve formar novo
Draft e executar novo Preflight.

## Falha e cancelamento

`failure` contém categoria, resumo sanitizado e evidências. Como `failed` é terminal,
`failure.retryable` deve ser `false`: retry acontece antes da transição terminal. Erro bruto fica fora
do resultado público.

`cancellation` registra quem iniciou a interrupção e sua evidência. Na projeção atual, `initiatedBy`
repete exatamente o iniciador persistido no estado interno. Cancelar não apaga efeitos já confirmados;
eles continuam em `effects` para permitir compensação e auditoria.
Se uma chamada já estava em voo e não pôde ser reconciliada antes da parada, `cancelled` pode preservar
o efeito como `unknown`. Essa honestidade é permitida apenas no cancelamento; `succeeded` e `failed`
exigem classificação definitiva.

## Invariantes além do JSON Schema

1. O fingerprint corresponde exatamente ao `TaskRequest` ligado por `requestId`.
2. IDs de critérios, evidências, artefatos e efeitos são únicos em cada resultado.
3. Toda referência aponta para uma entidade existente no envelope ou no pedido correspondente.
4. Critérios `passed` ou `failed` possuem evidência; `not-run` não inventa evidência.
5. `succeeded` exige todos os critérios `passed`.
6. Cada efeito usa recurso e operação concedidos pelo `TaskRequest`.
7. `succeeded` e `failed` não contêm efeito `unknown`; a incerteza exige reconciliação ou bloqueio.
8. Evidências e artefatos foram capturados até `reportedAt`.
9. `finishedAt` existe apenas para estados terminais e não antecede `startedAt`.
10. `checkpointArtifactRef`, quando presente, aponta para um artefato do tipo `checkpoint`.
11. `stateRef` aponta para a revisão e transição que produziram esta emissão.
12. Sequências de emissão crescem; a repetição de um terminal devolve o mesmo `resultId`.
13. `execution.durationMs` é o tempo operacional acumulado, excluindo espera em `blocked`.
14. Um efeito `rolled-back` aponta para seu único compensador confirmado e nunca para si próprio; a
    presença ou ausência desse vínculo coincide nos dois sentidos com o journal interno.
15. `inputRequired.blockId` e `mode` repetem o bloqueio histórico que produziu a emissão.
16. Tentativas, paralelismo, duração, tokens, custo e timestamps projetam a revisão referida do estado.
17. Toda emissão contém exatamente os efeitos visíveis na revisão referida, com estado e evidências da
    última origem encerrada até aquela revisão.
18. Em resultado cancelado atual, `cancellation.initiatedBy` coincide com o estado interno.
19. O artefato apontado por `checkpointArtifactRef` repete o digest do checkpoint interno.

`startedAt` é o início da primeira tentativa e pode não existir quando nenhuma tentativa entrou em
`running`. Planejamento, verificação e cancelamento contam em `durationMs`; o deadline continua
correndo no relógio real durante bloqueios.

## Fora deste contrato

- eventos intermediários e streaming de progresso;
- implementação física do ledger e da máquina de estados;
- agente, skill, modelo, ferramenta ou procedure usados;
- formato do mecanismo de retry e recovery;
- telemetria destinada ao Oracle;
- interface com o Omni.

Essas peças serão discutidas em etapas próprias antes de entrarem no projeto.

O formato interno contratado está em
[`../internos/task-state-v1.md`](../internos/task-state-v1.md). Sua primeira persistência executável
usa PostgreSQL 18 conforme a
[`ADR-006`](../decisoes/ADR-006-fundacao-executavel-v1.md), sem alterar este contrato público.
