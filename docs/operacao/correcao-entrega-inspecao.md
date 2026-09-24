# Entrega verificável da inspeção Omni → Overcore

Correção da rodada de uso de 24/09/2026. O fluxo anterior executava a análise, mas devolvia
somente seu digest; critérios de mapa e inconsistências recebiam a evidência de JSON legível.

## Comportamento

- `TaskResult.report` contém `mediaType`, `content` e SHA-256 UTF-8 em `digest`. É uma extensão
  opcional do contrato v1 para manter resultados históricos legíveis. Toda nova inspeção
  concluída entrega o relatório inline; o cliente Omni valida o digest antes de apresentá-lo.
- As duas verificações determinísticas aceitam somente as afirmações suportadas de parse JSON
  e `additionalProperties=false`. Método ou ID de critério, sozinhos, nunca aprovam outra coisa.
- Critérios analíticos usam uma segunda chamada do runtime, sem ferramentas e sem histórico
  da primeira, com relatório, critérios e fontes exatas. O avaliador emite decisões por critério;
  o parser exige identidade única e citações literais existentes no relatório e nas fontes.
  Isso é avaliação assistida por modelo, não prova matemática de correção semântica.
- O avaliador consome o tempo e custo restantes da mesma tarefa. Avaliação ausente, inválida ou
  reprovada impede `succeeded`. Uma reprovação preserva o relatório e as evidências na resposta.
- Cada critério aprovado aponta sua evidência própria. O recibo durável conserva a análise e
  a avaliação, permitindo retomada sem uma nova chamada de modelo.
- Referência `workspace` aponta a pasta exata, com glob `*.schema.json` sem recursão. Referência
  `repository` aponta a raiz e usa sua subpasta `contratos`; um URI já terminado em `contratos`
  é aceito diretamente. Plano, snapshot e executor compartilham a mesma resolução.
- Decisão de premissa vincula-se a draft, ID, texto e impacto. Confirmar preserva a decisão em
  novas revisões; alterar texto ou impacto exige nova decisão. Revisões não apagam respostas.
- O cliente mostra caminho/motivo de erro de validação HTTP 400, sem repassar HTML ou credenciais.

## Verificação reproduzível

`npm run verify` executa tipagem, regressões e build. Os casos adicionais cobrem a pasta exata,
entrega com digest, falso sucesso por parse, citações inexistentes, avaliação negativa e premissas.

O ensaio `npm run test:omni-flow-live`, com `OVERCORE_FLOW_CASE=report-delivery`, usa os seis schemas
reais desta pasta através do cliente produtivo Omni, autoridade Omni real, PostgreSQL de teste e
Claude Agent SDK por login. As respostas do proprietário são roteirizadas. O ensaio verifica uma
única admissão, relatório completo retornado por HTTP, digest e evidências analíticas, sem acessar
transcript. Banco e diretório temporários do ensaio são isolados e removidos ao terminar.

Esse ensaio não certifica personalidade nem memória entre conversas. O resultado e seus IDs ficam
em `.overcore-runtime/evaluations/omni-flow/`, fora do Git.

## Resultado observado em 24/09/2026

- Overcore: `npm run verify`, 104 testes aprovados; PostgreSQL real, 2/2 aprovados.
- Omni 0.24.2: validação completa em worktree isolada, incluindo 54 testes TypeScript,
  pacote e build determinístico; 3 testes focados de entrega no Desktop também passaram.
- Ensaio real aprovado em 160 segundos: `flow-1790268707810.json`, fluxo
  `flow-db1f943869231afbae7641ad`, tarefa `task-e817686ef60aa4ba3c9d2742` no banco isolado.
  Uma confirmação de premissa, revisão 2 admitida, uma tarefa e uma execução; repetição da
  resposta preservou o ID. Ambos os critérios passaram com evidências `criterion-review`.
- Relatório Markdown: 5457 caracteres; digest
  `sha256:3b9dc771ab2447ead6259f068921f9603faea3276a0bc1a26dc049f08ad859a2`.
- Quatro chamadas autenticadas por login: duas Discovery, inspeção e avaliação independente,
  sem negações de ferramenta. O ensaio não leu transcripts para recuperar o resultado.
- O teto de execução deste ensaio foi USD 1,50. Inspeção + avaliação reportaram USD 1,057095;
  as duas Discovery reportaram USD 0,162591 separadamente. São valores estimados pelo SDK,
  não comprovação de cobrança na assinatura. O padrão do cliente continua USD 0,75;
  repetir esta análise com avaliação independente requer informar um orçamento adequado.
- Tentativas anteriores não foram apagadas: uma avaliação esgotou o orçamento restante;
  outra devolveu formato inválido. Ambas reprovaram, sem falso sucesso. Agora a instrução
  explicita os limites do formato, erros identificam o campo e uso de avaliação concluída
  é contabilizado mesmo se o parser rejeitar sua resposta. Falta de orçamento preserva
  o relatório produzido e não repete automaticamente a inspeção paga.

O gate da release do Omni não apontou bloqueadores de publicação, mas preservou pendências
anteriores: 51 achados de turno, 15 melhorias sem materialização e avaliações comportamental/
personalidade reais ausentes. Esta rodada corrige a integração; não certifica essas pendências.
