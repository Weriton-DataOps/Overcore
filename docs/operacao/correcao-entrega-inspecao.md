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

## Complemento: prova operacional de não mutação

O teste humano `task-4c1f074eb6ad24f28faffe80` produziu o relatório, mas revelou um quarto
critério ausente no ensaio anterior: ausência de mutação. Ele permanece historicamente
`failed`; esta correção não reescreve o resultado anterior.

Agora esse critério usa snapshots capturados pelo executor antes e depois da execução,
incluindo nomes, tipos, hashes binários e mtime/ctime das entradas diretas da pasta, mais
telemetria de início/fim e ferramentas permitidas/negadas. A comparação é determinística
e gera `evidence-no-mutation`, separada dos pareceres textuais. Criar/remover/renomear arquivo,
mudar conteúdo/metadados ou faltar telemetria reprova. Links e capturas instáveis não são
considerados prova completa. O relatório produzido continua disponível em caso de reprovação.

Limite explícito: a prova é não recursiva e mostra equivalência dos estados observados com
execução restrita a leitura. Não é auditoria contínua do sistema de arquivos nem comprova
ausência de uma escrita transitória externa seguida de restauração entre as duas capturas.
Entradas de subpastas são identificadas, mas seus conteúdos não são lidos recursivamente.

Validação: 105 testes locais (incluindo sete cenários de não mutação), 2 testes PostgreSQL
e ensaio real `flow-1790270737666.json`, aprovado em 137 segundos, com os quatro critérios
de inventário, mapa, inconsistências e não mutação. Uma execução, nenhum retrabalho; custo
estimado de inspeção + avaliação USD 1,1412465 dentro do teto autorizado USD 1,50.
No ensaio, a não mutação aponta `evidence-no-mutation`; os três critérios analíticos apontam
`evidence-criterion-review`. Não houve remoção do critério para obter aprovação.

Omni 0.24.3 acrescenta sinal `notification.ownerUpdate=silent` para consultas sem novidade,
orientação de acompanhamento por mudança e identidade do hook em cada turno. O readback
por sessão distingue a raiz executada de instalação/operador manual. A sessão aberta só
confirma a nova carga quando seu próprio hook produzir a marca; esses testes não simulam
nem fabricam a atualização da conversa do proprietário.

## Diagnóstico de runtime (Omni 0.24.4)

GET autenticado `/v1/capabilities` informa início do processo e capacidades
de inspeção registradas pela composição real do serviço. Não admite tarefa,
não aciona worker e não altera resultados. Servidores de teste com outro
executor não anunciam implicitamente as capacidades da composição de produção.
O Omni consulta esta evidência antes de repetir um diagnóstico histórico.
Endpoint antigo/ausente é estado desconhecido; capacidade anunciada não é
prova de sucesso de tarefa. O teste histórico permanece `failed`.
