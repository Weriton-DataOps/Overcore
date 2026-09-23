# ADR-019 — Avaliação reproduzível da Discovery assistida

- Data: 2026-09-23
- Estado: correções implementadas; resultados da rodada abaixo.

## O que esta etapa faz e por quê

Confere se o Preflight encontra escolhas importantes **antes da execução** sem transformar um
pedido já claro em um questionário. A avaliação usa o mesmo TaskPreflight, validação de contratos,
BaselineDiscovery, AdaptiveDiscovery e ClaudeDiscoveryAdvisor da aplicação. Apenas a persistência
é em memória: ela não admite tarefas, chama o Omni ou modifica projetos.

Os oito casos são sintéticos e representativos. As chamadas ao Claude são reais, via OAuth.
Não são oito tarefas de desenvolvimento executadas, nem uma prova de qualidade em uso prolongado.

## O que foi corrigido

1. O modo `advisor` agora inclui pedidos `light`. Antes, `Melhore o relatório` era considerado
   pronto sem consulta semântica, porque tinha poucos campos. `light/standard/deep` continuam
   descritores estruturais, não certificados de clareza.
2. Decisões já levantadas pelo baseline acompanham o pedido. O assessor acrescenta lacunas
   diferentes; duplicatas textuais são consolidadas. Perguntas diferentes do mesmo tópico não são
   descartadas por uma deduplicação ampla demais.
3. Escolhas de revisões anteriores chegam com pergunta, opção e consequência, depois da validação
   dos fingerprints pelo Preflight. O relatório completo não vai ao modelo. Uma confirmação genérica
   não substitui informação material ausente: a revisão precisa registrar o conteúdo da decisão.
4. O prompt distingue decisão do proprietário de informação que o executor pode inspecionar e de
   detalhe reversível de implementação. Zero perguntas é uma resposta válida.
5. A avaliação verifica chamada real concluída e tentativa de ferramenta. Fallback do baseline,
   erro de login ou JSON inválido não contam como sucesso da avaliação assistida.

Autoridade continua no Omni. O assessor não ganha ferramentas, aprovação de efeitos ou execução.

## Como reproduzir

Na raiz do novo Overcore:

```powershell
npm.cmd run eval:discovery -- --dry-run
npm.cmd run eval:discovery -- --live
# Ou apenas um caso:
npm.cmd run eval:discovery -- --live short-ambiguous
```

- `--dry-run`: valida os contratos sem modelo.
- `--live`: consome o login Claude; não faz parte de `npm test`.
- Uma chamada, um turno e até 60 segundos por caso. Limite por chamada de USD 0,35 segundo a
  estimativa do SDK; a rodada para após atingir USD 2,50 acumulados. A chamada em andamento pode
  ultrapassar o limite acumulado. Isso é um controle de consumo, não uma cobrança adicional comprovada.
- Modelo: o padrão do login, com o identificador efetivamente recebido registrado no relatório.
- Sessões da avaliação não são persistidas no histórico do Claude.
- Relatórios ficam em `.overcore-runtime/evaluations/discovery/`, ignorados pelo Git; contêm perguntas,
  tópicos, falhas, tempo, modelo, uso e fingerprint do draft, sem credenciais ou ID de sessão.

O modo global continua `baseline` por padrão. `OVERCORE_DISCOVERY_MODE=advisor` habilita a leitura
assistida para novas revisões. Reenvio da mesma revisão continua retornando seu relatório imutável:
atualizar o código não reavalia silenciosamente um relatório antigo.

## Método e limites

As expectativas foram escritas independentemente das respostas do modelo: quantidade aceitável de
perguntas e grupos de tópicos obrigatórios. A revisão humana/técnica das perguntas complementa esses
checks. Acertar a quantidade ou o rótulo sozinho não prova entendimento.

A primeira execução também revelou defeitos nos casos: referências chamadas apenas `primary` e
`secondary` não identificavam os alvos, e "campos obrigatórios" não delimitava aninhamento. Algumas
perguntas do modelo eram justificadas. A suíte foi corrigida para nomear os recursos e fechar esse
escopo; seus resultados anteriores não são uma comparação A/B equivalente com a suíte revisada.

Permanecem para uso acompanhado: variação entre execuções, latência no fluxo completo, qualidade das
respostas após várias revisões, ambiguidade não representada na amostra e comparação de modelos.
Nenhum agente especializado, skill ou Registry foi introduzido nesta etapa.

## Resultados

### Rodada final — suíte 3

Relatório local: `.overcore-runtime/evaluations/discovery/live-1790183817849.json`.
Conclusão em `2026-09-23T17:16:57.849Z`. Modelo retornado pelo SDK: `claude-opus-5[1m]`;
SDK `0.3.224`, OAuth, um turno por caso. Não é uma escolha definitiva de modelo.

| Caso | Perguntas | Verificação mecânica | Revisão da resposta |
| --- | ---: | --- | --- |
| Inspeção com escopo completo | 0 | passou | Não pediu informações extras |
| Substituição literal determinada | 0 | passou | Não reabriu escopo |
| "Melhore o relatório" | 2 | passou | Perguntou objetivo/público e limite da alteração |
| Dois ambientes, um alvo | 1 | passou | Pediu escolha entre homologação e produção |
| Renomeação de campo de API | 2 | passou | Compatibilidade pertinente; pergunta adicional sobre documento de apoio é ruído residual |
| Sistema grande sem recorte | 2 | passou | Pediu primeira entrega e demonstração; não perguntou mais se a pasta estava vazia |
| Instrução indevida em texto citado | 0 | passou | Não transformou o trecho citado em ordem ou pergunta |
| Critério de aceite ausente | 1 | passou | Manteve somente a pergunta do baseline, sem duplicá-la |

- **8/8** nos checks mecânicos; **7/8** sem pergunta extra na revisão qualitativa desta amostra.
  O caso de compatibilidade ainda mostra que `filesystem.modify` em uma referência pode induzir
  uma pergunta de escopo desnecessária. Mantido como observação de qualidade, não como sucesso perfeito.
- Nenhuma tentativa de ferramenta detectada; nenhuma chamada caiu no fallback.
- Latência por Preflight: 6,36–17,56 segundos; média 10,20 segundos. Isso mede esta rodada local,
  não um SLA ou o tempo da futura integração completa com Omni.
- Estimativa SDK da rodada final: USD 0,375537. Somando as três rodadas: USD 1,2505195,
  em 22 chamadas concluídas. Esses valores não demonstram cobrança adicional à assinatura.
- A rodada intermediária passou em contagem/tópico, mas a revisão encontrou uma pergunta sobre
  conteúdo existente na pasta. Ela virou critério negativo na suíte e motivou a última correção.
- Build limpa: removidos somente `dist` e `.test-dist` gerados, depois `npm.cmd run verify`:
  TypeScript, **90/90 testes locais** e build passaram.
- Revisão respondida foi exercitada por teste local do Preflight com fingerprints reais e runtime
  simulado. Ainda não houve conversa multirrevisão ao vivo com o Omni nesta etapa.
- Nenhum commit, push, alteração de configuração global ou migration nesta rodada.

Próxima validação de integração: modo assistido no serviço local recebendo um pedido do Omni,
devolvendo decisões juntas e consumindo a revisão respondida sem reiniciar a tarefa. Deve preservar
o vínculo de autoridade e o relatório anterior imutável.
