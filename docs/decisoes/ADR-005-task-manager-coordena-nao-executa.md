# ADR-005 — Task Manager coordena; portas especializadas executam

- Estado: aceito
- Data: 2026-08-30

## Contexto

O Overcore precisa administrar tarefas retomáveis, mas o Task Manager pode facilmente virar um objeto
onipotente que conversa, planeja, autoriza, executa, avalia e guarda estado próprio. Esse desenho
duplicaria o Omni, o Task State e o futuro Harness.

## Decisão

1. O Task Manager recebe `TaskDraft` estruturado; não recebe conversa aberta.
2. Ele conduz Preflight, admissão, planejamento, autorização, ativação, tentativa, dispatch,
   verificação, recovery, cancelamento e emissão por meio de portas explícitas.
3. O `Task State` é a única fonte de verdade do ciclo operacional; não existe status paralelo do
   Manager.
4. Draft, relatório, request, plano, decisão e enforcement são documentos versionados e imutáveis
   ligados ao estado por identidade e fingerprint.
5. O Planner propõe a estratégia; o Omni decide autoridade; o Dispatcher/Harness executa; o Verifier
   avalia. O Task Manager escolhe somente a próxima operação admissível.
6. No primeiro corte, essas responsabilidades podem viver num único processo, sem se tornarem serviços.
7. A coordenação é sequencial; Graph Engine, routing e paralelismo geral ficam para necessidade futura
   comprovada.
8. Incerteza, cancelamento e expiração são resolvidos antes de qualquer trabalho novo.
9. Linguagem, armazenamento, transporte e primeira tarefa real serão decididos antes do código
   executável.

## Consequências

- o Overcore não vira outro Omni;
- restart pode retomar pelo estado persistido, não pelo histórico do modelo;
- autorização e execução não se misturam;
- o primeiro runtime pode ser pequeno sem apagar as fronteiras futuras;
- agentes, skills e ferramentas não precisam ser escolhidos para fechar a coordenação;
- cada nova porta só vira componente separado quando estado ou comportamento próprio justificar.
