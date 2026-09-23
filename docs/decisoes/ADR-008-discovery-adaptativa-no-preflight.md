# ADR-008 — Discovery adaptativa no Preflight

- Estado: implementada em modo assessor opcional; avaliação inicial registrada na ADR-019
- Data: 2026-08-31

## Contexto

Entender uma solicitação não tem profundidade fixa. Um ajuste pequeno pode esconder uma decisão de
compatibilidade; um sistema grande pode exigir leitura de arquitetura, superfícies, dependências,
restrições e critérios antes que a execução seja preparada. O Preflight não deve presumir que pedidos
curtos são simples nem transformar toda solicitação em uma investigação pesada.

## Decisão

1. O Preflight continua responsável por conduzir a preparação e produzir o `TaskReadinessReport`.
2. Ele terá uma porta neutra de Discovery para solicitar compreensão adicional quando a natureza do
   pedido exigir.
3. O **Assessor de Discovery** é uma implementação especializada opcional: recebe o `TaskDraft` serializado e o resumo das decisões validadas/pendentes, e devolve no máximo três perguntas materiais adicionais.
4. A profundidade será adaptativa: pode ir de uma inspeção breve para um pequeno ajuste até uma
   descoberta ampla para a construção de um sistema.
5. Discovery procura intenção, alvo, contexto, dependências, restrições, critérios, decisões
   previsíveis, riscos e evidências que sustentem o relatório.
6. Seu resultado é estruturado e rastreável; não é uma conversa solta nem uma decisão final baseada
   apenas em texto do modelo.
7. Discovery não executa a tarefa, não altera artefatos, não amplia autoridade e não responde pelo
   usuário em decisões materiais.
8. O Omni continua conduzindo a conversa com o usuário e apresenta em um único pacote as decisões que
   realmente precisarem de resposta.
9. Checks determinísticos permanecem obrigatórios. O Agente de Discovery os complementa; não os
   substitui.
10. O assessor usa Claude Agent SDK com login OAuth somente quando `OVERCORE_DISCOVERY_MODE=advisor`; o padrão é `baseline`, sem chamada de modelo. Ele não recebe ferramentas nem acesso a recursos do projeto.
11. A avaliação inicial de qualidade está na ADR-019. Escolha definitiva de modelo e eventual especialização em agente permanecem decisões futuras.
12. No modo assistido, pedidos `light` também recebem leitura semântica. Contar campos não prova clareza. As perguntas locais existentes são enviadas ao assessor para evitar repetição; duplicatas textuais são consolidadas, mas perguntas diferentes do mesmo tópico permanecem.

## Fluxo previsto

```text
TaskDraft
   |
   v
Preflight
   |
   +--> checks determinísticos
   |
   `--> Discovery Port
           |
           +--> inspeção leve
           `--> futuro Agente de Discovery, quando necessário
                         |
                         v
                evidências estruturadas
                         |
                         v
TaskReadinessReport
   +--> ready
   +--> decisions-required, agrupadas
   `--> not-feasible, com causa comprovada
```

## Consequências

- o próximo Preflight executável não pode acoplar compreensão a um modelo ou agente específico;
- a porta permite o assessor sem acoplar a segurança ou a conclusão do Preflight a uma resposta do modelo;
- pedidos pequenos e grandes usam o mesmo contrato, mas não precisam pagar o mesmo custo de análise;
- a execução começa apenas depois que a compreensão necessária e as decisões previsíveis estiverem
  suficientemente resolvidas.
