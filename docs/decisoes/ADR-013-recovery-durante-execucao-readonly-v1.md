# ADR-013 — Recovery durante execução somente leitura v1

## Status

Aceita e implementada em 2026-09-08.

## Problema

A outbox já sobrevivia à queda do processo, mas havia quatro lacunas:

1. o lease durava 30 segundos enquanto uma chamada ao Claude pode durar minutos;
2. uma queda depois da resposta do executor e antes do `TaskResult` fazia o executor rodar outra vez;
3. falhas temporárias eram reentregues para sempre, sem consumir o orçamento lógico da tarefa;
4. o `Task State` tinha o contrato de retry, mas a implementação ainda não criava outra revisão de plano,
   outra tentativa e outro `executionEpoch`.

## Decisão

### 1. Entrega não é tentativa

Uma **entrega da outbox** é a tentativa técnica de um worker consumir a mesma mensagem. Uma
**tentativa do Task State** é uma estratégia autorizada que chegou a `running`.

```text
tentativa lógica 1
    |
    +-- entrega 1 falha temporariamente
    `-- entrega 2 confirma que a estratégia falhou
             |
             `--> retry-scheduled
                    |
                    `--> plano r2 + nova autorização + tentativa lógica 2
```

A primeira falha temporária reentrega a mesma mensagem com backoff. A segunda encerra a estratégia.
Se ainda houver `budget.maxAttempts`, o Task State volta a `planning`. Caso contrário, emite
`TaskResult failed` terminal.

### 2. Lease vivo

Enquanto o executor trabalha, o worker renova o lease da outbox a cada 10 segundos. Somente o token
que ainda possui um lease válido pode persistir o recibo. Se o processo morrer, o heartbeat para e a
mensagem volta a ser elegível após 30 segundos.

Isso evita dois workers usando a mesma mensagem ao mesmo tempo sem transformar o lease em bloqueio
permanente.

### 3. Recibo durável

A migration `005_execution_receipts.sql` cria um recibo imutável por `outboxId`. Ele contém:

- tarefa e `executionEpoch`;
- payload do resultado obtido;
- fingerprint do payload;
- instante de gravação.

O recibo é salvo **antes** da transição para `verifying`. Se o processo cair depois disso, a próxima
entrega valida e reutiliza o recibo; o executor não é chamado novamente.

```text
executor conclui
      |
      v
recibo persistido ---- queda ----> nova entrega lê recibo
      |                                  |
      v                                  v
  verifying ------------------------> TaskResult
```

### 4. Retry muda a estratégia de verdade

O retry não troca apenas um identificador. Cada revisão:

- ganha `supersedesPlanRef` para a revisão imediatamente anterior;
- usa IDs próprios de passos, ações e saídas;
- amplia o tempo de verificação dentro do orçamento;
- abre uma sessão nova do motor;
- a partir da revisão 2, faz a inspeção determinística local antes do Agent SDK;
- amplia gradualmente `maxTurns` do Agent SDK.

O Omni recebe e autoriza a nova revisão antes de qualquer nova tentativa.

### 5. Falha terminal é um resultado, não um loop

Quando o erro é permanente ou o orçamento acaba, o worker:

1. fecha a tentativa ativa como `failed`;
2. persiste evidência e fingerprint da causa;
3. transita por `recovery-exhausted`;
4. emite `TaskResult failed` com `retryable: false`;
5. conclui a mensagem da outbox na mesma operação CAS.

## Limite deliberado

Esta implementação cobre a primeira tarefa real, que é **somente leitura**. Se houver queda antes de
o recibo existir, repetir a leitura é seguro.

Uma futura ferramenta mutável não poderá reutilizar essa suposição. Antes da primeira escrita será
necessário implementar o Harness de efeitos com reserva anterior, `effectKey`, checkpoint,
confirmação e reconciliação de `unknown`. Efeito incerto nunca deverá ser repetido só porque a outbox
foi reentregue.

## Provas

- reentrega depois de queda entre `verifying` e `TaskResult` usa o mesmo recibo e não chama o executor;
- heartbeat conserva a posse e um token estranho não grava recibo;
- falha temporária primeiro reentrega, depois cria plano r2, autorização e tentativa 2;
- estratégias r1 e r2 têm fingerprints diferentes e comportamento diferente;
- esgotamento de `maxAttempts` produz falha terminal e remove a mensagem pendente;
- suíte local e gate PostgreSQL real passam com a migration 005.

