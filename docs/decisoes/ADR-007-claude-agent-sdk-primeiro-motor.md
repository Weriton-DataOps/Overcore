# ADR-007 — Claude Agent SDK como primeiro motor

## Estado

Aceita em 2026-08-31 pelo proprietário.

## Decisão

O primeiro motor agêntico do Overcore é o `@anthropic-ai/claude-agent-sdk` TypeScript, inicialmente
fixado em `0.3.224`. Ele entra atrás da porta neutra `AgentRuntimePort`; nenhuma camada de coordenação
importa detalhes do SDK diretamente.

### Construção limpa

O novo Overcore não recebe cópia literal de módulos do `Overcore Studio`, de `Documents/Agent-SDK`
ou de qualquer implementação anterior. Essas fontes podem ser lidas para extrair requisitos, falhas,
comportamentos úteis e casos de teste. A implementação nasce novamente a partir dos contratos e
fronteiras aprovados nesta pasta.

Reaproveitar uma ideia exige registrar sua finalidade e criar prova nova. Copiar arquivo, árvore de
diretórios ou componente pronto não é uma estratégia de migração autorizada.

```text
Task Manager → outbox → worker → AgentRuntimePort → AnthropicAgentSdkRuntime → Claude
```

O SDK fornece o agent loop, contexto da sessão, ferramentas, streaming, interrupção e eventos. O
Overcore continua responsável por TaskRequest/TaskResult, Task State durável, plano, autorização,
CAS, outbox, critérios, evidências e retomada operacional entre processos.

## Autenticação

A autenticação será sempre o login local do Claude:

- o Overcore não recebe nem persiste chave da Anthropic;
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` e `ANTHROPIC_BASE_URL` são removidos do ambiente entregue
  ao subprocesso;
- a execução continua quando `system/init` declara `apiKeySource: oauth`; na versão `0.3.224`, se o
  campo vier como `none`, o runtime exige a segunda prova `accountInfo.apiProvider: firstParty` junto
  de uma assinatura Claude reconhecida;
- ausência de login ou outra fonte de autenticação bloqueia a execução de forma explícita;
- não existe fallback automático para API key.

Esta decisão descreve o ambiente pessoal e local do proprietário. Caso a Anthropic altere a
disponibilidade do login para o SDK, o gate fica bloqueado e a decisão volta para revisão; o runtime
não troca silenciosamente de cobrança ou credencial.

## Primeira integração

A inspeção dos contratos passa a ter duas partes:

1. o Claude Agent SDK realiza uma leitura agêntica limitada a `Read`, `Glob` e `Grep`;
2. o verificador determinístico faz parse dos schemas e comprova `additionalProperties: false`.

O relatório textual do modelo não decide sozinho que a tarefa passou. Sua sessão, modelo, versão,
fonte de login, uso, custo estimado, negações e digest entram no Task State/TaskResult; a aprovação dos
critérios continua baseada em evidência reproduzível.

## Enforcement

O Omni decide o plano. O Overcore transforma a decisão validada em um envelope de runtime e o SDK
aplica esse envelope nos seguintes pontos (corrigidos pela ADR-020 em 2026-09-23):

- `tools`: remove ferramentas fora da superfície autorizada;
- `allowedTools`: permanece vazio, sem autoaprovação ampla por nome de ferramenta;
- `PreToolUse`: verifica validade do crachá e conjunto autorizado antes de cada chamada, inclusive
  leituras aprovadas nativamente pelo SDK; devolve `{}` quando válido, preservando permissões de caminho;
- `canUseTool`: mantém a checagem quando consultado, mas não é a garantia de interceptação universal.

O gate real e a correção da suposição anterior sobre o callback estão na
[`ADR-020`](ADR-020-preflight-multirrevisao-http.md).

Nesta fase, `settingSources` é vazio e não são enviados agents, skills, plugins ou MCP. Essas camadas
continuam fora até discussão própria.

## Gates

- testes normais usam um dublê do SDK e não consomem o login;
- `npm run test:sdk-live` é opt-in e exige a frase de ambiente
  `OVERCORE_RUN_LIVE_SDK_TEST=I_UNDERSTAND_LOGIN_USAGE`;
- esse gate passou em 2026-08-31 com Claude Max, uma chamada real de `Read` e nenhuma chave de API;
- o gate PostgreSQL real foi aprovado com duas tarefas, dois workers e conflito CAS controlado;
- o teste ponta a ponta final passou em 2026-08-31 como `GR\wp.santos`: PostgreSQL `overcore_test`,
  Authority Provider real do Omni, Claude Max por login, três evidências, `TaskResult` e limpeza
  transacional foram comprovados na mesma tarefa;
- a execução durou `112037 ms`; a consulta posterior encontrou zero tarefas E2E remanescentes.
