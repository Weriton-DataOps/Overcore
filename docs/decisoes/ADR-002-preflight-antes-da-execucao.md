# ADR-002 — Preflight antes da execução

- Estado: aceito
- Data: 2026-08-30

## Contexto

Uma tarefa pode parecer clara no comando inicial e revelar durante a execução decisões previsíveis que
não foram mapeadas. Resolver cada uma no meio do trabalho aumenta interrupções, retrabalho e perda de
continuidade.

## Decisão

1. O comando inicial forma um `TaskDraft`, não um `TaskRequest` executável.
2. O Task Manager executa Preflight com autoridade somente de descoberta.
3. Decisões reversíveis dentro do escopo podem ser tomadas automaticamente com rollback registrado.
4. Decisões materiais são agrupadas em um único `TaskReadinessReport` com recomendação e consequências.
5. O cliente, inicialmente o Omni, conduz a conversa e devolve uma nova revisão do draft.
6. O `TaskRequest v1` só é emitido no estado `ready` e fica imutável durante a execução.
7. Condições realmente imprevisíveis ainda podem produzir `TaskResult blocked` posteriormente.
8. Draft, relatório e request são ligados por revisão e fingerprints JCS; respostas identificam o
   relatório que apresentou a decisão.
9. O request preparado pode restringir contexto, autoridade e orçamento, mas nunca ampliá-los.
10. O orçamento de execução tem fonte explícita e permanece separado do orçamento do Preflight.
11. A identidade idempotente da futura execução nasce no draft e não pode ser regenerada pelo
    Preflight.
12. Campos materiais do request possuem derivação estruturada para draft, resposta, decisão automática
    ou evidência.
13. O Preflight pode solicitar compreensão adicional por uma porta neutra de Discovery, com
    profundidade proporcional ao pedido; o futuro Agente de Discovery implementará essa capacidade
    sem executar a tarefa nem substituir checks determinísticos.
14. Drafts e relatórios são persistidos em revisões append-only; o cliente envia somente o draft e o
    Overcore recupera internamente o relatório anterior, conforme a ADR-009.

## Consequências

- o Task Manager possui uma fase explícita de admissão;
- perguntas previsíveis chegam juntas antes do trabalho material;
- o OverCore não assume o papel conversacional do Omni;
- o Preflight não recebe autorização para executar a tarefa;
- fingerprint e revisão impedem misturar respostas de drafts diferentes;
- a admissão precisa executar validações de domínio entre documentos, porque JSON Schema isolado não
  compara subconjuntos de autoridade nem recalcula hashes.
- reinício de processo ou troca de sessão não apaga decisões e respostas já registradas.
