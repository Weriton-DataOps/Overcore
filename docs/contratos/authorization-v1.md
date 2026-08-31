# Authorization v1

## O que é

`Authorization v1` define como o Overcore pede autorização para uma revisão exata do plano e como o
Omni devolve uma decisão verificável. O Omni é o **decisor de autoridade**; o Overcore é o
**fiscal e executor** dessa decisão.

O crachá pessoal e duradouro continua dentro do Omni. O Overcore recebe somente um crachá derivado,
temporário, mínimo e ligado a uma tarefa e a uma revisão do plano.

```text
usuário
  |
  | concede autoridade pessoal
  v
Omni / crachá duradouro privado
  |
  | AuthorizationDecision v1: recorte mínimo e temporário
  v
Overcore / enforcement
  |
  `-- executa apenas o plano e as ações vinculadas
```

## Por que existem dois níveis

`TaskRequest.authority` continua sendo o **teto** recebido na tarefa: recursos, operações e fronteiras
que podem ser considerados. Ele não prova que o Omni aprovou o plano que foi criado depois.

`AuthorizationDecision` é a autorização **efetiva**: ela cita o fingerprint da revisão exata do plano
e decide todas as ações desse plano. A autoridade efetiva é sempre a interseção:

```text
autoridade efetiva
  = teto do TaskRequest
  ∩ ações exatas do Execution Plan
  ∩ decisão e limites emitidos pelo Omni
```

Nenhuma das três camadas consegue ampliar as outras.

## Papéis

| Papel | Responsabilidade | Não pode fazer |
| --- | --- | --- |
| Usuário | Conceder e revogar autoridade pessoal ao Omni. | Autorizar implicitamente algo que não foi exposto. |
| Omni | Avaliar o plano usando o crachá e emitir `permit`, `permit-with-constraints` ou `deny`. | Executar o plano dentro do runtime do Overcore ou alterar o plano ao autorizá-lo. |
| Overcore | Montar o pedido, validar a decisão, persistir o enforcement e aplicar todos os limites. | Autorizar a si próprio, ampliar concessões ou ignorar expiração/revogação. |
| Authority Provider port | Fronteira neutra pela qual o Overcore consulta o decisor. Na implantação inicial aponta para o Omni. | Importar memória, código ou contratos privados do Omni. |

Assim o Overcore continua independente: o núcleo conhece o contrato `Authority Provider`, não a
implementação interna do Omni. Outros clientes futuros só poderão ocupar essa porta se implementarem a
mesma responsabilidade explícita; na construção atual, o provedor previsto é o Omni.

## Fluxo completo

```text
TaskRequest admitido
        |
        v
Execution Plan r1 criado e fingerprintado
        |
        v
AuthorizationRequest r1
        |
        v
Omni avalia o plano inteiro em lote
        |
        +--> deny ------------------------> plano não ativa
        |
        `--> permit / constraints
                    |
                    v
        AuthorizationDecision r1
                    |
                    v
        Enforcement Record persistido
                    |
                    v
              Task State ready
                    |
                    v
        check antes de cada dispatch
```

O pedido é feito em lote para evitar perguntas durante cada passo. Para um efeito `journaled`, o
Overcore também consulta o estado de revogação imediatamente antes do dispatch. Falha nessa consulta é
`fail-closed`: o efeito não começa.

## AuthorizationRequest v1

O pedido contém:

- identidade do Overcore solicitante e do provedor de autoridade;
- vínculo exato com `TaskRequest` e `Execution Plan`;
- cópia do teto de autoridade recebido no request;
- manifesto ordenado de todas as ações do plano;
- recurso, operação, classe do efeito, risco e controles pedidos por ação;
- resumo de risco;
- fingerprint do próprio pedido.

O manifesto inclui ações `runtime-internal` para o Omni enxergar o plano inteiro. Elas não recebem
`resourceRef`, não podem produzir efeito externo e continuam submetidas ao budget e aos controles
internos do Overcore.

## AuthorizationDecision v1

A decisão é o crachá temporário de execução. Ela contém:

- identidade do emissor e referência opaca à base de autoridade mantida no Omni;
- audiência exata: o ambiente Overcore que poderá usá-la;
- os mesmos vínculos de request e plano;
- uma decisão para cada ação, sem omissão;
- validade temporal e limites que só podem estreitar o request;
- controles obrigatórios;
- referência de revogação e comportamento `fail-closed`;
- referência de atestação verificável pelo adaptador de autoridade;
- fingerprint da decisão.

O Overcore não recebe conversa, preferências pessoais ou o conteúdo do crachá duradouro. Apenas
`authorityBasisRef` atravessa a fronteira como referência opaca para auditoria no Omni.

### Resultados

- `permit`: todas as ações foram liberadas sem estreitamento adicional;
- `permit-with-constraints`: todas as ações foram liberadas, mas controles ou limites adicionais são
  obrigatórios;
- `deny`: pelo menos uma ação foi negada e **o plano inteiro não ativa**.

Não existe execução silenciosamente parcial. Se uma ação for negada, o Planner poderá produzir nova
revisão sem ela; essa revisão recebe outro fingerprint e volta ao Omni.

## Replanejamento, retry e validade

Uma decisão vale somente para `planId + planRevision + planFingerprint + strategyFingerprint`.

- retry da mesma tentativa e mesma revisão pode reutilizar a decisão enquanto válida e não revogada;
- nova tentativa com a mesma revisão pode reutilizá-la, respeitando epoch, budget e validade;
- qualquer nova revisão do plano exige outro `AuthorizationRequest` e outra decisão;
- decisão expirada, revogada, destinada a outro ambiente ou com atestação inválida nunca ativa plano;
- autorização nova não reabre efeito já confirmado nem elimina as regras de idempotência.

A nova avaliação do Omni pode ser automática quando o novo plano continua dentro do crachá. Isso não
significa perguntar novamente ao usuário. O usuário só precisa participar quando o próprio Omni
concluir que sua autoridade atual é insuficiente.

## Enforcement interno

[`../../internos/authorization-enforcement.schema.json`](../../internos/authorization-enforcement.schema.json)
persiste a verificação que liga pedido, decisão e plano. Um plano só pode entrar em `ready` quando o
registro estiver `authorized`, ainda válido, destinado ao ambiente atual e com todas as ações
permitidas.

O enforcement acontece novamente antes do dispatch. Para ação `journaled`, também exige:

1. decisão não expirada;
2. revogação consultada com sucesso;
3. controles obrigatórios presentes no plano/runtime;
4. recurso e operação dentro do teto do `TaskRequest`;
5. mesmo fingerprint e revisão autorizados.

Uma decisão não é uma promessa do modelo; é estado persistente e auditável.

### Ligação com ativação e dispatch

O `Task State v1` grava a identidade do enforcement dentro de `activePlanBinding.authorizationBinding`
e na entrada correspondente de `ledger.planRefs`. Ambos precisam coincidir. `start-attempt` recarrega
o registro persistido antes de admitir uma tentativa; `dispatch-action` repete o gate para a ação
exata. `apply-effect` também passa pelo mesmo gate para não existir uma rota lateral de mutação.

O gate verifica plano, revisão, request, ambiente, decisão, fingerprints, expiração, ação e controles.
Para efeito `journaled`, a observação de revogação usa o mesmo instante confiável do dispatch. Se o
Omni estiver indisponível nessa consulta, prevalece `fail-closed`.

## Invariantes de domínio

1. `AuthorizationRequest.authorityCeiling` é cópia exata, nunca expansão, de `TaskRequest.authority`.
2. O pedido contém exatamente todas as ações do plano, na mesma ordem e com identidade material igual.
3. Toda ação `request-resource` está dentro do teto de recurso e operação.
4. `runtime-internal` não possui recurso nem efeito externo.
5. O fingerprint do pedido exclui apenas o próprio campo de fingerprint.
6. A decisão repete exatamente request, plano, provedor, solicitante/audiência e conjunto de ações.
7. `permit` e `permit-with-constraints` não contêm ação negada; `deny` contém ao menos uma.
8. Limites da decisão não excedem budget, deadline ou expiração do request.
9. Controles concedidos contêm todos os controles pedidos para aquela ação; podem apenas acrescentar.
10. O registro de enforcement é projeção exata da decisão e só marca `activationEligible=true` quando
    estiver `authorized`.
11. Decisão para r1 não autoriza r2, mesmo que o objetivo textual seja o mesmo.
12. O adaptador valida `attestationRef`; identidade declarada sem atestação não concede autoridade.
13. `activePlanBinding` e `ledger.planRefs` repetem o mesmo vínculo de enforcement e a mesma revisão de
    ativação.
14. Tentativa e dispatch recarregam o enforcement por ID + fingerprint; referência declarada sozinha
    não basta.
15. Ação não concedida, controle ausente, expiração ou revogação são rejeitados antes da ferramenta.

## O que ainda não foi escolhido

- transporte entre Overcore e Omni;
- algoritmo, chave ou cofre usado pela atestação;
- formato interno do crachá pessoal do Omni;
- linguagem, banco, fila ou SDK;
- interface pela qual o usuário concede ou revoga o crachá;
- implementação executável e transporte do Authority Provider e do enforcement.

Esses itens não impedem o contrato: qualquer escolha futura terá de preservar as invariantes acima.

## Definition of Done desta definição

1. Omni é o decisor e Overcore é o enforcement, sem ambiguidade.
2. O crachá pessoal não é copiado para o Overcore.
3. Pedido, decisão e registro interno possuem schemas versionados.
4. Toda decisão está vinculada a uma revisão e fingerprint exatos do plano.
5. Negação impede ativação integral; não há execução parcial.
6. Replanejamento exige nova decisão.
7. Expiração, audiência, controles, atestação e revogação são verificáveis.
8. Casos adversariais demonstram que o Overcore não pode se autorizar ou ampliar o crachá.
9. Task State, início de tentativa e dispatch rejeitam autorização ausente, divergente ou expirada.
10. Efeito journaled não começa sem observação atual de revogação e controles completos.
