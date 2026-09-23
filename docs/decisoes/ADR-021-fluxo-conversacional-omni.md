# ADR-021 — Cliente conversacional no Omni

Data: 2026-09-23. Estado: implementado e validado tecnicamente; conversa humana ainda por validar.

## Decisão e fronteira

O Omni conversa e estrutura o pedido. O Overcore continua um ambiente independente:

```text
Conversa Omni → cliente HTTP → Preflight Overcore
      ↑                             ↓
respostas do dono ← decisões agrupadas
      ↓
mesmo draft, nova revisão → admissão → execução → resultado → conversa de origem
```

O cliente fica em `Omni/src/adapters/overcore/task-flow.ts`, compartilhado pelo operador
`overcore` do plugin e pela ação `overcore` do coordenador Desktop. Núcleo de personalidade e
memória não importa componentes do Overcore. O cliente não chama o worker global nem passa a
executar o plano: o serviço Overcore possui sua fila e seu worker.

O vínculo local é persistido fora do Git, por conversa e intenção. IDs, fingerprints, datas e
revisões são gerados pelo cliente. Retentativa repete o documento exato; decisões são associadas
ao relatório que as originou. Respostas precisam materializar as escolhas, não apenas marcar IDs.
`ready` admite o pedido autorizado automaticamente. Resultado final exige identidade correspondente,
estado, resumo, critérios e evidências, em vez de confiar na promessa produzida pelo modelo.

No Desktop, o observador lê tarefas admitidas e entrega o retorno no chat original, deduplicado
inclusive após reinício. No plugin, o hook recupera o índice e a sessão consulta `follow`; não há
um daemon capaz de escrever espontaneamente numa sessão Claude fechada.

## Operação local

`scripts/start-local.mjs <pasta-absoluta-do-Omni>` supervisiona somente a autoridade HTTP e o serviço
Overcore iniciados por ele. Exige `OVERCORE_DATABASE_URL` no ambiente do usuário, build dos dois
projetos e login Claude. Nunca precisa de senha de administrador. O launcher usa Discovery `advisor`;
o padrão geral do runtime isolado permanece `baseline`.

Endpoint dinâmico: `%LOCALAPPDATA%/Overcore/runtime.json`. Token privado:
`%LOCALAPPDATA%/Overcore/client-private.json`, jamais dentro do repo, chat ou TaskDraft. O cliente
aceita apenas HTTP loopback literal, sem redirecionamento. Variáveis `OVERCORE_URL` e
`OVERCORE_LOCAL_TOKEN` continuam disponíveis para isolamento de testes.

O launcher não é um serviço Windows e não configura inicialização automática no login. Para uso
manual, execute-o em terminal próprio; para segundo plano no Windows, use `Start-Process` com
`-WindowStyle Hidden`, mantendo stdout/stderr separados do contexto. Preserve uma instância ativa.
Os logs não devem receber credenciais. O arquivo privado da instalação local teve acesso limitado
ao proprietário e SYSTEM.

Em 23/09, o banco operacional `127.0.0.1:5432/overcore` estava sem tarefas; o serviço foi iniciado.
Verificação: saúde HTTP 200, rota autenticada sem token HTTP 401, tarefa inexistente com token HTTP
404. Isso prova saúde/conexão, não execução de uma tarefa operacional do proprietário.

## Evidência

- Overcore: `npm.cmd run verify`, 98/98 testes locais e build.
- Omni: 50/50 testes TypeScript; 11/11 testes de pacote; teste do adaptador runtime/contexto.
- Desktop: 231/231 testes, incluindo decisões no mesmo chat e retorno deduplicado após reinício.
- Integração real: `npm.cmd run test:omni-flow-live`, opt-in `OVERCORE_RUN_OMNI_FLOW=I_UNDERSTAND_LOGIN_USAGE`,
  `OVERCORE_OMNI_REPOSITORY_PATH` e `OVERCORE_TEST_DATABASE_URL` apontando somente para `overcore_test`.
  Usa schema temporário, autoridade real, cliente produtivo Omni e SDK OAuth; limpa os dados do cenário.
- Ensaio `flow-1790194106920.json`: três perguntas, `decisions-required → running → succeeded`,
  uma tarefa, três chamadas OAuth, nenhuma negação de ferramenta. Reenvio preservou a identidade;
  a segunda chamada do worker não encontrou outra tarefa. Respostas do proprietário roteirizadas.
- Dois ensaios anteriores ficaram reprovados porque a descrição do alvo do cenário era ambígua;
  o cenário foi esclarecido, sem enfraquecer a Discovery ou suprimir decisões.
- As repetições `flow-1790194417249.json` e `flow-1790194489128.json` também foram reprovadas:
  a primeira pediu distinguir reprovação de mero inventário; a segunda repetiu a pergunta de
  escopo apesar da resposta materializada. O cenário passou a declarar as condições de aprovação,
  e o assessor recebeu uma distinção explícita, com exemplo/contraexemplo, entre rótulo do protocolo
  e resposta substantiva na revisão. Nenhuma pergunta é descartada pelo cliente por tema.
- Gate final `flow-1790194625698.json`: **aprovado**, cerca de 54,9 segundos, já com validação
  de identidade/fingerprint do resultado no cliente. As falhas anteriores permanecem como evidência;
  esse resultado não garante ausência de perguntas redundantes em outras conversas.

## Limites deliberadamente visíveis

Não há novos agentes, Registry, Graph Engine ou executor genérico. As capacidades disponíveis
continuam sendo as documentadas em `docs/arquitetura/05-capacidades-de-executor-v1.md`.
Roteamento semântico em conversa humana e comportamento sob pedidos reais ainda exigem uso observado.
A build Desktop precisa estar carregada; código no disco não atualiza processos já abertos.
Na validação inicial, nenhum commit, push ou reinstalação de plugin havia sido realizado.
O fechamento posterior está registrado em [Fechamento da ligação](../operacao/fechamento-ligacao-omni.md).
Publicar o servidor Overcore não equivale a instalar ou carregar o cliente Omni.
