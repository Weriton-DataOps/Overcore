# ADR-024 — Sub-executor do Overcore na casa única v1

## Status

Proposta em 2026-11-05 para o bloco E da F4. O contrato veio da sessão do Omni que coordena a casa
(§4.2 do desenho da casa e decisões A e B do E3), com o sub-executor do Oráculo como referência de
forma. O merge depende do ok do proprietário.

Esta ADR completa a [ADR-023](ADR-023-motor-sqlite-da-casa-unica-v1.md), que deixou o sub-executor e a
interface fora do seu escopo.

## Problema

O motor SQLite da ADR-023 deixa o Overcore morar num arquivo só, mas quem cuida desse arquivo na casa é
o executor do Omni: ele instala, atualiza, exporta, importa, verifica e supervisiona o processo. Para
isso, cada agente da casa declara um manifesto (`executor/agente.json`) e responde a seis modos com a
mesma forma de saída. A ilha do Omni monta o painel de cada agente e só fala com a API dele por um
canal único, que confere a rota e põe o token.

## Decisão

### D1. Manifesto

`executor/agente.json` declara `agente: "overcore"`, a versão do `package.json`, `banco: "overcore.db"`,
`migracoes: "migrations-sqlite/"`, `requer` (`node >=24`, `omni>=0.26`), o comando do executor e seus
modos, a `interface` (D5) e listas vazias de `tarefas` e `credenciais`. O Overcore não guarda credencial
própria: os segredos chegam pelo ambiente que o supervisor monta.

### D2. Modos e forma da saída

`node dist/executor/overcore-executor.js <modo>`, com estes modos:

| modo | faz |
|---|---|
| `instalar` | cria a pasta da casa e o banco e aplica as migrações; repetido, não muda nada |
| `atualizar` | aplica as migrações pendentes |
| `verificar [--pacote <pasta>] [--porta <n>]` | integridade, chaves estrangeiras, WAL, migrações; com `--pacote`, compara a casa com o pacote; com `--porta`, confere que a API está de pé e recusa sem token |
| `exportar [--destino <pasta>]` | grava um pacote no formato do Oráculo (D4) |
| `importar <pasta-do-pacote>` | repõe a casa a partir de um pacote (D4) |
| `servir --porta <n>` | o único modo longo (D3) |

Todo modo escreve uma única linha de JSON no stdout. O código de saída é 0 em caso de sucesso, 1 em
caso de erro ou verificação com falha e 2 em caso de uso errado. Uma recusa por regra da casa sai com
`recusa: true` e o motivo em `erro`. Os modos são idempotentes.

O banco fica em `OMNI_CASA_BANCO/overcore.db`; sem essa variável, em `%LOCALAPPDATA%\omni\casa`. Sob o
`node --test`, apontar para a casa real é recusado.

Mudar o banco (`atualizar` com migração pendente ou `importar`) com um processo servindo nele é
recusado, com o processo e a máquina do dono atual. `exportar` e `verificar` só leem e funcionam com o
Overcore no ar.

### D3. `servir`

- Recusa subir se houver migração pendente ou divergente (`migracoes: 'exigir'`): quem migra é o
  `atualizar`, nunca a subida.
- Escuta só em `127.0.0.1` (a config recusa outro host). Com `--porta 0`, o sistema escolhe a porta.
- Toda rota exige o token, inclusive o `/health`, que só fica aberto no `serve` legado.
  `GET /v1/saude` devolve `{agente, versao, motor, iniciado_em}`.
- Quando a porta já está ouvindo, escreve **uma linha** no stdout, `{"ok":true,"porta":n}`, e nada
  mais; o log vai para o stderr. Uma falha na subida sai com `{"ok":false,"erro"}` e código 1.
- Para com código 0 quando o stdin fecha. Fora do Windows, também para com SIGTERM ou SIGINT; com canal
  IPC, também no disconnect. Perder a posse do banco encerra com código 1. O processo não se reinicia:
  isso é papel do supervisor.
- Lê do ambiente `OVERCORE_LOCAL_TOKEN`, `OVERCORE_AUTHORITY_PROVIDER_URL` e
  `OVERCORE_AUTHORITY_PROVIDER_TOKEN`. Nenhum token é escrito no stdout, no stderr ou no disco.

### D4. Pacote

O formato é o do Oráculo: uma pasta `overcore-<carimbo>-<hex6>` com `overcore.db` e `manifesto.json`
(`agente`, `versao`, `migracao`, `migracoes`, `maquina`, `criadoEm`, `tabelas`). `tabelas` registra a
contagem de linhas e o sha256 de cada tabela, na ordem da chave primária.

- `exportar` roda `VACUUM INTO` a partir de uma conexão só de leitura. A cópia apaga a linha de posse
  (`_dono`), que pertence à máquina e fica fora da impressão.
- `importar` confere o banco do pacote contra o manifesto e recusa migração que este código não
  conhece. Se a casa já bate com o pacote, devolve `nadaMudou`. Caso contrário, só entra numa casa sem
  linhas vivas `overcore_*` e sem dono servindo. A troca de arquivo acontece depois que a cópia abriu e
  migrou sem erro; um pacote mais velho recebe as migrações que faltam.

### D5. Interface

`interface` declara `modulo` (`interface/index.html`), `preload` (`interface/overcore-preload.js`),
`painel` e `api`, e uma lista `rotas` de `{metodo, padrao, escopo}`. É com essa lista que o main da ilha
confere cada pedido antes de pôr o token.

- O painel é **só de leitura**: as rotas declaradas são os quatro GETs `/v1/saude`, `/v1/capabilities`,
  `/v1/validation-evidence` e `/v1/tasks/{id}`. Nenhuma rota de escrita (preflight, admissão,
  retomada, cancelamento, `work-once`) sai do manifesto, então um renderer comprometido não cria nem
  move tarefa.
- O preload expõe `window.overcore` e chama `ipcRenderer.invoke('agente:api', {agente:'overcore',
  metodo, rota, corpo})`. A volta é `{status, corpo}`, com status 0 quando o main recusou. Um id de
  tarefa fora do formato é recusado antes de chegar ao main.
- O card `interface/overcore.js` (`resumo(chamar)`) pede a saúde e cai em pé, com `ok: false` e o
  motivo, quando o canal recusa, a API erra ou não há canal.
- O HTML tem CSP `default-src 'none'; script-src 'self'`, sem script inline. Todo dado da API entra na
  tela por `textContent`, nunca como HTML.
- `escopo` é `qualquer` em todas as rotas, porque o Overcore tem um único token local.

**Desvio do plano.** O item E3 do plano pedia a cópia literal dos arquivos do Overcore que estão na ilha
(`overcore.html`, `overcore-janela.js`, `overcore.js`, `overcore-preload.js`), com `ORIGEM.json`, como o
Oráculo fez com o Actions. Essa janela lista e move execuções por `GET /v1/executions` e
`/v1/executions/{id}`, rotas que existem no ramo do Marco 3 e não neste. Portá-la agora significaria
declarar rotas que este ramo não serve. O painel de leitura prova o contrato de ponta a ponta. A porta
da janela da ilha fica para quando os ramos se juntarem (ver Consequências).

### D6. Prova

- `test/executor-modos.test.ts` cobre instalar, atualizar e verificar.
- `test/executor-pacote.test.ts` cobre exportar e importar.
- `test/contrato-omni.test.ts` faz o papel do supervisor contra o processo real: sobe, lê a linha,
  confere 401/200, bate posse e verificar com porta, e para pelo stdin. Além disso, carrega o card e o
  preload como a ilha os carrega e chama o `servir` por um `chamar` que confere a rota contra o
  manifesto.
- `test/interface.test.ts` confere o manifesto, as rotas aceitas e recusadas, o canal único, a CSP e as
  quedas do card.

### D7. Junção com o Marco 3 (emenda de 2026-11-05)

O ramo do Marco 3 ([ADR-022](ADR-022-mudanca-de-repositorio-por-worktree-v1.md)) entrou neste por merge.
O `servir` passa a declarar duas capacidades novas no `/v1/capabilities`, nos dois motores:

| capacidade | o que é |
|---|---|
| `repository-change-worktree-v1` | mudança de repositório por worktree descartável, com branch novo e verificação declarada (ADR-022) |
| `execution-read-view-v1` | leitura das execuções por `GET /v1/executions` e `GET /v1/executions/{id}` |

- **Mudança de repositório ligada também no SQLite.** A fechadura é a mesma do PostgreSQL: sem os grants
  de repositório no pedido, a tarefa bloqueia com `block-repository-request-invalid` antes de plano,
  autorização ou outbox; com o Omni negando, bloqueia com `block-authorization-denied`. Nos dois casos,
  nenhum editor é chamado e nenhuma worktree nasce. A prova está em `test/sqlite-fechadura.test.ts`, que
  traz um controle positivo: o mesmo pedido, com autoridade, chega à outbox no mesmo banco.
- **Um worker por padrão no SQLite.** A casa roda um processo sobre um arquivo, e a escrita do SQLite é
  serial. Por isso `OVERCORE_WORKER_SLOTS` vale 1 por padrão no motor SQLite e continua 2 no PostgreSQL.
  O ambiente manda nos dois motores, de 1 a 8. A prova está em `test/config.test.ts`.
- **Recibo da 009.** A `009_repository_change_receipts.sql` ganhou a equivalente
  `migrations-sqlite/0002_repository_change_receipts.sql`. A `0001` não foi editada. A linha está em
  `migrations-sqlite/EQUIVALENCIA.md`, e `test/sqlite-recibos.test.ts` grava o recibo novo.
- **`listTasks` no SQLite.** A leitura das execuções lista tarefas. A suíte de contrato cobre a ordem
  (mais recente primeiro, desempate pelo id), o limite e o filtro por estado nos motores.
- **O painel continua só de leitura.** As rotas de `/v1/executions` existem, mas ainda não entram em
  `interface.rotas`. A cópia da janela da ilha, com retomar e cancelar, espera a decisão do proprietário
  sobre abrir escrita ao painel (ver Consequências).

## Consequências

- O executor do Omni consegue instalar, supervisionar, exportar e importar o Overcore sem conhecer o
  esquema dele.
- Quando o ramo do Marco 3 se juntar a este, a janela da ilha passa para `interface/` como cópia com
  `ORIGEM.json`. O preload e o card são adaptados ao `agente:api`, e `rotas` ganha
  `GET /v1/executions`, `GET /v1/executions/{id}` e os POSTs de retomada e cancelamento. É uma decisão
  consciente de abrir escrita ao painel, com escopo próprio se o Overcore passar a ter mais de um token.
  O card passa então a devolver a forma que a ilha já desenha (`total`, `rodando`, `bloqueadas`,
  `linhas`, `sessoes`).
- O corte real (E4 do plano: casa real e importação dos dados do PostgreSQL) continua dependendo da casa
  criada pela F1 do Omni e do ok do proprietário.

## Pontos abertos com a sessão do Omni

1. Nomes das variáveis que o supervisor injeta: o Overcore espera as três da D3; o Oráculo usa
   `OMNI_API`.
2. `verificar` não devolve `percentual`; o do Oráculo devolve.
3. Não há `importar --da-maquina`: o Overcore não tem dado legado em arquivo para colher. A importação
   do PostgreSQL atual é o corte do E4.
