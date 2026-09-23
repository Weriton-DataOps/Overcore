# ADR-015 — Sonda PostgreSQL controlada v1

## Status

Aceita e implementada em 2026-09-10.

## Decisão

O segundo efeito executável do Overcore é uma **sonda de schema**, não um executor SQL genérico. Ela
faz somente isto no banco de integração `overcore_test`:

1. cria uma tabela cujo nome começa por `overcore_controlled_probe_`;
2. confirma que a tabela existiu;
3. apaga a mesma tabela na própria transação;
4. confirma que ela não existe após o commit.

O `TaskRequest` precisa declarar o serviço `postgres://local/overcore_test`, o nome exato da tabela e
as permissões `database.schema.modify` e `database.schema.read`. O Omni só libera a dupla quando ela
traz os quatro controles da mutação reversível: checkpoint lógico, verificação, reconciliação e
revalidação imediatamente antes do efeito.

```text
TaskRequest declarado
        |
        v
Omni autoriza modify + read no mesmo serviço
        |
        v
Journal PostgreSQL + revalidação do Omni
        |
        v
BEGIN -> CREATE -> prova de existência -> DROP -> prova de ausência -> COMMIT
        |
        v
TaskResult com recibo e evidências
```

## Por que não SQL arbitrário

Uma porta que aceita SQL livre transforma uma solicitação curta em uma autoridade implícita sobre todo
o banco. A sonda tem intenção estreita e verificável: só a tabela declarada, só no banco de teste, só
com o prefixo reservado e somente durante a transação. Migrações reais, mudanças em tabelas existentes,
DDL de projeto e acesso ao banco `overcore` continuam fora desta capacidade e exigirão contratos próprios.

## Recuperação

Se a transação não concluir, o PostgreSQL faz rollback. Se for encontrada uma tabela inesperada, o
Harness não a remove em retry: registra a divergência como incerta e a deixa visível. Assim, o ciclo
automático não apaga trabalho que não pode provar que é seu.

## Prova

`npm run test:postgres-probe-live` inicia o adaptador local do Omni, usa `overcore_test`, cria e remove
uma tabela gerada pelo teste e verifica a ausência final. O gate requer a variável explícita
`OVERCORE_RUN_POSTGRES_PROBE_E2E=I_UNDERSTAND_LOCAL_TEST_TABLE`.
