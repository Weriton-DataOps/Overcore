# ADR-022 — Mudança de repositório por worktree v1

## Status

Proposta em 2026-09-28. Aguarda aprovação do proprietário. Nenhuma linha de código foi escrita para
esta decisão; o esboço de contrato abaixo é o que será discutido antes da implementação, como exige a
regra de crescimento do README.

## Problema

O Overcore declara que coordena e executa trabalho de desenvolvimento. Hoje ele consegue:

| Capacidade | O que prova | Onde está a inteligência da mudança |
|---|---|---|
| inspeção de contratos | leitura, relatório e verificação | no Overcore, mas sem efeito |
| substituição de arquivo | journal, checkpoint, revalidação e readback | **no cliente**: o `TaskRequest` já traz o conteúdo final inteiro |
| sonda PostgreSQL | efeito transacional reversível | não se aplica; é uma prova de substrato |

Nenhuma delas permite pedir "corrija este teste" e receber a correção. A substituição de arquivo exige
que quem pede já tenha escrito o arquivo; o Overcore apenas aplica. A
[ADR-006](ADR-006-fundacao-executavel-v1.md) adiou a mutação de repositório "antes de o substrato estar
comprovado". O substrato agora está comprovado: Harness de efeitos, journal PostgreSQL, CAS,
autorização revalidada pelo Omni, retomada, recovery e cancelamento cooperativo passaram em gates com
PostgreSQL, Omni e Claude reais.

O teste que comprova a necessidade é o uso observado. Em 24/09/2026, uma única tarde de uso real pelo
Omni produziu quatro correções (`f82318a`, `9ad6078`, `2fc4ac7`, `057b0eb`) que a suíte local, então
com cerca de cem testes, não tinha encontrado. O próximo aprendizado exige uma tarefa de desenvolvimento de verdade, não mais uma
camada de resiliência sobre executores de demonstração.

## Decisão

A terceira capacidade executável é uma **mudança de repositório em worktree isolado**, entregue como
um branch local para revisão humana. Ela tem três fases, e só a última é um efeito journaled:

```text
TaskRequest: repositório, commit base exato, instruções, escopo de caminhos, limites, verificação
        |
        v
A. BANCADA  (sem efeito sobre o repositório do proprietário)
   git worktree add --detach <base>  em diretório operacional fora do repositório
   Claude Agent SDK edita dentro do worktree: Read, Glob, Grep, Edit, Write
   guarda de caminho em PreToolUse; sem Bash
        |
        v
B. MEDIÇÃO  (executada pelo Overcore, nunca pelo agente)
   diff contra o base -> limites de escopo, arquivos, bytes, binários
   Omni revalida a verificação sobre o diff medido
   comando de verificação declarado (argv, sem shell, timeout, ambiente saneado) no worktree
   tree hash calculado
        |
        v
C. EFEITO JOURNALED  (determinístico)
   journal: reserved -> revalidação do Omni -> applying
   git commit-tree <tree> -p <base>  +  git update-ref refs/heads/<branch> <commit> <zero>
   readback: ref aponta para o commit esperado, tree confere
        |
        v
TaskResult: branch, commit, diffstat, relatório, evidências
worktree removido; repositório do proprietário intocado fora do novo ref
```

### O ângulo que sustenta o desenho

O modelo é não determinístico; o journal do Harness depende de uma intenção fingerprintável antes do
efeito. Por isso a escrita do modelo acontece numa bancada descartável e o efeito só é reservado depois
que o **tree hash** já existe. O `intentFingerprint` passa a cobrir o conteúdo exato que será publicado
no ref. A recuperação volta a ser a da [ADR-014](ADR-014-harness-de-efeitos-v1.md): comparar o estado
real com o esperado, sem confiar em nenhuma promessa do modelo.

Em outras palavras, o agente trabalha na bancada e o Overcore só entrega a peça que já mediu. Refazer a
bancada depois de uma queda custa uma nova chamada ao modelo; publicar duas vezes no mesmo ref é o que
o journal impede.

## Por que worktree

| Alternativa | Vantagem | Por que não na v1 |
|---|---|---|
| editar o working tree do proprietário | zero infraestrutura | mistura a mudança com trabalho não commitado e com o branch em uso; recovery não distingue o que é do Overcore |
| clone completo por tarefa | isolamento total do `.git` | copia o histórico inteiro a cada tarefa; lento em repositório grande |
| **worktree destacado** | compartilha objetos, isola arquivos e índice, começa no commit exato | escreve metadados administrativos em `.git/worktrees`, removidos ao final |

O worktree é criado sem branch (`--detach`) no commit base. O único ref novo nasce na fase C, com
`update-ref` condicionado à inexistência do ref, e é isso que o journal controla. Objetos soltos
criados na fase A sem ref são coletáveis pelo `gc` e não constituem efeito publicado.

## Fronteira da v1

| Dentro | Fora (exige ADR própria) |
|---|---|
| um repositório Git local por tarefa | múltiplos repositórios na mesma tarefa |
| commit base exato declarado no pedido | "branch atual", HEAD móvel ou pull antes de começar |
| branch local novo com prefixo reservado | push, pull request, merge ou alteração de branch existente |
| edição de texto dentro do escopo declarado | binários, submódulos, LFS, links simbólicos que saem do worktree |
| verificação por comando declarado, executada pelo Overcore | Bash ou execução arbitrária pelo agente |
| repositório em disco local | compartilhamento de rede |

A exclusão de compartilhamento de rede é medida, não preferência: em 27/08/2026, `git status` num
repositório em compartilhamento SMB local levou de 37 a 63 segundos, contra 0,08 segundo em disco
local. Um worktree que percorre a árvore herdaria esse custo em cada fase.

Push e pull request são publicação externa (`external-publication`) e ficam para uma decisão
posterior. A v1 termina num branch local que o proprietário revisa, mescla ou apaga.

## Esboço de contrato

Os nomes abaixo são propostos. Nenhum schema foi alterado.

### `TaskRequest.execution`

Nova alternativa no `oneOf`, ao lado de `replace-file-content` e `postgres-create-drop-table`:

```json
{
  "kind": "repository-change",
  "resourceRef": "ref-repositorio-alvo",
  "baseCommit": "<40 hex>",
  "targetBranch": "overcore/<identificador>",
  "instructions": "texto do que mudar, até 8000 caracteres",
  "pathScope": {
    "include": ["src/**", "test/**"],
    "exclude": [".env*", "**/*.pem", ".git/**"]
  },
  "limits": { "maxFilesChanged": 20, "maxDiffBytes": 200000 },
  "verification": {
    "argv": ["npm.cmd", "test"],
    "timeoutMs": 600000,
    "expectedExitCode": 0
  }
}
```

A referência apontada por `resourceRef` precisa ter `kind: "repository"` e URI `file://` local.
`targetBranch` aceita somente o prefixo reservado e não pode existir no início da tarefa.
`verification` é opcional; sem ela, os critérios dependem apenas da medição do diff e da revisão
independente do relatório.

`TaskDraft.executionHints` ganha a dica correspondente `repositoryChange`. O valor
`expectedOutputKind: "repository-change"` já existe no draft desde a primeira versão e nunca teve
executor.

### Autoridade

O plano declara ações separadas para o Omni avaliar em lote:

| Ação | Operação proposta | `effectClass` | `effectMode` |
|---|---|---|---|
| ler o repositório e criar a bancada | `repository.read` | `read-only` | `none` |
| editar arquivos na bancada | `repository.worktree.modify` | `runtime-internal` | `none` |
| executar a verificação declarada | `process.execute` | **nova: `local-code-execution`** | `none` |
| criar o branch com o commit medido | `repository.branch.create` | `reversible-change` | `journaled` |

A edição na bancada é `runtime-internal` porque o worktree é diretório operacional do Overcore, não o
recurso do pedido; o schema atual já exige que ações sem `resourceRef` tenham essa classe e nenhum
efeito. O único efeito sobre o recurso do pedido é o ref criado na fase C.

A última ação exige os mesmos quatro controles da substituição de arquivo e da sonda: checkpoint,
verificação, reconciliação e revalidação imediatamente antes do efeito. O checkpoint é o próprio commit
base, endereçado por conteúdo; não há cópia de arquivos para fora do Git.

### O risco da verificação

O comando de verificação executa código do worktree, e esse código pode ter sido alterado pelo agente
na fase A. Se o agente mudar o script `test` do `package.json` ou o próprio teste, o Overcore executa
o que o modelo escreveu. Nenhuma das oito classes atuais de `effectClass` descreve isso: não é leitura,
não é mudança reversível do recurso e não é publicação. Por isso a proposta acrescenta a classe
`local-code-execution` ao contrato de autorização, para o Omni avaliar exatamente esse risco.

Contenção proposta para a v1:

1. a ação `process.execute` é revalidada pelo Omni **depois** da fase A, com o fingerprint do diff
   medido, usando o mesmo mecanismo de revalidação que hoje antecede os efeitos journaled; o Omni
   decide sobre o código que vai rodar, não sobre uma promessa;
2. o processo recebe ambiente saneado: sem `OVERCORE_*`, sem tokens, sem credenciais do Claude e
   sem variáveis de chave de API;
3. `argv` sem shell, diretório de trabalho fixo no worktree, timeout obrigatório e saída truncada no
   relatório;
4. a v1 não oferece sandbox de sistema operacional; o limite honesto é o do usuário que executa o
   serviço, e isso fica declarado no relatório de cada execução.

### Runtime do agente

`AgentRuntimeTool` hoje aceita `Read`, `Glob` e `Grep`. A proposta acrescenta `Edit` e `Write` apenas
quando o passo carrega uma autorização de `repository.worktree.modify`. O guardião `PreToolUse` já
revalida a autorização em cada chamada; passa também a resolver o caminho real de cada ferramenta e a
negar tudo que estiver fora do worktree, fora de `pathScope.include`, dentro de `pathScope.exclude` ou
em `.git`.

### Catálogo

Uma quarta capacidade local, conforme a [ADR-016](ADR-016-catalogo-local-de-capacidades-v1.md):

| Executor | Trabalho coberto | Operações | Efeito |
|---|---|---|---|
| `overcore-repository-change-v1` | mudança de repositório em worktree | `repository.read`, `repository.worktree.modify`, `process.execute`, `repository.branch.create` | journaled |

### `TaskResult`

O registro `effect` atual já comporta o novo efeito sem alteração de schema: `effectKey`,
`intentFingerprint`, `resourceRef`, `operation: repository.branch.create` e os estados `confirmed`,
`not-applied` e `unknown`. O relatório inline traz o branch, o commit, o tree, o diffstat, a lista de
arquivos e a saída resumida da verificação.

## Recuperação

Ao retomar um efeito `applying` ou `unknown`, o Harness lê o ref:

| Estado encontrado | Decisão |
|---|---|
| ref ausente | `not-applied`; revalida a autoridade e cria o ref a partir do commit já medido |
| ref no commit esperado e tree conferido | `confirmed`, sem escrever de novo |
| ref em outro commit | `unknown`; nada é sobrescrito nem apagado |

Uma queda durante a fase A ou B não deixa efeito publicado. A tentativa seguinte recria a bancada a
partir do commit base. Se o recibo durável da tentativa anterior guardou o tree medido e o objeto ainda
existe, a fase C pode prosseguir sem nova chamada ao modelo.

## Cancelamento

- durante a fase A: o sinal chega ao SDK como hoje; o worktree é removido; nenhum journal foi reservado;
- durante a fase B: o processo de verificação recebe término; o worktree é removido;
- durante a fase C: vale o fence persistente da
  [ADR-018](ADR-018-cancelamento-cooperativo-e-reconciliacao-v1.md); a reconciliação lê o ref e
  registra o efeito como confirmado, não aplicado ou incerto.

## Prova exigida para o Marco 3

1. Ciclo de vida do worktree em repositório temporário: criação no commit exato, remoção ao final,
   remoção após falha e após cancelamento.
2. Guarda de caminho: negação de escrita fora do worktree, fora do escopo, em `.git`, por link
   simbólico e por caminho relativo com `..`.
3. Medição: rejeição por excesso de arquivos, de bytes, por binário e por arquivo fora do escopo.
4. Verificação declarada: sucesso, código inesperado e timeout, sem shell; ambiente sem credenciais;
   execução recusada quando a revalidação sobre o diff medido é negada.
5. Recuperação nos três estados do ref, incluindo queda entre `update-ref` e o registro no journal.
6. Idempotência: a mesma `effectKey` não aceita outro tree.
7. Isolamento do proprietário: HEAD, índice, working tree e branches existentes do repositório alvo
   idênticos antes e depois, conferidos por snapshot.
8. Gate real opt-in com PostgreSQL, Omni e Claude por login sobre um repositório descartável criado
   pelo próprio teste, com um defeito conhecido e um teste que falha antes e passa depois.

## Decisões pendentes do proprietário

| # | Decisão | Recomendação |
|---|---|---|
| D1 | permitir comando de verificação declarado na v1, com a nova classe `local-code-execution` | sim, com revalidação do Omni sobre o diff medido, ambiente saneado, `argv` sem shell e timeout; sem verificação a v1 só prova que o diff existe, não que funciona |
| D2 | onde ficam os worktrees | `%LOCALAPPDATA%/Overcore/worktrees/<taskId>`, fora de qualquer repositório, removidos ao final |
| D3 | prefixo reservado de branch | `overcore/` |
| D4 | primeiro uso real depois do gate | o próprio repositório do Overcore, numa tarefa pequena e revisável |

## Consequências

- O Overcore passa a produzir mudanças de código revisáveis sem publicar nada fora da máquina.
- A inteligência da mudança entra no Overcore sem que o modelo toque o repositório do proprietário.
- Agentes, skills, Registry, Graph Engine, DAG e roteamento continuam fora. Este executor é um único
  adaptador no catálogo local, não o início de um sistema de agentes.
