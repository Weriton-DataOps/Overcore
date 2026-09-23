# ADR-016 — Catálogo local de capacidades v1

## Estado

Aceita e implementada em 2026-09-18.

## Decisão

O Worker seleciona um executor por capacidade declarada antes do dispatch. A compatibilidade mínima exige o mesmo tipo de mensagem, operação e política de efeito que a etapa necessita.

O catálogo é local, imutável e montado apenas com executores recebidos na inicialização. Ausência de capacidade é erro explícito; nunca há fallback por suposição.

## Consequência

O Overcore separa “qual trabalho foi autorizado” de “qual adaptador local consegue realizá-lo”, sem antecipar Registry, skills, agentes, plugins ou roteamento entre modelos.
