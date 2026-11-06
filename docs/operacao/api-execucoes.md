# API de execuções e mudança de repositório

Contrato local entre o Omni e o Overcore para pedir uma mudança num repositório da máquina,
acompanhar a execução e responder quando ela parar pedindo gente. O resultado é um branch local
`overcore/...` aguardando revisão: o Overcore não faz push, não abre PR e não toca a working tree do
dono. Desenho e fronteiras: [ADR-022](../decisoes/ADR-022-mudanca-de-repositorio-por-worktree-v1.md).

## Subir o runtime

```powershell
npm run build
npm start            # node dist/main.js serve
```

O `serve` aplica as migrações, sobe o servidor HTTP e os workers e imprime
`Overcore ativo em http://127.0.0.1:PORTA com N worker(s)`. Também grava o descritor
`%LOCALAPPDATA%\Overcore\runtime.json` (`{schemaVersion, pid, host, port, startedAt}`).

| Variável | Obrigatória | Efeito |
|---|---|---|
| `OVERCORE_DATABASE_URL` | sim | PostgreSQL do runtime |
| `OVERCORE_LOCAL_TOKEN` | sim, ≥16 caracteres | token que o Omni apresenta ao Overcore |
| `OVERCORE_AUTHORITY_PROVIDER_URL` | sim | endpoint loopback do Omni que decide autorizações |
| `OVERCORE_AUTHORITY_PROVIDER_TOKEN` | sim, ≥16 caracteres | token que o Overcore apresenta ao Omni |
| `OVERCORE_PORT` | não | padrão `0` (porta efêmera); fixe se o Omni precisa de porta estável |
| `OVERCORE_WORKER_SLOTS` | não | padrão `2`, de 1 a 8; cada slot executa uma tarefa por vez |
| `OVERCORE_DISCOVERY_MODE` | não | `baseline` (padrão) ou `advisor` |

O host é sempre `127.0.0.1`. Com porta efêmera, o Omni lê `port` do `runtime.json`. Os worktrees
ficam em `%LOCALAPPDATA%\Overcore\worktrees\<taskId>` e são removidos ao final.

O editor usa o Claude Agent SDK com o login OAuth da assinatura. `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` e `ANTHROPIC_BASE_URL` são retirados do ambiente do SDK; sem login de
assinatura comprovado, a edição falha com `AnthropicLoginRequiredError`.

## Autenticação

Há um token em cada direção. Nenhum valor vai para log, resposta ou documento.

- **Omni → Overcore:** `Authorization: Bearer <OVERCORE_LOCAL_TOKEN>` em toda rota, comparado em
  tempo constante. Só `GET /health` é aberto. Falta ou erro: `401 {"error":"unauthorized"}`.
- **Overcore → Omni:** no planejamento, o Overcore faz `POST` em `OVERCORE_AUTHORITY_PROVIDER_URL`
  com `Authorization: Bearer <OVERCORE_AUTHORITY_PROVIDER_TOKEN>`. O corpo é um
  `AuthorizationRequest` (`contratos/authorization-request.schema.json`). A resposta deve ser um
  `AuthorizationDecision` em `application/json` (`contratos/authorization-decision.schema.json`).
  A URL precisa ser `http://127.0.0.1` ou `http://localhost`.

Para uma mudança de repositório, o pedido de autorização traz estas ações:

| Ação | Operação |
|---|---|
| ler o repositório | `repository.read` |
| editar no worktree | `repository.worktree.modify` |
| medir o diff | `repository.read` |
| rodar a verificação, se declarada | `process.execute` |
| criar o branch | `repository.branch.create` |

Se o Omni negar qualquer uma, a tarefa para antes de criar o worktree.

## Pedir uma mudança: preflight e admissão

`POST /v1/tasks` está aposentado (`410 direct-admission-retired`). O único caminho tem dois passos.

**1. `POST /v1/preflight` com `{ "draft": <TaskDraft> }`.** A resposta `200` é um
`TaskReadinessReport` com `status` igual a `ready`, `decisions-required` ou `not-feasible`.

- Com `ready`, o report traz `reportId` e `preparedRequest`.
- Com os outros dois status, `requiredDecisions` e `readinessChecks` dizem o que falta.
  Responda com `revision + 1` e `decisionAnswers`.
- Não envie `previousReports`: o Overcore recupera o histórico persistido.

**2. `POST /v1/preflight/{reportId}/admit`.** A resposta `202` traz
`{reportId, taskId, status, stateRevision}`.

Admitir de novo o mesmo report devolve o mesmo `taskId`, sem segunda execução. O `taskId` é o
`executionId` da API de leitura.

Exemplo de draft. É o mesmo da prova ponta a ponta pela API. O que torna o draft uma mudança de
repositório é o `executionHints.repositoryChange`:

```json
{
  "draft": {
    "contractVersion": "1.0",
    "draftId": "draft-repository-api-feature",
    "revision": 1,
    "idempotencyKey": "prepare-repository-api-feature",
    "executionIdempotencyKey": "execute-repository-api-feature",
    "createdAt": "2026-10-22T12:00:00.000Z",
    "client": { "id": "client-omni", "kind": "automation" },
    "objective": "Adicionar a feature api na repo descartável.",
    "context": {
      "references": [
        { "refId": "ref-repository-api", "uri": "file:///C:/caminho/da/repo", "kind": "repository", "sensitivity": "internal" }
      ],
      "assumptions": []
    },
    "knownConstraints": [
      { "id": "constraint-scope-api", "kind": "quality", "description": "Somente src/ pode mudar." }
    ],
    "knownAcceptanceCriteria": [
      { "id": "criterion-branch-api", "description": "O branch novo contém a feature e node check.mjs termina com código 0.", "verificationHint": "test" }
    ],
    "discoveryAuthority": {
      "mode": "inspect-only",
      "grants": [{ "resourceRef": "ref-repository-api", "operations": [{ "name": "repository.read", "effect": "read" }] }]
    },
    "availableExecutionAuthority": {
      "mode": "proceed-within-scope",
      "grants": [{
        "resourceRef": "ref-repository-api",
        "operations": ["repository.read", "repository.worktree.modify", "repository.branch.create", "process.execute"]
      }],
      "expansionBoundaries": ["destructive", "irreversible", "financial", "privilege-expansion", "external-publication", "secret-access"]
    },
    "executionBudget": {
      "source": { "kind": "policy-default", "sourceId": "policy-repository-change", "sourceVersion": "1.0", "sourceDigest": "sha256:<64 hex>" },
      "limits": { "maxDurationMs": 300000, "maxAttempts": 1, "maxParallelism": 1 }
    },
    "decisionAnswers": [],
    "preflightBudget": { "maxDurationMs": 60000, "maxInspectionOperations": 1 },
    "executionHints": {
      "priority": "normal",
      "expectedOutputKind": "repository-change",
      "repositoryChange": {
        "kind": "repository-change",
        "resourceRef": "ref-repository-api",
        "baseCommit": "<sha completo de 40 caracteres>",
        "targetBranch": "overcore/feature-api",
        "instructions": "Criar src/feature-api.mjs exportando a feature api.",
        "pathScope": { "include": ["src/**"], "exclude": ["**/*.pem", ".env*"] },
        "limits": { "maxFilesChanged": 3, "maxDiffBytes": 20000 },
        "verification": { "argv": ["node", "check.mjs"], "timeoutMs": 60000, "expectedExitCode": 0 }
      }
    }
  }
}
```

O Preflight copia `repositoryChange` para `TaskRequest.execution` sem reinterpretar nada. Antes,
o draft precisa passar por estas regras:

- **Referência.** A referência é `kind: "repository"` com URI `file:` local; UNC é recusado.
  O `discoveryAuthority` dá `repository.read` sobre ela.
- **Grants.** O `availableExecutionAuthority` concede `repository.read`,
  `repository.worktree.modify` e `repository.branch.create`, mais `process.execute` se houver
  `verification`.
- **Branch.** `targetBranch` casa com `^overcore/[a-z0-9][a-z0-9._-]{7,99}$`, sem `..` e sem
  terminar em `.lock` ou `.`. `overcore/curto` é recusado com `400 ContractValidationError`.
- **Commit base.** `baseCommit` é o SHA completo. O worktree nasce exatamente nele.
- **Escopo de caminhos.** O `pathScope` limita a escrita: o `exclude` vence o `include`, e `.git`
  é negado sempre. O editor pode ler arquivos fora do `include` para entender o contexto, mas
  nunca o que está em `exclude` nem `.git`.
- **Verificação.** Roda por `argv`, sem shell, com ambiente filtrado e timeout. Launcher `.cmd` e
  `.bat` é recusado: aponte para o executável.
- **Uma operação material por draft.** `repositoryChange` não se combina com os hints de
  substituição de arquivo nem de sonda PostgreSQL.

## Acompanhar: API de leitura

A leitura é só leitura: não admite, não retoma e não executa nada. O formato é `viewVersion: 1`.
Campo novo pode entrar sem aviso. Mudança de significado de um campo existente exige nova versão.

### `GET /v1/executions?state=…&limit=…`

- `state`: lista separada por vírgula. Valores: `accepted`, `planning`, `ready`, `running`,
  `verifying`, `blocked`, `cancelling`, `succeeded`, `failed`, `cancelled`.
- `limit`: inteiro de 1 a 200, padrão 50.
- Ordem: a execução com atividade mais recente vem primeiro.

Resposta real, recapturada em 2026-10-22 e encurtada:

```json
{
  "viewVersion": 1,
  "observedAt": "2026-10-22T11:51:59.714Z",
  "limit": 10,
  "executions": [
    {
      "executionId": "task-2b44c77aac93607afc5c9b10",
      "title": "Adicionar a feature alfa na repo descartável.",
      "kind": "repository-change",
      "repository": {
        "uri": "file:///<tmp>/repo",
        "baseCommit": "9fc9f32fd8105bbaeab17ce5fcb0cb4010ee0ba9",
        "targetBranch": "overcore/feature-alfa"
      },
      "state": "succeeded",
      "terminal": true,
      "needsAnswer": false,
      "currentStep": "concluída",
      "activeExecutors": [],
      "admittedAt": "2026-10-22T11:51:54.247Z",
      "startedAt": "2026-10-22T11:51:54.912Z",
      "lastActivityAt": "2026-10-22T11:51:58.529Z",
      "attemptCount": 1,
      "block": null,
      "resultSummary": "Branch overcore/feature-alfa criado em abdc1697b891 com 1 arquivo(s) alterado(s), aguardando revisão.",
      "evidence": [
        { "evidenceId": "evidence-repository-diff-…", "kind": "inspection", "summary": "1 arquivo(s) e 187 bytes de diff contra 9fc9f32fd810, dentro do escopo e dos limites declarados.", "capturedAt": "2026-10-22T11:51:58.527Z" },
        { "evidenceId": "evidence-repository-verification-…", "kind": "test-result", "summary": "A verificação node check.mjs terminou com código 0 em 143 ms, sem shell e com ambiente filtrado.", "capturedAt": "2026-10-22T11:51:58.527Z" },
        { "evidenceId": "evidence-repository-readback-…", "kind": "state-readback", "summary": "refs/heads/overcore/feature-alfa relido em abdc1697b891… (tree 611a22c9…, pai 9fc9f32f…).", "capturedAt": "2026-10-22T11:51:58.527Z" }
      ]
    }
  ]
}
```

| Campo | Significado |
|---|---|
| `executionId` | o `taskId`; é o identificador usado nas rotas de detalhe, retomada e cancelamento |
| `title` | o `objective` do pedido |
| `kind` | `repository-change`, `inspection`, `file-replacement`, `postgres-table-probe` ou `null` |
| `repository` | `uri`, `baseCommit` e `targetBranch`; `null` quando a execução não é sobre repositório |
| `state` / `terminal` | estado do ciclo de vida; `terminal` vale `true` em `succeeded`, `failed` e `cancelled` |
| `needsAnswer` | `true` quando há `block` esperando o Omni ou o Weriton |
| `currentStep` | frase curta para a interface, por exemplo `editando na worktree isolada e verificando antes de criar o branch` |
| `activeExecutors` | executor da estratégia enquanto o estado é `running`, `verifying` ou `cancelling` |
| `admittedAt` / `startedAt` / `lastActivityAt` | admissão, início da primeira tentativa e última mudança persistida |
| `attemptCount` | tentativas iniciadas |
| `block` | o bloqueio aberto, descrito na seção seguinte; `null` se não há |
| `resultSummary` | uma linha sobre o resultado ou o motivo da parada |
| `evidence[]` | `evidenceId`, `kind`, `summary` e `capturedAt` de cada evidência |

### `GET /v1/executions/{executionId}`

A resposta vem embrulhada, como a listagem. A execução não vem solta na raiz:

```json
{
  "viewVersion": 1,
  "observedAt": "2026-10-22T11:51:59.714Z",
  "execution": { "executionId": "task-2b44c77aac93607afc5c9b10", "state": "succeeded", "…": "…" }
}
```

O objeto `execution` traz todos os campos da linha da listagem e mais:

- `stateRevision`;
- `request`: `requestId`, `objective`, `acceptanceCriteria[{id, description}]` e `execution`
  (o pedido de mudança como admitido);
- `result`, ou `null` se ainda não há resultado:
  - `resultId`, `status` e `summary`;
  - `report`, com `mediaType: text/markdown`, `content` e `digest` sha256. O relatório traz
    commit, diff por arquivo, código da verificação, o relato do editor e o final da saída;
  - `artifacts[]`: o `patch` e o `checkpoint` do commit base;
  - `effects[]`: o `repository.branch.create` com `status: confirmed`;
  - `criteria[]`: cada critério com `status` e `evidenceRefs`;
- `transitions[]`: `{to, from, at, triggerKind}`, de `admission` até o estado atual.

A trilha de uma execução concluída:

| `from` | `to` | `triggerKind` |
|---|---|---|
| `null` | `accepted` | `admission` |
| `accepted` | `planning` | `planning-started` |
| `planning` | `ready` | `planning-completed` |
| `ready` | `running` | `execution-started` |
| `running` | `verifying` | `verification-started` |
| `verifying` | `succeeded` | `verification-passed` |

Execução inexistente: `404 {"error":"not-found"}`.

## Bloqueio que pede gente

Quando a execução para e precisa de decisão, a listagem mostra `state: "blocked"`,
`needsAnswer: true` e um `block` com a pergunta pronta para a interface.

Exemplo real: o branch de destino já existia e não tinha sido criado pela tarefa.

```json
{
  "blockId": "block-e20b996702301998e9e4cd6b",
  "code": "block-repository-branch-exists",
  "kind": "decision",
  "mode": "resume-same-request",
  "reason": "O branch overcore/branch-ocupado já existe (commit 9fc9f32f…) e não foi criado por esta tarefa.",
  "question": "O branch overcore/branch-ocupado já existe (commit 9fc9f32f…) e não foi criado por esta tarefa. Apagar ou renomear esse branch para a tarefa retomar, ou cancelar a tarefa?",
  "options": [
    { "id": "option-free-branch-and-resume", "label": "Liberar o branch e retomar", "consequence": "POST /v1/tasks/{taskId}/resume refaz as precondições e planeja de novo; nada é sobrescrito." },
    { "id": "option-cancel-task", "label": "Cancelar", "consequence": "POST /v1/tasks/{taskId}/cancel encerra a tarefa sem tocar no repositório." }
  ],
  "impact": "Nenhum worktree, autorização ou branch é criado enquanto a condição persistir.",
  "answer": {
    "resume": "POST /v1/tasks/task-8461880bc0620ec1fb59c378/resume",
    "replace": null,
    "cancel": "POST /v1/tasks/task-8461880bc0620ec1fb59c378/cancel"
  }
}
```

`block.answer` diz como responder:

- **`resume`:** `POST /v1/tasks/{id}/resume`, sem corpo. Refaz as precondições e planeja de novo.
  A resposta é `202` com a tarefa inteira. O `202` só confirma que o pedido foi recebido. Se a
  condição persistir, a tarefa continua `blocked`; releia a execução para saber.
- **`replace`:** quando `mode` é `replacement-request-required`, retomar não resolve. O pedido
  precisa ser corrigido: mande um novo `TaskDraft` por `POST /v1/preflight`. Nesse modo `resume`
  vem `null`, e chamá-lo devolve 400.
- **`cancel`:** `POST /v1/tasks/{id}/cancel`, sem corpo. Responde `202` com a tarefa. Antes do
  efeito, encerra sem tocar no repositório. Durante a execução, passa por `cancelling`, remove o
  worktree e reconcilia o branch. Um branch já criado e confirmado não é apagado.

## Outras rotas

| Rota | Resposta |
|---|---|
| `GET /health` (sem token) | `{"status":"ok","service":"overcore-task-manager","version":1}` |
| `GET /v1/capabilities` | `{service, protocolVersion: 1, startedAt, observedAt, capabilities[], scope: "runtime-capabilities-not-task-success"}`. Com esta entrega, a lista inclui `repository-change-worktree-v1` e `execution-read-view-v1`. |
| `GET /v1/tasks/{id}` | a tarefa persistida completa; para a interface, prefira `/v1/executions/{id}` |
| `POST /v1/work-once` | reconcilia e roda um passo de worker: `{reconciliation, taskId, status}` ou `{reconciliation, status: "idle"}`. Para teste e diagnóstico; o `serve` já faz isso sozinho. |

## Erros

| HTTP | `error` | Quando |
|---|---|---|
| 401 | `unauthorized` | token ausente ou diferente |
| 404 | `not-found` | rota ou execução inexistente |
| 410 | `direct-admission-retired` | `POST /v1/tasks` |
| 400 | `invalid-request` | parâmetro inválido, por exemplo `Estado desconhecido: inventado.` ou `limit deve ser inteiro entre 1 e 200.` |
| 400 | nome da classe | erro de contrato ou domínio com nome próprio: `ContractValidationError`, `PreflightAdmissionError`, `PreflightDomainError`, `RepositoryChangeRequestError`, entre outros |

Todo 400 traz `message` legível. Ramifique pelo `error`; `message` serve para mostrar à pessoa.

## Duas execuções ao mesmo tempo

Cada slot de worker pega uma tarefa, e cada tarefa ganha o próprio worktree em
`worktrees\<taskId>`. Com o padrão `OVERCORE_WORKER_SLOTS=2`, duas mudanças no mesmo repositório
correm em paralelo sem se pisar. Cada uma termina no próprio branch, e a working tree do dono não
muda. Dois pedidos para o mesmo `targetBranch` não se sobrescrevem. O branch só é criado se o ref
não existir. Se o branch já existe quando a execução é planejada, ela bloqueia com
`block-repository-branch-exists`. Se outro processo criar o branch durante a execução, ela falha
com `repository-branch-exists` e não sobrescreve nada.

## Prova ponta a ponta

```powershell
npx tsc -p tsconfig.test.json; node --test .test-dist/test/repository-change-e2e.test.js
```

Também roda dentro de `npm test` e de `npm run verify`. Cada caso cria a própria repo git
descartável no diretório temporário e a apaga ao final. Os cinco casos:

1. `e2e: pedido do Omni vira branch verificado sem tocar a working tree do dono, visível pela API de leitura`
2. `e2e pela API: o Omni manda o TaskDraft por /v1/preflight, admite e acompanha até o branch`
3. `e2e: branch alheio bloqueia pedindo gente; liberar e retomar conclui, cancelar encerra sem tocar no repo`
4. `e2e: cancelar antes do worker reivindicar reconcilia sem editar nem criar branch`
5. `e2e: duas execuções no mesmo repo correm ao mesmo tempo em worktrees separadas`

O que esses testes exercitam de verdade:

- git, worktree, branch e releitura do ref;
- o servidor HTTP e a API de leitura;
- o processo de verificação;
- o snapshot que prova a working tree do dono intacta.

O que é substituto:

- o editor, que escreve um arquivo determinístico no lugar do Claude;
- o provedor de autoridade, que permite tudo;
- o store, que fica em memória.

A leitura e a migração no PostgreSQL real têm gate próprio: `npm run test:postgres` e
`npm run test:cancellation-postgres`, com `OVERCORE_TEST_DATABASE_URL` apontando para um
PostgreSQL local de teste.

## O que ficou de fora

- **Revalidação do Omni antes de executar.** A ADR-022 aprovou a verificação com revalidação do
  Omni sobre o diff medido (D1). Hoje o Omni autoriza o `argv` no planejamento, mas não revê o diff
  antes da execução nem antes de criar o branch. O endpoint `/v1/authority/revalidate-effect` só
  conhece `filesystem.modify` e `database.schema.modify`. Em 2026-10-22 o Weriton liberou o mínimo
  assim, só para repositórios dele; a revalidação ficou como dívida de uma fatia futura (adendo da
  D1 na ADR-022).
- **Omni real nega o plano de repositório; o gate real, item 8 da ADR, está vermelho.** O gate
  `npm run test:repository-change-live` existe. Ele exige `OVERCORE_RUN_REPOSITORY_CHANGE_E2E=I_UNDERSTAND_LOGIN_USAGE`,
  `OVERCORE_TEST_DATABASE_URL` e `OVERCORE_OMNI_REPOSITORY_PATH`.
  Em 2026-10-22 o adaptador do Omni respondeu HTTP 400 `invalid-authority-request`:
  `actions[3].effectClass` não aceita `local-code-execution`. A tarefa bloqueia com
  `block-authority-provider-invalid`, e nenhuma ferramenta roda. A política do Omni também nega as
  outras três ações em envelope `medium`.
  Consequência: pelo runtime local, que usa o Omni real como autoridade, toda mudança de
  repositório bloqueia até o Omni ganhar esse corredor. O caminho ponta a ponta só fecha com o
  provedor permissivo dos testes. O `ClaudeRepositoryEditor` continua testado só com SDK simulado.
- **Sem sandbox de sistema operacional.** A verificação roda como o usuário. O guarda de caminho
  limita o editor, não o processo de verificação.
- **Filtros `clean`/`smudge` e configuração git da repo alvo.** Não são neutralizados.
- **Janela de autorização de 5 minutos.** Uma edição longa pode passar dela; não há teste dedicado.
- **`activeExecutors` vem do estado persistido.** Não vem de lease viva; um worker morto aparece
  como ativo até a reconciliação.
- **Push, PR e merge.** Ficam fora por desenho. O branch fica local aguardando revisão humana.
- **Interface e eventos em tempo real.** Também fora por desenho: a interface é do Omni, que
  acompanha por polling da leitura.
