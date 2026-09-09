# Harness de efeitos v1 — o cinto de segurança das escritas

## O que ele faz

O Harness é a única porta pela qual uma ferramenta poderá alterar um recurso. Ele não escolhe o que
fazer e não substitui o agente. Sua função é tornar a execução recuperável e verificável.

Uma analogia útil: o agente é quem dirige; o Omni entrega o crachá; o Harness é a catraca com câmera e
livro de ocorrências. A catraca não decide o destino, mas impede que uma passagem seja contada duas
vezes ou aconteça sem registro.

## Por que cada peça existe

| Peça | O que faz | Por que precisamos dela |
| --- | --- | --- |
| `effectKey` | Dá nome estável à mesma intenção de escrita. | Restart e retry reconhecem que não é uma nova mudança. |
| Fingerprint da intenção | Liga a chave ao destino e ao conteúdo esperado. | Impede reaproveitar a chave para esconder outra alteração. |
| Checkpoint | Preserva os bytes anteriores fora do Git. | Dá base comprovada para recuperação ou compensação. |
| Journal PostgreSQL | Guarda estado, hashes, revisões e contagem de aplicações. | O processo pode morrer sem perder a verdade operacional. |
| CAS | Aceita a transição somente na revisão lida. | Duas instâncias não assumem simultaneamente o mesmo efeito. |
| Guardião de autoridade | Reconfirma o crachá imediatamente antes da escrita. | Uma autorização revogada ou vencida não continua por inércia. |
| Escrita atômica | Grava e sincroniza um temporário antes de substituir o alvo. | Reduz o risco de arquivo parcialmente escrito. |
| Readback | Relê e calcula o hash final. | “O comando terminou” não é prova de que o efeito correto ocorreu. |
| Reconciliação | Compara o arquivo atual com os hashes anterior e final. | Decide com evidência se deve confirmar, repetir ou preservar divergência. |

## Estados do journal

```text
reserved
   |
   v
applying ------ queda antes da escrita ------> arquivo = antes
   |                                                |
   |                                          not-applied
   |                                                |
   |                                          reautoriza e tenta
   |
   +---------- queda depois da escrita ------> arquivo = depois
                                                    |
                                               confirmed

qualquer estado + arquivo com terceiro hash ------> unknown
```

- `reserved`: checkpoint existe e a intenção tem identidade, mas nada foi escrito;
- `applying`: uma instância ganhou o CAS e começou a tentativa física;
- `confirmed`: o readback corresponde ao hash desejado;
- `not-applied`: a recuperação provou que o arquivo ainda é o original;
- `unknown`: o arquivo não é nem o original nem o resultado contratado;
- `rolled-back`: reservado para uma compensação explicitamente executada.

## O que já funciona

O `FileEffectHarness` altera um arquivo descartável real e produz:

- registro completo do journal;
- referência e hash do checkpoint;
- evidência da revalidação de autoridade;
- evidência de readback;
- projeção de `effects`, `evidence`, `artifacts` e `checkpointArtifactRef` pronta para compor um
  `TaskResult`.

## O que ainda não está ligado

```text
Task Manager/outbox ---- X ----> FileEffectHarness
Omni real              ---- X ----> EffectAuthorityGuard
Task State/TaskResult   <--- projeção pronta, integração pendente
```

Portanto, o Harness existe e foi provado, mas nenhuma tarefa normal do runtime ganhou poder de escrita
ainda. A próxima etapa fecha exatamente essas três conexões para uma única operação controlada.
