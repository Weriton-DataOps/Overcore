# PostgreSQL local do Overcore

## O que ele faz

O PostgreSQL é a memória operacional durável do Overcore. Antes da admissão, guarda drafts e
relatórios do Preflight. Depois da admissão, guarda a tarefa, seu estado, o plano ativado, a
autorização do Omni, o histórico de eventos e a outbox usada pelos trabalhadores.

```text
Task Manager
    |
    +--> corrente + revisões do Preflight
    +--> tarefa + Task State
    +--> plano + autorização
    +--> eventos
    `--> outbox ----> workers concorrentes
```

A sessão do Claude Agent SDK não substitui esse banco. A sessão ajuda o modelo a continuar uma
execução; o PostgreSQL diz qual é a verdade operacional mesmo depois de queda ou reinício.

## Instalação desta máquina

| Item | Valor |
| --- | --- |
| Servidor | PostgreSQL 18, serviço Windows `postgresql-x64-18` |
| Endereço | `127.0.0.1:5432` |
| Banco operacional | `overcore` |
| Banco de integração | `overcore_test` |
| Role da aplicação | `overcore_app`, sem superusuário, criação de role ou criação de banco |
| Autenticação | `scram-sha-256` |

O banco de teste é separado porque gates de integração criam e removem registros. Isso impede que
uma verificação destrutiva contamine tarefas reais.

As revisões do Preflight são append-only: a tabela de corrente muda apenas o ponteiro da última
revisão; os documentos antigos recusam `UPDATE`. Isso preserva a origem de perguntas, respostas e
fingerprints sem transformar conversa bruta em dado operacional.

## Onde ficam as credenciais

- `OVERCORE_DATABASE_URL` e `OVERCORE_TEST_DATABASE_URL` ficam no ambiente do usuário Windows;
- a credencial administrativa fica no Gerenciador de Credenciais com o nome
  `Overcore.PostgreSQL.Admin`;
- nenhum segredo fica no repositório, no README ou nos exemplos versionados;
- terminais que estavam abertos antes do provisionamento precisam ser reabertos para herdar as
  variáveis novas.

O runtime usa `overcore_app`. A conta administrativa não é usada pela aplicação.

## Comandos

Aplicar ou conferir migrations no banco operacional:

```powershell
npm run build
npm run migrate
```

Executar o gate no banco isolado de teste:

```powershell
npm run test:postgres
```

O migrador registra nome e SHA-256 de cada arquivo. Uma migration aplicada nunca deve ser reescrita;
uma alteração posterior nasce em um novo arquivo numerado.

## Por que não existe SQLite nem broker agora

PostgreSQL já entrega transação, JSONB, CAS e reivindicação concorrente da outbox com
`FOR UPDATE SKIP LOCKED`. SQLite criaria um segundo comportamento de persistência, e um broker
adicionaria outra fonte operacional antes de existir necessidade comprovada.

## Limite desta etapa

Banco funcionando não significa que o Overcore completo está ligado. O gate final ainda precisa da
porta real de autoridade do Omni e de uma execução conscientemente autorizada pelo login Claude.
