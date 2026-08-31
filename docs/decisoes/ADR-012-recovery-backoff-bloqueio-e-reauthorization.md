# ADR-012 — Recovery com backoff, bloqueio e nova autorização

## Status

Aceita em 2026-08-31.

## Contexto

A retomada automática da ADR-011 sabia continuar um estado parcial, mas tratava todas as falhas do
mesmo jeito. Isso criava dois riscos opostos:

- repetir imediatamente uma indisponibilidade temporária, formando um loop ruidoso;
- deixar uma autorização vencida ou uma negação sem um caminho estruturado de recuperação.

O sistema precisava distinguir espera automática, bloqueio de negócio e corrupção/erro interno sem
inventar estados como `retrying` ou reutilizar autoridade vencida.

## Decisão

### 1. Falha temporária usa backoff operacional

Erros de rede, timeout e HTTP `408`, `429` ou `5xx` do Authority Provider permanecem na fase atual.
O PostgreSQL registra fora do documento do `Task State`:

- quantidade de falhas consecutivas;
- código e fingerprint do último erro;
- instante do erro;
- horário da próxima tentativa.

O intervalo cresce em `1s, 2s, 4s, 8s, 16s, 30s` e fica limitado a 30 segundos. Quando a porta
informa `Retry-After`, o valor é respeitado entre 1 segundo e 5 minutos. Sucesso limpa todo esse
registro. O comando `status` mostra o bloco `reconciliation`, e o runtime registra cada adiamento no
stderr.

Esses campos respondem “quando tentar coordenar novamente?”, não “em qual fase está a tarefa?”. Por
isso não constituem outro estado de domínio.

### 2. Autorização vencida recebe outra identidade

Uma tarefa `ready` nunca executa com o enforcement vencido. O Task Manager:

1. relê o plano já ativado;
2. produz outro `AuthorizationRequest` para o mesmo plano, com nova identidade de ciclo;
3. consulta o Omni;
4. persiste nova decisão e novo enforcement;
5. registra `ready -> ready` com `authorization-refreshed`;
6. somente então cria a tentativa e a outbox.

O plano e sua estratégia não mudam; apenas o crachá temporário é substituído. As autorizações
anteriores continuam append-only no banco.

### 3. Impedimento real produz `blocked`

Negação do Omni, resposta permanentemente inválida da porta ou recurso ausente/inacessível produz:

- transição `block-detected`;
- `activeBlockRef` e entrada em `ledger.blocks`;
- evidência com fingerprint;
- `TaskResult blocked` válido;
- `inputRequired` com causa, impacto, opção e `resumeTarget`.

Não há execução parcial. O bloqueio atual usa `resume-same-request`, porque restaurar a mesma
autoridade ou a mesma referência não muda o pedido.

### 4. Retomada é explícita e volta para uma fase segura

O chamador usa:

```text
POST /v1/tasks/{taskId}/resume
overcore resume <task-id>
```

O Overcore confere o bloco ativo e seu modo, registra `condition-restored` e volta a `planning` ou
`ready`. Nunca salta de `blocked` diretamente para `running`. Depois disso, o reconciliador normal
revalida plano, autoridade e estado.

### 5. Erro interno desconhecido não vira falsa decisão de negócio

Erros não classificados recebem código e backoff persistente. Eles ficam visíveis, mas não são
convertidos automaticamente em negação, falha terminal ou pergunta ao usuário. Isso evita que um bug
do próprio Overcore seja fantasiado de decisão externa.

## Mapa

```text
falha temporária
      |
      v
planning/ready -- backoff persistente --> tenta novamente -- sucesso --> continua

enforcement vencido
      |
      v
ready -- nova decisão do Omni --> ready (authorization-refreshed) --> running

negação / porta inválida / recurso ausente
      |
      v
blocked + TaskResult
      |
      | resume explícito
      v
planning ou ready -- reconciliação normal --> ...
```

## Evidências

- falha temporária não é chamada novamente antes de `retryAt`;
- falhas repetidas aumentam o intervalo e preservam `planning` como único estado;
- uma negação produz `TaskResult blocked` validado e zero outbox;
- a retomada registra `condition-restored` e só depois alcança `running`;
- uma autorização vencida gera segunda autorização, mantém um plano e cria uma outbox;
- HTTP `503` com `Retry-After` é classificado como temporário;
- PostgreSQL real preserva o adiamento e converge entre instâncias concorrentes.

## Consequências

- indisponibilidade temporária deixa de gerar loop de um segundo;
- nenhuma autorização vencida é promovida a execução;
- bloqueios são verificáveis e retomáveis;
- o próximo bloco pode avançar para recovery da execução: falhas do worker, classificação de efeitos,
  retry de tentativa e verificação, sem ainda introduzir agentes, skills, Registry ou Graph Engine.
