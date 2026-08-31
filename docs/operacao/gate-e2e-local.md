# Gate local PostgreSQL + Omni + Claude Agent SDK

## Ambiente

O gate roda em três processos locais independentes:

```text
PostgreSQL 18 (overcore_test)
             ^
             |
Overcore worker ---- HTTP loopback ----> adaptador de autoridade do Omni
       |
       `---- Claude Agent SDK por login local comprovado
```

O teste inicia o adaptador a partir do repositório do Omni, entrega um token efêmero somente aos dois
processos e usa uma porta livre escolhida pelo Windows. Nenhuma memória ou conversa do Omni entra na
tarefa.

## Tarefa

A tarefa inspeciona em modo somente leitura os JSON Schemas do novo Overcore. O Omni autoriza somente
as ações de leitura e montagem do relatório; o Overcore aplica o crachá; o SDK escolhe e usa apenas
`Read`, `Glob` e `Grep`; o verificador determinístico decide os critérios.

## Proteções

- exige `overcore_test`, nunca o banco operacional;
- exige habilitação explícita porque consome uma resposta do login Claude;
- apaga os registros da tarefa de teste no final;
- encerra o adaptador do Omni mesmo em falha;
- não persiste o relatório bruto do modelo;
- não altera arquivos do projeto.
- não aceita chave de API nem confunde `apiKeySource: none` com anonimato: nesse caso exige que o
  próprio SDK confirme conta `firstParty` com assinatura Claude reconhecida.

## Diagnóstico de autenticação

O binário Claude Code e o Agent SDK `0.3.224` podem relatar a mesma sessão de formas diferentes. Na
máquina atual, `claude auth status` confirmou Claude Max, enquanto `system/init.apiKeySource` retornou
`none`; `query.accountInfo()` confirmou `firstParty` e `Claude Max`. O gate aceita essa combinação
como prova de login, mas continua rejeitando fontes `user`, `project`, `org` e `temporary`.

O gate isolado `npm run test:sdk-live` passou em 2026-08-31: o Claude Max leu `package.json` por
`Read`, concluiu em um turno e não produziu o aviso de ferramenta autoaprovada.

## Comando

O gate é intencionalmente opt-in:

```powershell
$env:OVERCORE_RUN_LIVE_E2E='I_UNDERSTAND_LOGIN_USAGE'
$env:OVERCORE_OMNI_REPOSITORY_PATH='C:\Users\wp.santos\Documents\Omni'
npm run test:e2e-live
```

`OVERCORE_TEST_DATABASE_URL` precisa existir no ambiente do usuário, conforme o provisionamento do
PostgreSQL local.

## Resultado comprovado

Em 2026-08-31, o gate passou como `GR\wp.santos`, sem privilégio administrativo, em `112037 ms`:

- PostgreSQL `overcore_test` persistiu plano, autorização e estado;
- o Omni respondeu como `omni-authority-provider` com `permit-with-constraints`;
- o Claude Agent SDK executou por `oauth-login` e produziu três evidências;
- o verificador determinístico aprovou a inspeção e produziu `TaskResult`;
- o bloco `finally` encerrou o Omni e apagou a tarefa; uma consulta posterior encontrou zero tarefas
  `req-e2e-omni-claude-*` remanescentes.
