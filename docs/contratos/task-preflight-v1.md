# Preflight do Task Manager — v1

## 1. O que é

Preflight é a preparação anterior à execução. Ele recebe um `TaskDraft v1`, inspeciona somente o que
foi autorizado para descoberta e produz um `TaskReadinessReport v1`.

Não é um planejador completo, não executa a tarefa e não conversa diretamente com o usuário.

Contratos formais: [`TaskDraft v1`](../../contratos/task-draft.schema.json) e
[`TaskReadinessReport v1`](../../contratos/task-readiness-report.schema.json). A cadeia completa está
exemplificada em [`contratos/exemplos`](../../contratos/exemplos/).

## 2. Por que existe

Comandos reais frequentemente chegam sem alvo exato, critérios, autoridade, compatibilidade ou
decisões de desenho. Se essas lacunas aparecem apenas durante a execução, o trabalho para várias vezes,
perde contexto e pode precisar ser refeito.

O Preflight antecipa tudo que pode ser descoberto com uma inspeção curta. Decisões materiais voltam em
um único pacote; decisões seguras e reversíveis podem ser tomadas automaticamente e ficam registradas.

O objetivo é reduzir interrupções previsíveis, não prometer que nenhum evento inesperado acontecerá.

### Discovery adaptativa

O Preflight não presume que o tamanho da frase corresponde ao tamanho do trabalho. Dependendo do
pedido, ele pode solicitar compreensão adicional por uma porta neutra de Discovery: desde uma
inspeção breve para um pequeno ajuste até uma descoberta ampla para um sistema inteiro.

O assessor de Discovery é uma implementação opcional dessa porta. Ele recebe o `TaskDraft`
serializado e o resumo das decisões já validadas ou pendentes. Pode produzir perguntas estruturadas
adicionais para os checks e para as decisões agrupadas; não
executa a tarefa, não amplia autoridade e não substitui as validações determinísticas. O modo padrão
continua sem modelo; o modo `advisor` é habilitado explicitamente, conforme a
[`ADR-008`](../decisoes/ADR-008-discovery-adaptativa-no-preflight.md).

## 3. Onde entra

```text
comando parcial
      |
      v
cliente organiza a intenção
      |
      v
TaskDraft v1
      |
      v
TASK MANAGER / PREFLIGHT
  - inspeção controlada
  - checks de prontidão
  - decisões automáticas reversíveis
  - decisões materiais agrupadas
      |
      +--> decisions-required -> cliente resolve -> nova revisão do TaskDraft
      |
      +--> not-feasible ------> cliente recebe causa comprovada
      |
      `--> ready -------------> TaskRequest v1 congelado
                                      |
                                      v
                                  execução
```

## 4. O que recebe e devolve

### TaskDraft v1

Pode estar incompleto, mas precisa conter:

- objetivo conhecido até o momento;
- chaves idempotentes separadas para preparar e executar a intenção;
- referências disponíveis e suposições explícitas;
- constraints e critérios já conhecidos, mesmo que as listas estejam vazias;
- autoridade separada para descoberta e para futura execução;
- orçamento de execução com limites e fonte explícita;
- respostas de decisões anteriores com proveniência do relatório, em uma nova revisão;
- orçamento próprio e limitado do Preflight.

`discoveryAuthority` tem modo `inspect-only`. Cada operação declara `effect: read`; o futuro catálogo de
operações precisa confirmar essa classificação. Declarar uma operação mutável como leitura não a torna
segura.

`availableExecutionAuthority` não é usada para executar durante o Preflight. Ela serve apenas para
comparar o trabalho provável com a autoridade já disponível e detectar expansão antes da execução.
Ela pode expirar; o pedido preparado não pode prolongar essa validade.

`executionBudget` é diferente de `preflightBudget`. O primeiro limita a execução futura e declara se
veio do cliente, de uma política versionada ou de uma resposta. O segundo limita somente a inspeção
preparatória. Ausência de limite de tokens ou custo significa que aquela métrica não se aplica à
tarefa; nunca significa uso ilimitado.

### TaskReadinessReport v1

Retorna um destes estados:

| Estado | Significado |
| --- | --- |
| `ready` | Todos os checks passaram e o relatório contém um `TaskRequest v1` completo. |
| `decisions-required` | Existem decisões materiais, reunidas em `requiredDecisions`. |
| `not-feasible` | A inspeção encontrou uma impossibilidade comprovada com o contexto e autoridade atuais. |

Um relatório `ready` também registra o fingerprint do `preparedRequest` e quais respostas de decisão
foram realmente aplicadas. `requestDerivations` aponta a origem dos campos materiais do request:
draft, resposta, decisão automática ou evidência. Assim, admissão não depende de confiar em texto
livre.

## 5. Checks de prontidão

O relatório avalia sete dimensões:

1. `objective-clear`: o estado final desejado está claro;
2. `context-resolvable`: referências necessárias podem ser resolvidas;
3. `authority-sufficient`: a autoridade provável cobre os efeitos necessários;
4. `criteria-testable`: existe uma forma observável de comprovar sucesso;
5. `budget-feasible`: o pedido cabe no orçamento proposto;
6. `output-defined`: a forma da entrega está definida;
7. `rollback-ready`: efeitos materiais possuem recuperação ou consequência conhecida.

Os sete checks aparecem exatamente uma vez. Cada check fica como `passed`, `failed` ou
`needs-decision` e aponta para pelo menos uma evidência ou decisão.

- `ready`: todos os sete estão `passed`;
- `decisions-required`: não há falha, mas ao menos um está `needs-decision`;
- `not-feasible`: ao menos um está `failed` e não há decisão pendente disfarçada de impossibilidade.

## 6. Como as decisões são tratadas

### Decisão automática

Só pode ocorrer quando a escolha é reversível, permanece dentro da autoridade e possui rollback
descrito. O relatório registra decisão, razão e evidências.

### Decisão requerida

Toda decisão requerida contém:

```text
decisão
├── pergunta
├── por que é necessária
├── opções
├── consequência de cada opção
├── recomendação do OverCore
├── impacto de não responder
└── evidências
```

O cliente apresenta o pacote completo. Cada resposta recebe `answerId` e registra `reportId`, revisão e
fingerprints de origem. As respostas entram em `TaskDraft.decisionAnswers`, incrementam `revision` e
provocam novo Preflight. A revisão anterior não é alterada. Uma resposta de outro draft, de uma revisão
obsoleta ou de uma opção inexistente é rejeitada.

## 7. Invariantes de derivação

O JSON Schema verifica a forma de cada documento. O validador de domínio fecha as relações entre eles:

1. `hashJCS(TaskDraft)` coincide com `TaskReadinessReport.draftFingerprint`;
2. o `TaskRequest.preflight` coincide com draft, revisão, fingerprint e relatório `ready`;
3. `hashJCS(preparedRequest)` coincide com `preparedRequestFingerprint`;
4. cliente e correlação são preservados;
5. contexto e suposições não ganham entradas silenciosas;
6. recursos e operações do request são subconjuntos da autoridade disponível no draft;
7. barreiras não são removidas e a expiração não é prolongada;
8. o orçamento do request não cria métricas nem supera os limites com fonte;
9. toda resposta do draft aparece exatamente uma vez em `appliedDecisionAnswers`;
10. a chave idempotente do request é a `executionIdempotencyKey` já fixada no draft;
11. objetivo, constraints, critérios, prioridade, prazo e saída possuem derivação resolvível;
12. toda decisão automática presente num relatório `ready` aparece em pelo menos uma derivação;
13. IDs de checks, decisões, opções, respostas, evidências e referências são únicos no seu escopo.

Na v1, `sha256-jcs-v1` significa: aplicar o JSON Canonicalization Scheme da RFC 8785, codificar o
resultado em UTF-8, calcular SHA-256 e representar como `sha256:` seguido de 64 caracteres
hexadecimais minúsculos.

## 8. Como será testado

- draft válido com listas ainda vazias;
- autoridade de descoberta estritamente classificada como leitura;
- relatório `decisions-required` com todas as opções e recomendação válida;
- relatório `ready` sem decisão pendente e com `TaskRequest v1` válido;
- rejeição de relatório pronto que ainda possua decisão pendente;
- rejeição de referência de decisão ou evidência inexistente;
- fingerprint ligando relatório à revisão exata do draft e ao request preparado;
- rejeição de troca de cliente, nova referência, nova operação ou remoção de barreira;
- rejeição de orçamento ampliado ou sem fonte;
- rejeição de resposta cruzada entre drafts;
- rejeição de relatório com menos ou mais que os sete checks;
- execução dos vetores declarativos em
  [`contratos/testes`](../../contratos/testes/preflight-domain-mutations.json).

Esses testes agora fazem parte da suíte TypeScript oficial. O endpoint local `POST /v1/preflight`
também comprova que um relatório `decisions-required` não cria tarefa, plano, tentativa nem mensagem
de execução.

## 9. Implementação atual

```text
TaskDraft
   |
   v
validação JSON Schema
   |
   v
TaskPreflight
   |
   +--> DiscoveryPort
   |      +--> BaselineDiscovery: determinística e somente leitura
   |      `--> ClaudeDiscoveryAdvisor: opcional, sem ferramentas
   |
   +--> sete checks + decisões agrupadas + evidências
   |
   +--> validação de domínio e fingerprints
   |
   +--> PreflightStore
   |      +--> corrente: última revisão por chave idempotente
   |      `--> revisões: drafts e relatórios append-only
   |
   `--> TaskReadinessReport
          +--> decisions-required: não executa
          +--> not-feasible: não executa
          `--> ready: contém TaskRequest; admissão explícita recebe somente reportId
```

`BaselineDiscovery` existe para provar o encadeamento e cobrir constatações determinísticas: prazo,
referências locais, autoridade declarada, critérios, orçamento, saída e recuperação. Ela não finge
compreensão semântica profunda e não substitui o Agente de Discovery reservado na ADR-008.

O cliente envia somente o draft. O Store recupera os relatórios citados, devolve o mesmo resultado
quando recebe novamente uma revisão idêntica e usa CAS para impedir que duas sessões gravem conteúdos
diferentes na mesma posição. A decisão está registrada na
[`ADR-009`](../decisoes/ADR-009-preflight-persistente-append-only.md).
O handoff busca novamente o documento persistido, recusa revisão ultrapassada antes da primeira
admissão e converge repetições para a mesma tarefa, conforme a
[`ADR-010`](../decisoes/ADR-010-handoff-ready-por-report-id.md).

## 10. O que fica para depois

- ampliar a avaliação inicial de qualidade e escolher o modelo definitivo do assessor de Discovery (ver ADR-019);
- catálogo confiável de operações e seus efeitos;
- interface do Omni para apresentar o pacote;
- retomada automática de Task States interrompidos depois da admissão.

Essas etapas serão discutidas separadamente antes da implementação.
