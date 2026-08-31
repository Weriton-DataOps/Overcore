# Casos inválidos dos contratos v1

Estes arquivos são JSON válidos, mas devem ser rejeitados pelo contrato:

Casos do Preflight:

- `task-draft-descoberta-mutante.json`: tenta classificar `filesystem.modify` como operação de leitura;
- `task-draft-resposta-cruzada.json`: tenta aplicar uma resposta emitida para outro draft;
- `task-readiness-pronto-sem-request.json`: declara prontidão sem produzir um `TaskRequest`;
- `task-readiness-checks-incompletos.json`: omite seis dos sete checks obrigatórios;
- `task-readiness-recomendacao-inexistente.json`: recomenda uma opção que não está na lista apresentada.

Casos do `TaskRequest v1`:

- `task-request-sem-criterio.json`: não define como comprovar conclusão;
- `task-request-autoridade-coringa.json`: tenta conceder uma operação `*`, que não possui semântica
  verificável.

Casos do `TaskResult v1`:

- `task-result-sucesso-com-criterio-falho.json`: declara sucesso apesar de um critério falho;
- `task-result-bloqueado-sem-entrada.json`: declara bloqueio sem dizer o que precisa ser resolvido;
- `task-result-evidencia-inexistente.json`: passa no JSON Schema, mas falha no vínculo de domínio por
  apontar para uma evidência ausente.

Esses fixtures cobrem rejeições estruturais e de domínio. A prova complementar também muta o exemplo
`ready` para demonstrar rejeição de troca de cliente, nova referência, ampliação de autoridade,
remoção de barreira, orçamento excedido e proveniência divergente. Sua presença não escolhe linguagem
nem framework do futuro runtime.

Estados persistentes inválidos ficam em [`../../internos/casos-invalidos/`](../../internos/casos-invalidos/),
fora da superfície pública.
