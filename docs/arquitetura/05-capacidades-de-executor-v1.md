# Capacidades de executor v1

## O que mudou

Antes, o `TaskWorker` conhecia diretamente os três executores existentes. Agora ele consulta um Catálogo local de Capacidades antes do dispatch.

```text
mensagem da outbox
      |
      v
capacidade necessária
  - operação
  - tipo de efeito
      |
      v
Catálogo local
      |
      +--> compatível: Worker chama o adaptador
      `--> ausente: dispatch é recusado antes de qualquer efeito
```

## As capacidades atuais

| Executor | Trabalho coberto | Operações | Efeito |
| --- | --- | --- | --- |
| `overcore-contract-inspector-v1` | inspeção de contratos | `filesystem.read` | nenhum |
| `overcore-file-effect-harness-v1` | substituição controlada de arquivo | `filesystem.read`, `filesystem.modify` | journaled |
| `overcore-postgres-table-probe-v1` | sonda temporária PostgreSQL | `database.schema.read`, `database.schema.modify` | journaled |

O inspetor é `hybrid`: pode usar a verificação determinística ou o Claude Agent SDK dentro da mesma fronteira autorizada. Isso não torna Claude obrigatório.

## O que isto não é

Não é um Registry distribuído, não instala plugins, não seleciona modelo e não cria agentes ou skills. O catálogo nasce no processo, é imutável e só declara os adaptadores realmente entregues ao Worker na inicialização.

Quando for a hora de introduzir agentes e skills, eles precisarão declarar uma capacidade compatível com este contrato; não receberão execução apenas por nome ou por texto de prompt.
