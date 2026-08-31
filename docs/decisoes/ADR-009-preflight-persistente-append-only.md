# ADR-009 — Preflight persistente e append-only

- Estado: aceito e implementado
- Data: 2026-08-31

## Contexto

O primeiro Preflight executável dependia de o cliente reapresentar relatórios anteriores junto com
uma nova revisão. Isso tornava a continuidade dependente da sessão do cliente e permitia perder o
histórico necessário para conferir respostas, idempotência e concorrência.

Essa memória não pertence ao `Task State`: enquanto o Preflight ainda está decidindo se uma intenção
pode virar tarefa, nenhuma tarefa executável foi admitida.

## Decisão

1. `TaskDraft` e `TaskReadinessReport` são persistidos no PostgreSQL a cada revisão.
2. `overcore_preflight_streams` mantém somente o ponteiro operacional para a revisão mais recente.
3. `overcore_preflight_revisions` guarda cada par draft/relatório como documento imutável e possui
   bloqueio de `UPDATE` no banco.
4. A chave idempotente identifica uma única corrente de preparação.
5. A inclusão de uma revisão exige CAS sobre a revisão anterior.
6. Repetir o mesmo draft devolve o relatório já persistido, sem executar Discovery novamente.
7. Uma nova instância do Overcore recupera internamente os relatórios citados pelas respostas.
8. Respostas herdadas não podem ser alteradas ou removidas.
9. Respostas novas precisam resolver exatamente as decisões do relatório imediatamente anterior.
10. O cliente envia somente `{ draft }`; não transporta `previousReports`.
11. Um relatório `ready` contém o `TaskRequest`, mas não o admite silenciosamente nesta etapa.
12. Conversa bruta, personalidade e memória pessoal do Omni não entram nessas tabelas.

## Mapa

```text
TaskDraft r1
    |
    v
Preflight Store
    ├── stream: ponteiro para r1
    └── revisão r1: draft + relatório decisions-required
                              |
                              v
                         resposta do cliente
                              |
                              v
TaskDraft r2 -- CAS sobre r1 --> revisão r2: draft + relatório ready
                                              |
                                              `--> TaskRequest congelado
```

## Consequências

- reinício do processo não apaga a preparação;
- a sessão do cliente deixa de ser a fonte do histórico;
- duas sessões não conseguem ocupar a mesma revisão com conteúdos diferentes;
- o prontuário do Preflight permanece separado do estado de uma tarefa já admitida;
- o próximo desenho pode tratar o handoff idempotente de `ready` para a admissão.
