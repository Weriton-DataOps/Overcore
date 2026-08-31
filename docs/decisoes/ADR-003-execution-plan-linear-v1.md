# ADR-003 — Execution Plan v1 linear e interno

## Estado

Aceito em 2026-08-30.

## Contexto

O Task State já registrava lifecycle, tentativas, efeitos e checkpoints, mas não existia um artefato
persistente que provasse qual caminho havia sido autorizado antes da execução. Introduzir DAG,
paralelismo, múltiplos executores ou seleção de agentes neste ponto aumentaria a superfície antes da
primeira tarefa real.

## Decisão

Adotar `Execution Plan v1` como modelo interno obrigatório entre `planning` e `ready`:

- cadeia linear de 1 a 32 passos;
- fases ordenadas como `prepare* -> execute* -> verify* -> deliver`, com entrega única e final;
- revisões imutáveis e append-only;
- operações e efeitos declarados;
- critérios e entrega totalmente cobertos;
- ativação por CAS;
- mutações restritas a `execute`, com journal e checkpoint causal anterior;
- ligação append-only com tentativas, step runs, saídas, evidências, efeitos e checkpoints;
- um único efeito lógico por `effectKey`, com `executionOrigins` append-only por ciclo de aplicação,
  para que retry preserve a origem antiga e autorize a nova sem duplicar intenção;
- materialização explícita da entrega no `TaskResult` e nos artefatos públicos;
- nenhuma seleção de agente, skill, modelo ou ferramenta.

## Consequências

O primeiro Task Manager será menor e retomável. Retry precisa de uma estratégia materialmente distinta.
Em troca, branching, DAG e paralelismo permanecem fora até existir caso de uso comprovado.

Uma nova tentativa não reescreve `planRef`, step run ou ação do efeito anterior. Depois de
`not-applied`, o mesmo efeito recebe outra origem com tentativa, plano, step, ação, epoch, horário e
revisão próprios. Isso remove a contradição entre chave idempotente estável e proveniência imutável.

O plano apenas declara autoridade necessária. A decisão normativa e o enforcement serão construídos no
`Scope / Policy Engine v1`.
