# ADR-020 — Preflight multirrevisão pela API local

- Data: 2026-09-23
- Escopo: teste de integração do contrato existente; sem nova interface ou agente.

## O que faz e por quê

Confere que um pedido incompleto pode receber decisões agrupadas e continuar depois da resposta,
sem perder o histórico, autorizar trabalho prematuramente ou executar duas vezes por reenvio.

```text
cliente de teste -> HTTP -> draft revisão 1 -> decisões pendentes
                          PostgreSQL guarda o relatório
                          nova instância recupera o histórico
cliente de teste -> HTTP -> revisão 2 com respostas e conteúdo atualizado
                          -> ready -> admissão por reportId
                          -> Omni autoriza o plano
                          -> worker executa leitura via Claude OAuth
                          -> resultado persistido da única tarefa
```

Antes da admissão existe uma identidade `draftId`, não uma tarefa em execução. As duas revisões
conservam esse `draftId` e a chave da futura execução. Só depois de `ready` nasce um único `taskId`.

## Fronteira comprovada — e o que ainda não está ligado

O código atual do Omni fornece o **provedor de autoridade**. Não foi encontrado cliente de
`TaskDraft`/`TaskReadinessReport` ligado à conversa do Omni. Logo, este gate usa cliente HTTP e
respostas pré-definidas pelo cenário. Não equivale a uma sessão real do Omni conversando com o usuário.

O teste usa o adaptador existente em `Omni/adaptadores/overcore-authority-http.mjs`, sem modificar
o repositório do Omni ou suas sessões. A futura ponte conversacional deve enviar o draft, apresentar
as decisões, preencher a nova revisão com a resposta efetiva e acompanhar o `taskId` após admissão.
Essa integração não deve colocar personalidade, memória ou UI dentro do Overcore.

## Verificações

- duas decisões mínimas no primeiro pacote: prova de sucesso e formato da entrega;
- chamada real do assessor em cada revisão; fallback não conta como aprovação do gate;
- nenhum TaskRequest executável nem autorização antes da resposta;
- reenvio de revisão idêntica devolve o relatório original, sem nova chamada do modelo;
- outra instância de HTTP/Manager/Store recupera o histórico persistido;
- fingerprint adulterado e pacote com resposta faltando são rejeitados antes do modelo;
- a revisão respondida registra os critérios e a saída, não apenas IDs de opções;
- relatório anterior continua íntegro e imutável;
- duas admissões concorrentes resultam na mesma tarefa;
- somente uma autorização persistida, uma tentativa de execução e um recibo;
- novo pedido de trabalho encontra a fila vazia e não repete a execução;
- os dois arquivos de contrato do cenário permanecem byte a byte iguais;
- execução com `Read` observado e nenhuma ferramenta negada; cada chamada observada passa pelo
  `PreToolUse` com rechecagem do crachá antes da permissão nativa do SDK.

## Isolamento e execução

```powershell
# Somente no processo do terminal, sem gravar configuração global:
$env:OVERCORE_TEST_DATABASE_URL = [Environment]::GetEnvironmentVariable('OVERCORE_TEST_DATABASE_URL', 'User')
$env:OVERCORE_OMNI_REPOSITORY_PATH = 'C:\Users\wp.santos\Documents\Omni'
$env:OVERCORE_RUN_PREFLIGHT_ROUNDTRIP = 'I_UNDERSTAND_LOGIN_USAGE'
npm.cmd run test:preflight-roundtrip-live
```

O gate exige banco local chamado exatamente `overcore_test`. Cria schema aleatório exclusivo,
aplica nele as migrations existentes e remove somente esse schema ao terminar. Os contratos usados
na leitura são dois arquivos públicos fictícios em diretório temporário próprio. As portas HTTP
também são temporárias; nenhum serviço existente é encerrado ou reconfigurado.

São previstas duas chamadas de Discovery sem ferramentas e uma execução de leitura, via OAuth.
O SDK não persiste essas sessões de teste no histórico. O orçamento temporal do cenário é cinco
minutos, compatível com a autorização atual; cada chamada tem teto de USD 0,75 pela estimativa SDK.
Isso não comprova cobrança adicional da assinatura. O gate não é incluído em `npm test`.

O mesmo roteiro roda nos testes locais com memória, provedor de autoridade e runtime simulados.
Relatório do ensaio real: `.overcore-runtime/evaluations/preflight/`, ignorado pelo Git.

## Correção encontrada no teste

Um orçamento de três minutos com uma autorização de cinco minutos era rejeitado, mas classificado
como erro interno temporário. Isso causava backoff e repetição do mesmo plano incompatível.

Agora uma decisão bem formada, mas incompatível com o pedido, vira
`authority-provider-incompatible-decision`: a tarefa apresenta a causa de bloqueio e não repete
automaticamente a mesma negociação inválida. O chamador pode corrigir a condição e usar a retomada
existente. Os limites não foram ampliados, o contrato não mudou e a autoridade segue no Omni.

Negações, expiração e decisões ainda não vigentes mantêm seus tratamentos específicos. Negociação
dinâmica de orçamento menor com o Omni não foi implementada nesta etapa; o gate positivo usa os
cinco minutos previstos pelo provedor atual.

### Corrida na primeira admissão PostgreSQL

Duas admissões inéditas do mesmo `reportId` podem tentar inserir simultaneamente a mesma tarefa.
O PostgreSQL pode apontar primeiro o conflito de `task_id`, `request_id` ou `idempotency_key`.
O adaptador tratava somente a última constraint; a outra requisição recebia HTTP 400 apesar de
representar exatamente o mesmo trabalho.

Agora as três constraints da tabela de tarefas são reconhecidas. Após rollback, o adaptador confere
a chave idempotente recebida e devolve a duplicata identificada; o Task Manager ainda compara todo
o pedido antes de reaproveitar a tarefa. Colisões sem a mesma chave ou de outras constraints não são
engolidas. Essa conferência reutiliza a conexão já adquirida, evitando exigir uma segunda conexão
durante uma rajada concorrente.

### Ajustes no roteiro, não no produto

As primeiras rodadas também identificaram respostas incompletas do cliente de teste: profundidade
do relatório, recursão e seleção automática da opção recomendada de artefato persistente, em conflito
com o resultado somente em memória. O roteiro passou a responder explicitamente esses pontos e a
selecionar `Não produzir artefato`/`no-artifact`. O assessor não foi alterado para forçar `ready`.

Isso reforça a responsabilidade do futuro cliente Omni: responder à pergunta concreta e materializar
a escolha na revisão, em vez de preencher IDs de opções indiscriminadamente.

### Checagem do crachá nas ferramentas

O ensaio mostrou chamadas `Read`/`Glob` no fluxo do modelo sem evento do callback `canUseTool`.
`allowedTools: []` não obriga esse callback: o SDK pode aprovar leitura no diretório de trabalho e,
em `dontAsk`, negar outras chamadas sem consultá-lo. A ordem é documentada em
[Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

Foi acrescentado `PreToolUse` para conferir expiração e conjunto autorizado em todas as chamadas.
Quando o crachá está válido, o hook devolve `{}` e mantém a decisão de caminho do SDK; não força
`allow`, não liga bypass e não aumenta as ferramentas disponíveis. O gate real compara as chamadas
do modelo com as checagens do hook. Teste local também simula expiração entre duas leituras.

Negações internas do SDK agora geram evento com nome da ferramenta, sem copiar argumentos privados.
Uma rodada anterior concluiu deterministicamente, mas falhou no gate por negação; ela permanece nos
relatórios. O cenário passou a usar `realpath` no diretório temporário para eliminar aliases curtos
do Windows. Sem os argumentos daquela negação, não se afirma que o alias foi sua causa comprovada.

## Resultado

Rodada final concluída em `2026-09-23T18:28:11.312Z`, em aproximadamente **53,2 segundos**.
Relatório local: `.overcore-runtime/evaluations/preflight/roundtrip-1790188038099.json`.

- `decisions-required → ready → succeeded`: duas decisões respondidas na rodada final;
- PostgreSQL confirmou um draft, duas revisões, uma tarefa, uma autorização e um recibo;
- uma execução, mesmo com duas admissões simultâneas e posterior reenvio;
- duas chamadas de Discovery e uma de execução, todas via OAuth, sem fallback;
- modelo observado: `claude-opus-5[1m]`; SDK `0.3.224`; não constitui escolha definitiva de modelo;
- quatro `Glob` e dois `Read`, todos com rechecagem no `PreToolUse`, nenhuma negação;
- nenhum arquivo do cenário modificado; schema e diretório temporários removidos;
- estimativa do SDK da rodada final: **USD 0,2439045**, não prova de cobrança extra da assinatura;
- build limpa: somente `dist` e `.test-dist` gerados foram removidos e recriados;
  `npm.cmd run verify` passou com TypeScript, **98/98 testes locais** e build;
- regressões PostgreSQL: **2/2**, incluindo CAS, fila concorrente e recuperação do journal;
- ensaio anterior positivo está em `roundtrip-1790187896356.json`; os quatro relatórios anteriores
  de falha foram preservados, sem reclassificá-los como aprovados.

O padrão global continua `baseline`. Nenhum arquivo do Omni foi alterado; nenhum commit ou push
foi realizado. As revisões deste teste provam o contrato técnico, não a conversação integrada.

### Próximo passo delimitado

Atualização: a ligação descrita abaixo foi implementada na [ADR-021](ADR-021-fluxo-conversacional-omni.md).
O registro dos testes desta ADR permanece histórico, sem reclassificar seus resultados.

Implementar **no Omni** o cliente conversacional do contrato já validado: enviar `TaskDraft`, mostrar
o pacote de decisões, incorporar a resposta efetiva em nova revisão, admitir por `reportId` quando
`ready` e acompanhar o resultado pela mesma identidade. Validar depois com uma conversa real.
Não adicionar UI, novos agentes, skills, Registry ou Graph Engine ao Overcore para isso.
