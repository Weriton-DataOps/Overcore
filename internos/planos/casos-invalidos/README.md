# Casos inválidos do Execution Plan v1

As violações isoladas do plano vivem como mutações reproduzíveis em
[`../../testes/execution-plan-domain-mutations.json`](../../testes/execution-plan-domain-mutations.json).

Esse formato evita copiar um plano inteiro apenas para trocar um campo e deixa explícito se a rejeição
deve ocorrer no JSON Schema ou no validador de domínio.
