# Vetores de teste dos contratos

Esta pasta contém provas declarativas e independentes de linguagem. Ela não escolhe framework nem
runtime.

`preflight-domain-mutations.json` parte do exemplo `task-readiness-ready.json`, aplica uma mutação por
caso usando operações JSON Patch (RFC 6902) e declara o código de domínio que deve rejeitar o
documento. Cada mutação continua estruturalmente válida sempre que o erro pertence ao validador de
domínio.

O futuro validador oficial precisa executar estes vetores, além dos arquivos de `casos-invalidos/`.
Adicionar uma invariante de domínio exige acrescentar pelo menos um caso que demonstre sua rejeição.

`authorization-domain-mutations.json` ataca o pedido, a decisão e o registro de enforcement. Ele
comprova que o Overcore não consegue ampliar o teto, omitir ações, reutilizar a decisão de r1 em r2,
aceitar audiência divergente, ignorar expiração ou marcar um plano negado como ativável.

As invariantes do estado persistente ficam separadas em
[`../../internos/testes/task-state-domain-mutations.json`](../../internos/testes/task-state-domain-mutations.json),
porque o `Task State` não é um contrato público.
