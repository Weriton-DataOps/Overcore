# Discovery adaptativa v1

## O problema que resolve

Um pedido pode chegar curto e ainda conter decisões que mudam materialmente a execução. Descobrir isso no meio da tarefa interrompe o trabalho, desperdiça contexto e pode levar o executor a escolher algo que deveria pertencer ao proprietário.

A Discovery ocorre antes de existir `TaskRequest`. Ela prepara o pedido; não executa nem autoriza nada.

```text
TaskDraft
  -> checks determinísticos
  -> (modo advisor: light/standard/deep) assessor de Discovery
  -> decisões pendentes juntas
  -> revisão respondida do TaskDraft
  -> TaskRequest congelado
  -> Omni autoriza
  -> executor trabalha
```

## Duas camadas

| Camada | Faz | Não faz |
| --- | --- | --- |
| Baseline | Valida contexto, concessões, critérios, saída, orçamento e rollback com regras locais | Não chama modelo |
| Assessor | Lê o `TaskDraft`, escolhas já validadas e decisões locais pendentes; sugere até três perguntas materiais adicionais | Não abre arquivos, usa ferramentas, executa, aprova ou altera autoridade |

O Baseline sempre roda primeiro. Se o assessor falhar, o Preflight registra a indisponibilidade e
continua com a evidência determinística. Pode emitir `ready` quando esses checks passam; isso não
equivale a uma avaliação semântica bem-sucedida. O avaliador de qualidade detecta esse fallback como
falha, mesmo se o relatório estiver `ready`.

## Profundidade

- `light`: poucos campos no documento.
- `standard`: quantidade intermediária de referências, limites e critérios.
- `deep`: documento estruturalmente amplo.

Esses perfis não provam que o pedido está claro. Em `baseline`, todos usam somente as regras locais.
Em `advisor`, todos recebem a leitura adicional, inclusive um pedido curto e ambíguo. O assessor
recebe as perguntas locais pendentes para não repeti-las, e escolhas anteriores com seu significado.

O assessor transforma apenas uma lacuna material em pergunta rastreável. Uma pergunta muda o estado do check correspondente para `needs-decision`; ela nunca muda por conta própria o plano ou o crachá do Omni.

## Ativação

O padrão é determinístico, sem chamada de modelo:

```text
OVERCORE_DISCOVERY_MODE=baseline
```

Para habilitar o assessor via Claude Agent SDK com login OAuth:

```text
OVERCORE_DISCOVERY_MODE=advisor
```

Os testes locais usam dublês do SDK e não consomem o login. A avaliação explícita
`npm.cmd run eval:discovery -- --live` usa chamadas reais, sem ferramentas, e registra perguntas,
tempo e consumo. Método, correções e limites estão na [ADR-019](../decisoes/ADR-019-avaliacao-discovery-v1.md).

## Limite de responsabilidade

Discovery é o mapa antes da viagem. O Overcore organiza o mapa; o Omni decide se a viagem pode ocorrer; o executor só age depois que o plano e a autorização estiverem fechados.
