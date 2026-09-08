# OverCore

O OverCore é um ambiente independente de coordenação e execução de trabalho de desenvolvimento.
Ele recebe uma tarefa estruturada, planeja como executá-la, solicita ao provedor de autoridade a
autorização para o plano exato, aplica essa decisão, verifica o resultado e devolve evidências ao
chamador.

## Fronteira principal

```text
cliente (Omni será o primeiro)
        |
        v
TaskDraft v1
        |
        v
Preflight -> TaskReadinessReport v1
        |
        v
TaskRequest v1
        |
        v
OverCore
  recebe -> persiste -> cria Execution Plan -> pede autorização -> aplica -> executa -> verifica
                                                   |
                                                   v
                                    Authority Provider (Omni primeiro)
        |
        v
TaskResult v1
        |
        v
cliente
```

Antes do `TaskRequest`, o Task Manager recebe um `TaskDraft v1` e executa o Preflight. Decisões
previsíveis são agrupadas em `TaskReadinessReport v1`; somente um relatório `ready` contém o
`TaskRequest` congelado que pode seguir para admissão. O Preflight executável, a validação de domínio
e a porta neutra de Discovery já estão ligados. A implementação atual de Discovery é determinística e
somente de leitura; ela não é o futuro Agente de Discovery. Drafts e relatórios ficam persistidos no
PostgreSQL em revisões imutáveis, de acordo com a
[`ADR-009`](docs/decisoes/ADR-009-preflight-persistente-append-only.md).
O handoff explícito por `reportId`, sem transportar novamente o request, está registrado na
[`ADR-010`](docs/decisoes/ADR-010-handoff-ready-por-report-id.md).

O OverCore não conduz conversa para descobrir a intenção do usuário. Antes da execução, lacunas
previsíveis voltam como `TaskReadinessReport decisions-required`; o chamador decide como obter as
respostas e envia uma nova revisão. `TaskResult blocked` fica reservado para impedimentos encontrados
depois que uma tarefa já foi admitida.

## O que pertence ao OverCore

- ciclo de vida persistente da tarefa;
- coordenação de passos e tentativas;
- seleção de executores por capacidade declarada;
- execução controlada, cancelável e verificável;
- referências a evidências e artefatos;
- retomada sem repetir efeitos já confirmados.

## O que não pertence ao OverCore

- chat, personalidade ou memória pessoal do Omni;
- componentes internos do Omni;
- Oracle ou qualquer dependência obrigatória dele;
- interpretação aberta da intenção do usuário;
- implementação antecipada de dezenas de serviços sem uso comprovado.

## Estado atual

**Marco 1 — fundação executável em validação.** A base usa TypeScript estrito sobre Node.js 24 LTS,
PostgreSQL 18, JSON Schema/Ajv nas fronteiras, HTTP local em loopback e o Claude Agent SDK TypeScript
como primeiro motor agêntico. A cadeia pública continua:

- [`contratos/task-draft.schema.json`](contratos/task-draft.schema.json);
- [`contratos/task-readiness-report.schema.json`](contratos/task-readiness-report.schema.json);
- [`contratos/task-request.schema.json`](contratos/task-request.schema.json);
- [`contratos/task-result.schema.json`](contratos/task-result.schema.json);
- [`contratos/authorization-request.schema.json`](contratos/authorization-request.schema.json);
- [`contratos/authorization-decision.schema.json`](contratos/authorization-decision.schema.json).

`TaskDraft` entra na preparação, `TaskReadinessReport` sai do Preflight, `TaskRequest` entra na
execução e `TaskResult` comunica seu desfecho. O significado de cada campo do pedido executável está em
[`docs/contratos/task-request-v1.md`](docs/contratos/task-request-v1.md).
O contrato de saída está explicado em
[`docs/contratos/task-result-v1.md`](docs/contratos/task-result-v1.md).
O processo que transforma um rascunho em tarefa pronta está em
[`docs/contratos/task-preflight-v1.md`](docs/contratos/task-preflight-v1.md).
As mutações adversariais que comprovam as fronteiras do Preflight estão em
[`contratos/testes/preflight-domain-mutations.json`](contratos/testes/preflight-domain-mutations.json).

Depois da admissão, o estado interno persistente é o
[`Task State v1`](docs/internos/task-state-v1.md). Ele mantém o ciclo de vida, tentativas, efeitos e
suas origens append-only, além de checkpoints, sem transformar detalhes internos em entrada pública.

Entre `planning` e `ready`, o
[`Execution Plan v1`](docs/internos/execution-plan-v1.md) transforma o request em passos lineares,
efeitos declarados e verificações. O plano já está ligado às tentativas, execuções de passo, efeitos e
checkpoints do Task State. A primeira estratégia executável inspeciona os contratos do próprio
Overcore em modo somente leitura.

Depois que o plano existe, [`Authorization v1`](docs/contratos/authorization-v1.md) fecha a fronteira
de autoridade: o Overcore expõe o plano inteiro por `AuthorizationRequest`, o Omni decide por
`AuthorizationDecision` e o Overcore persiste e aplica
[`Authorization Enforcement`](internos/authorization-enforcement.schema.json). O crachá pessoal fica
privado no Omni; o Overcore recebe somente uma autorização mínima, temporária e presa à revisão exata
do plano. O vínculo já faz parte do `activePlanBinding`: tentativa e dispatch são rejeitados quando o
enforcement falta, diverge, expirou, não cobre a ação ou perdeu a validade por revogação. A porta de
transporte HTTP do Overcore e o adaptador HTTP para o Authority Provider foram implementados. O
endpoint correspondente do Omni foi validado no gate ponta a ponta real.

O [`Task Manager v1`](docs/internos/task-manager-v1.md) fecha a coordenação dessas peças sem criar um
segundo estado: Preflight, admissão, planning, autorização, ativação, tentativa, dispatch,
verificação, recovery, bloqueio, cancelamento e resultado são vinte situações reproduzíveis. O Manager
coordena portas; não conversa, não autoriza e não executa ferramenta.

A primeira fatia executável está definida em
[`docs/arquitetura/01-primeira-fatia.md`](docs/arquitetura/01-primeira-fatia.md).
As decisões de runtime, banco, portas e ferramentas estão registradas em
[`ADR-006`](docs/decisoes/ADR-006-fundacao-executavel-v1.md), com mapa didático em
[`docs/arquitetura/02-fundacao-executavel.md`](docs/arquitetura/02-fundacao-executavel.md).
A posição e a autenticação do motor estão na
[`ADR-007`](docs/decisoes/ADR-007-claude-agent-sdk-primeiro-motor.md).

### O que já foi provado localmente

- validação dos contratos públicos no runtime;
- ciclo `TaskRequest → plano → autorização → Task State → outbox → execução → TaskResult`;
- idempotência e rejeição de escritor com revisão CAS antiga;
- rejeição de decisão do Omni cujo fingerprint não corresponde ao conteúdo;
- workers concorrentes reivindicando itens diferentes na implementação de teste;
- PostgreSQL 18 real com migrations imutáveis, persistência e outbox transacional;
- dois workers reais distribuindo duas tarefas sem duplicação;
- duas gravações concorrentes no mesmo estado, com rejeição da revisão CAS obsoleta;
- API local autenticada e adaptador do Authority Provider restrito a loopback;
- `AgentRuntimePort` com adaptador real para o Claude Agent SDK TypeScript;
- autenticação contratada exclusivamente por login OAuth, com chaves de API removidas do subprocesso;
- autorização do Omni propagada até `tools` e `canUseTool`, com `allowedTools` vazio para impedir
  autoaprovação antes do crachá;
- sessão, versão, modelo, consumo, custo estimado e evidência do SDK ligados ao Task State/TaskResult;
- `TaskDraft → Preflight → TaskReadinessReport`, com os sete checks, decisões agrupadas e emissão de
  `TaskRequest` somente quando todos passam;
- endpoint local `POST /v1/preflight` sem criar tarefa, plano, tentativa ou mensagem de outbox;
- admissão explícita por `POST /v1/preflight/{reportId}/admit`, recuperando e revalidando o
  `TaskRequest` congelado sem permitir edição no caminho;
- concorrência de admissão convergindo para uma única tarefa e uma única mensagem de outbox;
- rejeição de relatório não pronto, ultrapassado ou de chave reaproveitada com outro request;
- persistência append-only de drafts e relatórios, recuperação automática entre instâncias,
  idempotência e CAS entre revisões concorrentes;
- retomada automática de tarefas interrompidas em `accepted`, `planning` ou `ready`, com lease
  expirável, releitura de plano/autorização e uma única outbox mesmo entre instâncias concorrentes;
- recovery de coordenação com backoff persistente, erro visível, renovação automática de autorização
  vencida, `TaskResult blocked` e retomada explícita para uma fase segura;
- recovery da execução somente leitura com heartbeat do lease, recibo durável, reentrega com backoff,
  plano revisado, nova autorização, retry por orçamento e `TaskResult failed` terminal;
- rejeição das 14 mutações adversariais declaradas para o domínio do Preflight;
- build e typecheck estritos.

O comando `npm run demo:inspection` executa essa fatia em memória e deixa explícito que ela não prova
PostgreSQL nem integração com o Omni. O PostgreSQL é provado separadamente por `npm run test:postgres`.
Ele também usa o executor determinístico: nenhuma resposta Claude é consumida pela demonstração.

### Estado dos gates

- o endpoint real do Omni recebe `AuthorizationRequest v1` e devolve `AuthorizationDecision v1`;
- `npm run test:sdk-live` passou com Claude Max por login, sem chave de API, em 2026-08-31;
- o gate ponta a ponta passou em 2026-08-31 como `GR\wp.santos`, sem privilégio administrativo:
  PostgreSQL, Authority Provider real do Omni, Claude Max por login, verificação determinística,
  `TaskResult` e limpeza final funcionaram na mesma tarefa;
- o Preflight persistente e seu handoff para o Task State passaram nos gates local e PostgreSQL real.

## Regra de crescimento

### Construção limpa

O `Overcore Studio` e o repositório antigo `Documents/Agent-SDK` são referências de requisitos e
lições, não fontes para copiar código. O novo Overcore é implementado do zero a partir dos contratos
atuais, com testes e decisões próprias. Nenhum componente antigo entra apenas porque já existe.

Um conceito só vira componente independente quando houver comportamento, estado ou ciclo de vida
próprio comprovado. Até lá, Planner, Scheduler e Router podem ser funções internas do Coordenador.

Agentes, skills, modelos, ferramentas, capabilities e procedures não serão selecionados nem
organizados antecipadamente. Quando uma dessas camadas se tornar necessária, sua definição,
responsabilidade, contrato, diretórios e Definition of Done serão discutidos passo a passo antes da
implementação.

## Próximo passo

O Preflight, o handoff idempotente, a retomada da coordenação e o recovery da primeira execução
somente leitura estão fechados. O próximo desenho é o **Harness de efeitos v1**: journal,
`effectKey`, checkpoint, confirmação e reconciliação de efeito incerto antes da primeira ferramenta
que possa escrever. Essa fronteira será discutida antes de virar código. Agentes, skills, Registry e
Graph Engine continuam fora.

O futuro Agente de Discovery continua reservado pela
[`ADR-008`](docs/decisoes/ADR-008-discovery-adaptativa-no-preflight.md). Agentes, skills, modelos, Graph
Engine, Registry e routing permanecem fora desta etapa.

## Operação local

- [PostgreSQL local](docs/operacao/postgresql-local.md): serviço, bancos, credenciais, migrations e gates.

Com o servidor ativo, o cliente usa a persistência real por:

```powershell
node dist/main.js preflight contratos/exemplos/task-draft-incompleto.json
node dist/main.js admit <report-id-ready>
node dist/main.js resume <task-id-bloqueada>
```

Pela API local, envie somente `{ "draft": ... }` para `POST /v1/preflight`. Quando o resultado for
`ready`, envie somente o identificador para `POST /v1/preflight/{reportId}/admit`. O Overcore encontra
o histórico e o request congelado no PostgreSQL. A antiga admissão direta por `POST /v1/tasks` foi
aposentada. `npm run demo:preflight` continua disponível como demonstração isolada em memória e não
comprova persistência.
