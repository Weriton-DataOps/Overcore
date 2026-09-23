# Fundação executável — mapa didático

```text
CLI / Omni / futura UI
          │ HTTP JSON em loopback
          ▼
       Preflight
   TaskDraft → ReadinessReport
      │ somente `ready`
      ▼
    Task Manager
       │     │
       │     └────────► Authority Provider (Omni primeiro)
       │                   request → decision
       ▼
 PostgreSQL 18
   ├─ corrente + revisões imutáveis do Preflight
   ├─ tarefa + Task State canônico
   ├─ planos e autorizações
   ├─ ledger append-only
   └─ outbox transacional
          │
          ▼
 trabalhador
     │
     ▼
 AgentRuntimePort
     │
     ▼
 Claude Agent SDK ──► Read / Glob / Grep
     │ sessão + eventos + uso
     ▼
 verificador determinístico ──► TaskResult
```

## O lugar do Claude Agent SDK

O SDK é o motor do agente, não o banco nem o Task Manager. Ele decide como avançar dentro de uma
execução autorizada e chama ferramentas; o Overcore decide qual tarefa existe, qual plano está ativo,
qual autorização vale e quais evidências comprovam o resultado.

```text
memória da conversa da execução  → sessão do SDK
verdade operacional da tarefa    → Task State no PostgreSQL
permissão do proprietário        → decisão do Omni
aplicação ferramenta por ferramenta → PreToolUse + permissões nativas do SDK
```

O identificador da sessão é guardado na tentativa do Task State. Isso permite retomar a conversa do
motor sem transformar o transcript na fonte de verdade da tarefa.

## Duas portas diferentes

Há duas portas de rede local, com responsabilidades diferentes:

1. **porta da API do Overcore**: recebe tarefas, consulta estado e solicita cancelamento;
2. **porta do PostgreSQL**: usada somente pelo runtime para persistir o estado.

A API usa porta dinâmica em `127.0.0.1`. PostgreSQL normalmente usa `127.0.0.1:5432`, mas a conexão
vem de `OVERCORE_DATABASE_URL`; nenhuma senha entra no repositório.

## Muitos projetos sem Registry prematuro

O banco não precisa conhecer ainda um catálogo de projetos. Na admissão, o Task Manager ordena as
URIs de referências `repository` e `workspace` e calcula uma `scope_key`. Ela permite consultar,
limitar e distribuir tarefas relacionadas ao mesmo conjunto de trabalho. O documento original
continua sendo a fonte; a chave é apenas um índice operacional.

## Concorrência

```text
worker A ── pega item 1 ──┐
worker B ── pula item 1 ──┼─ PostgreSQL outbox
          e pega item 2 ──┘
```

O bloqueio dura apenas dentro da transação de reivindicação. Depois, o trabalhador recebe um lease.
CAS e `executionEpoch` impedem que um trabalhador antigo grave sobre uma revisão nova.

## Gate honesto

Os testes unitários usam uma implementação em memória para provar a lógica determinística. O gate
`test:postgres` só pode ficar verde conectado a um PostgreSQL real; ausência do servidor é
`não executado`, nunca aprovação fabricada.

O mesmo vale para o SDK: os testes automáticos usam mensagens simuladas. O gate `test:sdk-live` só
roda quando o proprietário habilita conscientemente uma resposta pelo login Claude.

### Resultado do gate PostgreSQL

Em 2026-08-31, o gate real foi aprovado no PostgreSQL 18 local. A prova executou duas tarefas com
dois workers concorrentes, confirmou duas mensagens diferentes da outbox como processadas e fez
dois escritores disputarem a mesma revisão: um venceu e o outro recebeu conflito CAS.

O mesmo gate agora prova o prontuário do Preflight: idempotência de r1, recuperação de r2 por uma nova
instância, disputa concorrente por r3 e rejeição de `UPDATE` numa revisão já registrada.
