# Exemplos do Execution Plan v1

- `execution-plan-change-r1.json`: alteração controlada com inspeção prévia, efeito journaled,
  verificações e entrega;
- `execution-plan-change-r2.json`: retry da mesma intenção mutável com recuperação materialmente
  diferente, `effectKey` preservada e referência exata à revisão anterior;
- `execution-plan-inspection-r1.json`: inspeção estritamente de leitura com dois critérios cobertos;
- `execution-plan-inspection-r2.json`: replanejamento imutável após falha, com estratégia materialmente
  diferente e referência exata à revisão anterior.

Os arquivos descrevem **o que precisa acontecer e como será comprovado**. Eles não escolhem agente,
skill, modelo, SDK ou comando específico de ferramenta.
