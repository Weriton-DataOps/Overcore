# ADR-010 — Handoff idempotente do Preflight por reportId

## Status

Aceita em 2026-08-31.

## Contexto

O Preflight já persistia cada `TaskDraft` e `TaskReadinessReport` e produzia um `TaskRequest`
congelado quando o estado era `ready`. Porém, o cliente precisava copiar esse documento e enviá-lo
novamente para a porta de tarefas. Essa travessia permitia três ambiguidades:

- o conteúdo poderia ser alterado entre preparação e admissão;
- um relatório antigo poderia ser admitido depois de uma revisão mais nova;
- repetir uma chave idempotente com outro conteúdo poderia parecer uma repetição válida.

## Decisão

1. A admissão pública recebe somente o `reportId` por
   `POST /v1/preflight/{reportId}/admit` ou `overcore admit <report-id>`.
2. O Overcore recupera do `PreflightStore` o relatório e sua revisão; o cliente não reenvia o
   `TaskRequest`.
3. Antes da admissão, o validador recompõe as relações entre draft, relatório, request, derivações e
   fingerprints.
4. Um relatório sem estado `ready`, inexistente, corrompido ou ultrapassado não cria Task State nem
   outbox.
5. Se a chave de execução ainda não possui tarefa, somente o relatório corrente pode ser admitido.
6. Se a tarefa já existe e contém exatamente o mesmo `TaskRequest`, qualquer repetição devolve essa
   tarefa, mesmo que uma revisão posterior do Preflight tenha sido criada.
7. Se a chave já pertence a outro conteúdo, a operação falha como
   `preflight-execution-conflict`; conteúdo diferente nunca é tratado como sucesso idempotente.
8. A antiga entrada HTTP que aceitava o `TaskRequest` inteiro responde `410 direct-admission-retired`.
   O método de aplicação permanece disponível internamente para testes da máquina de estados, mas não
   é uma porta pública de contorno.

## Mapa

```text
TaskReadinessReport ready persistido
               |
               | POST .../{reportId}/admit
               v
   recuperar draft + relatório
               |
               +--> revalidar fingerprints e derivações
               +--> comprovar que é a revisão corrente
               +--> reservar idempotencyKey
               v
        Task State accepted
               |
               v
     planning -> autorização -> outbox

Repetição do mesmo reportId --------> mesma tarefa
Mesmo idempotencyKey + outro request -> conflito
```

## Consequências

- o request admitido é exatamente o documento produzido pelo Preflight;
- duas instâncias concorrentes não criam duas tarefas nem duas mensagens de execução;
- a trilha da tarefa preserva o `readinessReportId` no request e no evento de admissão;
- não foi necessária uma nova migration: a unicidade já é garantida por
  `overcore_tasks.idempotency_key`, e a proveniência fica no documento imutável admitido;
- o próximo problema operacional é retomar tarefas interrompidas depois da admissão, sem depender de
  uma nova chamada que apenas encontre o estado parcial.
