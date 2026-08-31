# ADR-004 — Omni decide autoridade; Overcore faz enforcement

- Estado: aceito
- Data: 2026-08-30

## Contexto

O `TaskRequest` já declara recursos e operações, mas o `Execution Plan` nasce depois e contém a lista
exata do que será executado. Se o próprio Overcore interpretasse o teto como aprovação automática do
plano, ele seria simultaneamente solicitante, decisor e executor de sua própria autoridade.

O usuário administra permissões por meio do Omni. Esse crachá inclui contexto e decisões que pertencem
ao agente pessoal e não devem ser copiados para o ambiente de desenvolvimento.

## Decisão

1. O crachá pessoal e duradouro permanece privado no Omni.
2. Depois de criar uma revisão do plano, o Overcore emite `AuthorizationRequest v1` para a porta
   `Authority Provider`.
3. Na implantação inicial, o Omni ocupa essa porta e devolve `AuthorizationDecision v1`.
4. A decisão é um crachá derivado, mínimo, temporário e vinculado ao fingerprint exato do plano.
5. O Overcore valida, persiste e aplica a decisão; nunca concede autoridade a si próprio.
6. Qualquer ação negada impede a ativação do plano inteiro.
7. Nova revisão do plano exige nova decisão, ainda que possa ser avaliada automaticamente pelo Omni.
8. Antes de efeito `journaled`, o Overcore verifica revogação; falha de verificação impede o dispatch.
9. A integração ocorre por contrato público. O núcleo do Overcore não importa código, memória ou
   contratos privados do Omni.
10. A ativação grava o vínculo do enforcement dentro do plano ativo e no histórico, na mesma revisão
    atômica que leva a tarefa a `ready`.
11. `start-attempt`, `dispatch-action` e `apply-effect` recarregam o enforcement por identidade e
    fingerprint; declaração solta no estado não concede execução.
12. Expiração bloqueia trabalho novo. Revogação é conferida imediatamente antes de efeito journaled;
    reconciliação e cancelamento continuam permitidos para estabilizar trabalho já em voo.

## Consequências

- o usuário mantém um único centro de autoridade pessoal: o Omni;
- o Overcore permanece independente e pode testar enforcement sem implementar o Omni;
- aprovação é auditável e não depende do histórico da conversa;
- plano alterado não herda autorização antiga por acidente;
- indisponibilidade na verificação de revogação bloqueia efeitos externos, em vez de assumir permissão;
- transporte, assinatura e armazenamento poderão ser escolhidos depois sem mudar a responsabilidade.
- o Scope/Policy interno é um ponto de **enforcement**, não um segundo decisor concorrendo com o Omni.
