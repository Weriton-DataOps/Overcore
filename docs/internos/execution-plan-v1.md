# Execution Plan v1

## O que é

`Execution Plan v1` é o plano operacional interno criado enquanto uma tarefa admitida está em
`planning`. Ele transforma o `TaskRequest` pronto em uma sequência limitada de passos que o futuro
Task Manager poderá apresentar ao Omni, ativar quando autorizada, executar e verificar.

Ele não é uma mensagem de chat, não contém cadeia de raciocínio privada e não é uma seleção de agente,
skill, modelo ou ferramenta.

```text
TaskRequest imutável
        |
        v
Task State: planning
        |
        v
Execution Plan v1
  - recursos e operações necessários
  - ordem dos passos
  - efeitos previstos
  - evidências esperadas
  - cobertura dos critérios
  - forma da entrega
        |
        v
AuthorizationRequest -> decisão do Omni -> enforcement
        |
        v
ativação atômica -> Task State: ready
```

## Por que existe

Sem plano persistido, o executor precisaria decidir o caminho enquanto já está modificando o mundo.
Isso traz quatro problemas:

1. uma decisão previsível pode aparecer tarde e interromper a tarefa;
2. uma operação pode ultrapassar silenciosamente a autoridade recebida;
3. retry pode repetir a mesma estratégia com outro nome;
4. após queda, o runtime sabe a fase geral, mas não qual passo estava executando.

O Preflight resolve dúvidas materiais antes da admissão. O plano faz a segunda metade do trabalho:
expõe o caminho operacional inteiro para que o Omni o autorize antes da ativação e para que o
`Authorization Enforcement` do Overcore aplique a decisão antes de cada dispatch.

## O que cada camada decide

| Camada | Pergunta respondida |
| --- | --- |
| `TaskDraft` | O que já sabemos sobre a intenção? |
| Preflight | Falta alguma decisão previsível para tornar a tarefa executável? |
| `TaskRequest` | Qual objetivo, autoridade, limite e critério foram contratados? |
| `Execution Plan` | Quais passos autorizáveis levam do estado atual à comprovação? |
| `AuthorizationDecision` | O Omni autoriza este plano exato e sob quais limites? |
| `Task State` | Onde a execução está e o que realmente aconteceu? |
| `TaskResult` | Qual desfecho público pode ser provado? |

## Anatomia do plano

```text
Execution Plan
├── identidade e revisão
├── vínculo com task + request + revisão-base
├── snapshots dos recursos usados
├── fingerprints do documento e da estratégia
├── steps 1..N
│   ├── entradas
│   ├── ações declaradas
│   ├── política de efeito
│   ├── saídas esperadas
│   ├── constraints, assumptions e critérios
│   ├── timeout
│   └── checkpoint
├── cobertura de todos os critérios
└── vínculo da entrega final
```

### Identidade e revisão

`planId` identifica a linha histórica do plano. `planRevision` começa em 1 e cresce somente por uma
nova revisão imutável. Revisão maior que 1 precisa de `supersedesPlanRef` apontando exatamente para a
anterior.

O documento anterior nunca é editado nem apagado. Isso permite responder qual estratégia produziu uma
tentativa, mesmo depois de um retry.

Revisão de plano não é tentativa de execução. Corrigir um plano rejeitado antes de `running` não
consome `maxAttempts`; esse orçamento só avança quando uma tentativa realmente começa. O limite de
revisões protege o tamanho do histórico interno, não redefine o orçamento do request.

### Vínculo da tarefa

`taskBinding` contém:

- `taskId`;
- `requestId` e seu fingerprint;
- `basisStateRevision`, a revisão em `planning` usada para construir o plano.

Na ativação, a revisão-base é comparada atomicamente e a ativação deve criar exatamente a revisão
seguinte (`activatedAtRevision = basisStateRevision + 1`). Se outro planejador ou cancelamento mudou o
estado, o plano velho não entra em `ready` por acidente. Depois da ativação, o vínculo ativo do plano
substitui a revisão-base como referência; exigir eternamente a revisão antiga impediria qualquer
progresso normal.

A causalidade também é temporal: `createdAt` não pode anteceder a transição que produziu a revisão-base
nem ultrapassar o instante de ativação. O plano não pode alegar que leu um estado que ainda não existia,
nem ser “criado” depois de já ter sido autorizado.

### Snapshot dos recursos

`contextBindings` liga cada referência realmente usada a um digest observado e pode ser vazio numa
tarefa puramente interna que não use referência alguma. Quando o `TaskRequest`
já contém digest, ele é repetido como `request-digest`. Quando a referência é mutável, o snapshot vem
da admissão como `admission-snapshot`. Nesse segundo caso, `captureEvidenceRef` aponta para a evidência
persistida que comprova a captura. O horário da captura precisa ficar entre a criação do request e a
criação do plano; não basta declarar um digest sem origem auditável.

Antes de despachar uma ação externa, o runtime futuro deverá revalidar a precondição aplicável. O plano
não transforma um caminho mutável em verdade eterna; apenas registra qual base foi planejada.

## Passos lineares

A v1 usa uma cadeia, não um DAG:

```text
step 1 -> step 2 -> step 3 -> ... -> step N
```

- sequências são exatamente `1..N`;
- o primeiro passo não depende de outro;
- cada passo seguinte depende somente do anterior;
- não há branch, loop, inserção dinâmica ou paralelismo;
- cada passo possui timeout e ao menos uma ação e uma saída esperada.

Os quatro tipos são:

| Tipo | Função |
| --- | --- |
| `prepare` | Revalidar contexto, suposições e entradas necessárias. |
| `execute` | Produzir a alteração ou trabalho principal. |
| `verify` | Comprovar um ou mais critérios com evidência esperada. |
| `deliver` | Montar a forma final contratada sem inventar novo efeito. |

A ordem de fases é fechada:

```text
prepare* -> execute* -> verify* -> deliver
```

Existe exatamente um `deliver`, sempre como último passo. Pode haver mais de um passo nas três fases
anteriores, mas nenhuma fase pode voltar para trás. Isso evita executar depois de verificar ou alterar
o mundo durante a montagem da resposta final.

`inputs` podem apontar para contexto, assumption, constraint ou saída de passo anterior. Saída futura
ou inexistente é rejeitada.

## Ações e autoridade

Uma ação é mais abstrata que um comando de ferramenta. Ela declara:

- identidade estável;
- se opera num recurso do request ou internamente no runtime;
- operação necessária;
- política de efeito.

```text
ação do plano
├── request-resource -> resourceRef + operation concedida
└── runtime-internal -> operação interna fechada, sem autoridade externa
```

Descrição, prompt ou argumento nunca concede autoridade. Toda ação sobre recurso precisa caber num par
`resourceRef + operation` do `TaskRequest`. Operação sem classificação confiável falha fechada.

Ações externas mutáveis só podem existir em passos `execute`. O passo `deliver` aceita apenas ação
`runtime-internal` com efeito `none`: ele organiza a entrega, mas não ganha uma porta lateral para
produzir efeitos novos.

O plano não decide se a própria ação pode rodar. Ele alimenta o `AuthorizationRequest`; o Omni emite a
decisão e o `Authorization Enforcement` verifica teto, ação, risco, controles, validade, audiência,
atestado e revogação. A definição completa está em
[`../contratos/authorization-v1.md`](../contratos/authorization-v1.md).

## Efeitos e recuperação

A política é uma destas:

- `none`: a ação não produz efeito externo mutável;
- `journaled`: a intenção precisa ser registrada no journal antes da chamada.

Uma ação `journaled` contém:

- `effectKey` estável entre restart e retry;
- `reconcile-before-retry` quando o resultado for incerto;
- recuperação explícita por `restore-checkpoint` ou `retain-and-report`.

Na v1, mutação exige checkpoint antes do efeito. O plano ainda não contém `intentFingerprint`, porque o
payload concreto só existe no dispatch. O futuro contrato do executor deverá calculá-lo a partir do
conteúdo material e provar que ele corresponde à ação planejada; nonce, horário ou novo ID não criam
uma intenção diferente.

No estado executado, uma ação `journaled` só pode terminar como concluída quando existe exatamente um
efeito lógico correspondente no journal e ao menos uma origem ligada à mesma tentativa, passo, plano e
ação; origens anteriores estão `not-applied` e a última possui desfecho terminal admitido. Um registro
de passo dizendo “concluído” sem efeito observado não é aceito como trabalho realizado.

Essa ligação é feita pela `executionOrigin` correspondente, não pelos aliases históricos no topo do
efeito. Um único efeito lógico conserva `effectKey`, `intentFingerprint`, recurso e operação, enquanto
cada ciclo de aplicação acrescenta origem com `originId`, tentativa, revisão do plano, step run, ação,
epoch, revisão de nascimento, estado e evidência próprios. Assim `plan r2` consegue reutilizar a mesma
intenção sem reescrever a proveniência registrada por `plan r1`.

Uma ação concluída pode, portanto, possuir várias origens no mesmo efeito: todas as anteriores terminam
`not-applied` e a última possui o desfecho terminal aceito. `apply-effect` e `reconcile-effect` carregam
o `originId` corrente; CAS e epoch sozinhos não distinguem dois ciclos na mesma tentativa.

Não há motor genérico de compensação nesta fase.

## Critérios e evidência

`criterionCoverage` precisa conter exatamente todos os critérios do `TaskRequest`.

```text
critério do request
        |
        v
step do tipo verify
        |
        v
saída esperada do tipo evidence
        |
        v
evidência real no Task State / TaskResult
```

O plano guarda uma **especificação de evidência**, não a evidência real. Só a execução pode produzir um
digest, origem e horário observados.

Um passo `verify` concluído precisa registrar evidência real e incluir todos os IDs de saída de
evidência planejados. `outputBinding` liga o passo `deliver` à mesma forma de saída contratada no
request: tipo, `mediaType`, destino e schema, quando declarados. Apenas saídas do tipo `delivery` podem
ser vinculadas como entrega final.

Na execução, repetir o ID lógico da saída não basta. O step run de `deliver` grava uma
`deliveryBinding` para cada saída planejada, ligando-a ao `TaskResult` e aos artefatos concretos. Para
`file`, `repository-change` e `artifact-set`, ao menos um artefato é obrigatório; para `no-artifact`,
nenhum é permitido. Tipo, mídia, destino e schema repetem o vínculo do plano, e o resultado público
precisa realmente conter os artefatos declarados.

## Dois fingerprints diferentes

| Fingerprint | Protege | Exclui |
| --- | --- | --- |
| `planFingerprint` | O documento completo da revisão. | Apenas o próprio campo de fingerprint. |
| `strategyFingerprint` | Estrutura semântica de passos, ações, efeitos, critérios e entrega. | Identidade da revisão, horário, snapshots, redação do objetivo, nomes locais de IDs e a grafia local de `effectKey`. |

Ambos usam `sha256-jcs-v1`: RFC 8785, UTF-8 e SHA-256.

O fingerprint da estratégia é calculado sobre uma projeção normalizada:

```text
requestFingerprint + mode + estrutura dos steps + criterionCoverage + outputBinding
```

Referências a passo e saída são convertidas para posição na cadeia. Assim, renomear `stepId`,
`actionId`, `outputId`, reescrever o objetivo ou trocar apenas data, revisão ou snapshot não finge uma
estratégia nova. Alterar ordem, operação, classificação de efeito, checkpoint, evidência esperada,
timeout, restrição, critério ou recuperação altera a estratégia.

`effectKey` fica fora dessa projeção para que trocar apenas a chave não transforme a mesma ação numa
estratégia nova. Em compensação, o validador compara revisões pelo significado da ação
(`scope + operation + resourceRef` e sua ocorrência entre ações equivalentes) e exige que a chave
permaneça estável, mesmo que a ação mude de posição na cadeia.

## Replanejamento e retry

Retry não edita o plano em execução:

```text
tentativa 1 usa plan r1
        |
        v falha verificável
Task State volta a planning e invalida o executor antigo
        |
        v
plan r2 supersedes r1, com estratégia materialmente diferente
        |
        v
tentativa 2 usa plan r2
```

Uma mudança de objetivo, autoridade, critério, budget ou outro campo material não cria `plan r2`:
exige novo Draft, Preflight, Request e task.

Na mesma tarefa, replanejamento não pode apagar ativações, tentativas ou passos anteriores. O histórico
é acrescentado; identidades e proveniência já registradas permanecem imutáveis.

Se uma ação mutável equivalente reaparecer no plano novo, sua `effectKey` permanece estável. O ciclo
anterior precisa estar comprovadamente `not-applied`; então uma nova `executionOrigin` é acrescentada ao
mesmo efeito. A tentativa do plano novo pode já estar ativa quando a reserva ocorrer — ela não precisa
nascer na mesma mutação do journal —, mas plano, step run, ação e epoch precisam coincidir com essa
origem. Efeito `confirmed` nunca recebe nova origem; `unknown` precisa ser reconciliado primeiro.

Se a mutação já foi `confirmed` e o retry existe por falha posterior, a revisão nova omite essa ação
mutável e usa o fato confirmado como entrada/checkpoint. A v1 não representa “reuso” por uma origem
fictícia, pois isso faria parecer que a operação externa foi executada novamente.

## Como o plano foi ligado ao Task State

O `Task State v1` agora registra:

- `activePlanBinding`: revisão atualmente ativada e obrigatória desde `ready`; sua autorização
  corrente é comprovada pelo registro de enforcement ligado à mesma revisão;
- `ledger.planRefs`: histórico append-only de ativações;
- `attempt.planRef`: plano exato usado pela tentativa;
- `ledger.stepRuns`: passos realmente iniciados e seus resultados;
- `stepRun.deliveryBindings`: saída final materializada em resultado e artefatos públicos;
- `effect.executionOrigins[]`: origem planejada de cada ciclo do efeito, incluindo tentativa, plano,
  step run, ação, epoch, horário e revisão;
- aliases `effect.planRef`, `stepRunRef`, `actionRef` e `executionEpoch`: cópia imutável da primeira
  origem para compatibilidade histórica, nunca autorização corrente;
- `checkpoint.planRef` e `resumeStepRef`: cursor seguro de retomada.

```text
plan r1
  |
  +--> attempt 1
        |
        +--> step run 1
        +--> step run 2 --> effect
        `--> checkpoint: retomar step 2
```

Um checkpoint de `plan r1` não atravessa automaticamente para `plan r2`. Uma conclusão tardia do
plano antigo também perde a corrida pelo vínculo ativo, CAS e `executionEpoch`.

Ao executar, `planRefs` e `stepRuns` são append-only. Um passo encerrado não pode ser reescrito; seu
intervalo temporal precisa estar dentro da tentativa e cada origem de efeito precisa ficar dentro do passo que a
declarou. Checkpoint ligado a tentativa também precisa nascer dentro de sua janela temporal e de
revisões; passo falho ou ainda aberto bloqueia sucessores da mesma tentativa.
Passo concluído precisa materializar exatamente as saídas planejadas. Para mutação, o checkpoint que
autoriza recuperação precisa existir antes da reserva do efeito. `succeeded` só é válido quando existe
uma tentativa concluída no plano ativo.

## Invariantes de domínio

1. O plano nasce somente para Task State em `planning` ligado a request admitido.
2. Request, fingerprint, task e revisão-base coincidem.
3. Todo recurso usado possui snapshot e pertence ao contexto recebido; snapshot de admissão possui
   evidência de captura persistida e causalmente válida.
4. Plano não cria operação, autoridade, constraint, assumption, critério, prazo ou orçamento.
5. Sequência é linear, finita, sem entrada futura e respeita `prepare* -> execute* -> verify* -> deliver`.
6. A soma dos timeouts cabe no orçamento de uma tentativa.
7. Operação externa desconhecida ou não concedida é rejeitada.
8. Mutação ocorre somente em `execute`, é journaled, tem `effectKey`, recuperação e checkpoint anterior.
9. IDs de plano, passo, ação e saída, além de cada `effectKey`, são únicos no seu escopo.
10. Todos os critérios aparecem em passos `verify` com saída de evidência, e a execução concluída
    materializa essas evidências.
11. Há um único `deliver` final, sem efeito externo, e a entrega coincide integralmente com
    `expectedOutput`, com materialização ligada ao resultado e aos artefatos reais.
12. Fingerprints são recalculados; não são aceitos por confiança.
13. Revisões formam cadeia append-only, retry muda materialmente a estratégia e preserva `effectKey`
    para a mesma intenção lógica.
14. Ativação usa CAS sobre `basisStateRevision`, persiste exatamente a revisão seguinte e respeita a
    ordem temporal revisão-base <= criação do plano <= ativação.
15. Cada origem concorda com sua tentativa, passo e checkpoint na mesma revisão do plano; quando a
    origem é corrente, essa revisão também coincide com o plano ativo.
16. Passos executados formam um prefixo da cadeia; não se sobrepõem na v1.
17. Tentativa concluída executou todos os passos obrigatórios, com saídas, evidências e efeitos reais.
18. Passo falho ou não encerrado bloqueia sucessores; sucesso exige tentativa concluída do plano ativo.
19. Históricos de plano e passo são append-only e sua proveniência terminal não é reescrita.
20. Plano não seleciona executor concreto nem transporta comando opaco como autoridade.
21. Retry de efeito reutiliza o mesmo registro e `effectKey`, acrescentando origem somente após
    `not-applied`; nenhuma proveniência anterior é reescrita.

Os ataques reproduzíveis estão em:

- [`../../internos/testes/execution-plan-domain-mutations.json`](../../internos/testes/execution-plan-domain-mutations.json);
- [`../../internos/testes/execution-plan-state-mutations.json`](../../internos/testes/execution-plan-state-mutations.json).

## Exemplos

- [`execution-plan-change-r1.json`](../../internos/planos/exemplos/execution-plan-change-r1.json):
  mutação controlada com journal e checkpoint;
- [`execution-plan-change-r2.json`](../../internos/planos/exemplos/execution-plan-change-r2.json):
  retry mutável com a mesma `effectKey`, recuperação diferente e proveniência preservada por origem;
- [`execution-plan-inspection-r1.json`](../../internos/planos/exemplos/execution-plan-inspection-r1.json):
  inspeção de leitura;
- [`execution-plan-inspection-r2.json`](../../internos/planos/exemplos/execution-plan-inspection-r2.json):
  estratégia revisada após falha.

## Definition of Done desta etapa

1. Schema interno fechado e versionado.
2. Plano linear com entradas, ações, saídas, timeouts e checkpoints.
3. Cobertura total de critérios e vínculo da entrega.
4. Fingerprints de documento e estratégia reproduzíveis.
5. Revisão imutável e replanejamento encadeado.
6. Autoridade e efeito declarados antes da execução.
7. Vínculos completos no Task State.
8. Exemplos de leitura, mutação e retry.
9. Vetores adversariais de plano e integração com estado.
10. Nenhuma seleção prematura de agente, skill, modelo, SDK ou ferramenta.

## O que vem depois

O vínculo lógico entre `Authorization Enforcement v1`, ativação no `Task State` e dispatch já está
fechado e coberto por vetores adversariais. O próximo passo é escolher e implementar o menor
`Task Manager` executável que materialize essa semântica. A decisão continuará pertencendo ao Omni; o
componente interno do Overcore apenas aceitará ou rejeitará deterministicamente a decisão recebida.

Ainda ficam fora:

- Task Manager executável;
- executor e Harness;
- agentes, skills, modelos e ferramentas;
- linguagem, banco, fila e SDK;
- DAG, branching e paralelismo;
- interface conversacional do Omni, Oracle ou interface do Overcore.
