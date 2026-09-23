# Fechamento da ligação Omni–Overcore

Data: 2026-09-23.

## Escopo

Consolidar o servidor independente e o cliente conversacional já construídos. Não adicionar
agentes, skills, Registry, Graph Engine ou interface ao Overcore.

## Evidências desta rodada

- Overcore: `npm.cmd run verify` aprovado novamente, 98/98 testes, typecheck e build.
- Serviço operacional local: supervisor existente preservado, `/health` respondeu HTTP 200.
- Gate real da ligação: aprovado em `flow-1790194625698.json`, conforme ADR-021. Não foi repetido
  nesta rodada; nenhuma nova chamada paga foi necessária para os ajustes de contexto e testes.
- Omni: build TypeScript recompilada após repor o pacote Windows do compilador na versão já
  fixada, sem alterar a versão declarada das dependências para isso.
- Omni: 43/43 testes focados, executados serialmente conforme a configuração do projeto:
  hook de contexto, adaptador runtime, composição TypeScript e cliente HTTP TypeScript.
- Desktop: 238/238 testes de unidade passaram durante a rodada. Ensaios Electron isolados
  de retorno, colagem, leitor Markdown e contexto privado também passaram. Não são evidência
  de que a sessão do proprietário carregou uma nova versão.

## Correções no fechamento

O protocolo Overcore deixa de ocupar o contexto de conversas sem pedido ao Overcore e sem fluxo
externo existente. Briefings executáveis de autocorreção precisam caber inteiros; índices externos
recuperáveis cedem espaço antes deles. Os testes cobrem ambas as condições.

Os ensaios de interface passaram a acompanhar a animação de rolagem e a preservação intencional
de retornos históricos ainda não lidos. O teste de sessão indisponível agora simula falha no IPC
que ele próprio substitui. Nenhuma dessas adaptações alterou o comportamento produtivo da interface.

## Release do Omni ainda não encerrada

O plugin instalado foi identificado como `omni@omni-hub` 0.23.0. A candidata local 0.24.0 ainda
não foi selada nem instalada: outra sessão alterou broker, execução de credenciais e dependências
durante a validação, além das mudanças pré-existentes de interface e aprendizado. A suíte geral
não foi declarada aprovada. O fingerprint calculado no início da rodada deixou de representar
o conjunto atual e não deve ser tratado como selo de aprovação.

Para fechar o plugin, falta coordenar um conjunto estável e o escopo de publicação com a outra
sessão, validar esse conjunto, gerar e conferir o fingerprint, publicar a release e usar o
atualizador oficial. A carga efetiva exige readback da versão/fingerprint no host; cache instalado
não comprova código carregado. Nenhuma conversa aberta foi encerrada manualmente.

A auditoria local também apontou avaliações comportamentais/personais reais ausentes e pendências
de autocorreção. Elas permanecem pendentes; não foram apagadas ou reclassificadas por estes testes
técnicos. O próximo teste de conversa humana está descrito na documentação do cliente Omni.
