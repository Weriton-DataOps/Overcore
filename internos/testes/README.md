# Vetores de domínio do Task State

`task-state-domain-mutations.json` aplica 139 mutações RFC 6902 a snapshots válidos e resultados ligados,
e informa se o erro
deve ser capturado pelo schema ou pelo validador de domínio.

`task-state-action-cases.json` contém 34 casos que provam a fronteira de comandos: revisão esperada, fence de execução,
corridas cancelamento × conclusão e imutabilidade terminal. Ele não escolhe transporte nem banco;
declara a decisão que qualquer implementação deve tomar atomicamente.

Os casos adicionais ligam autorização ao runtime lógico: plano sem enforcement não inicia, decisão de
r1 não serve em r2, expiração bloqueia, ação omitida não despacha, controles são obrigatórios e efeito
`journaled` exige verificação atual de revogação.

`task-manager-cycle-cases.json` contém 20 decisões de coordenação. Ele comprova que o Manager agrupa
dúvidas no Preflight, não cria tarefa inviável, não ativa antes do Omni, reconcilia incerteza antes de
novo trabalho, estabiliza cancelamento e não reabre terminal. O Task State permanece a única fonte de
verdade.

Os casos cobrem:

- troca silenciosa do request;
- saltos e reabertura de estados terminais;
- revisão obsoleta e reescrita de histórico;
- efeito confirmado apagado, chave duplicada e repetição de efeito `unknown`;
- retry com a mesma estratégia e contagem incorreta de tentativas;
- resultado ligado a revisão errada ou reemitido depois do terminal;
- cancelamento sem estado intermediário;
- tentativa de criar estado a partir de Preflight não pronto;
- falha terminal marcada incorretamente como apta a retry;
- CAS obsoleto, epoch vencido e comandos atrasados nas corridas de cancelamento.
- revisão histórica de resultado, bloqueio ou identidade de tentativa adulterada;
- consumo regressivo ou acima do orçamento;
- referência de trigger ou checkpoint inexistente;
- efeito fora da autoridade recebida;
- compensação pública reflexiva ou apontando para efeito não confirmado.
- cancelamento sem avanço do fence ou trabalho novo depois de sua linearização;
- regressão de estado de efeito e reescrita de tentativa terminal;
- checkpoint incompatível com bloco, tentativa ou fase de retomada;
- gatilho incompatível com a transição e emissão anterior à transição;
- emissão posterior a resultado terminal;
- vínculo assimétrico entre tentativa e efeito;
- tentativa ativa em `cancelling` sem o ponteiro correspondente.
- efeito apenas reservado que tenta começar após o cancelamento;
- salto de revisão ou subregistro novo marcado com revisão antiga;
- digest público de checkpoint divergente do ledger interno.
- intervalos de tentativas sobrepostos;
- retomada adiante da origem do bloqueio;
- ponteiro global ou da tentativa preso em checkpoint antigo.
- retomada que cita outro episódio de bloqueio;
- comando desconhecido ou conhecido fora do lifecycle permitido;
- cancelamento honesto com efeito `unknown`, sem falso bloqueio do validador.
- quiescência persistida antes do fechamento e rejeição de `settle-cancellation` com trabalho em voo.
- evidência pública dentro da execução e da janela do step run que realmente a produziu.
- entrega materializada ligada ao resultado e aos artefatos públicos que realmente foram emitidos.
- duração ativa recalculada a partir da linha do tempo, incluindo planejamento e excluindo bloqueio.
- uma intenção lógica reutilizada em retry sem duplicar `effectKey`, por meio de origem append-only;
- identidade, ordem, revisão, epoch, tentativa, evidência e resumo causal de cada origem de efeito.
- reserva persistida antes da aplicação, reconciliação obrigatória de chamada em voo e relógio monotônico;
- epoch estritamente crescente entre tentativas e `originId` único em todo o ledger;
- compensação única, causal, sem cadeia, com alvo imutável e projeção pública bidirecional;
- projeção histórica de efeito conforme estado e evidências existentes na revisão emitida.

O futuro validador oficial deve executar esses vetores. Nesta fase eles são uma especificação
reproduzível, sem escolher linguagem nem framework.

`execution-plan-domain-mutations.json` aplica 47 ataques ao plano: proveniência e causalidade temporal
do snapshot e da revisão-base, sequência
de fases, `deliver` único, autoridade, classificação e posição dos efeitos, cobertura de critérios,
orçamento, fingerprints, estabilidade de `effectKey` e replanejamento append-only.

`execution-plan-state-mutations.json` contém 49 ataques que provam que o plano não fica solto: ativação
por CAS, tentativa, ordem e imutabilidade dos passos, saídas reais, evidências, journal, sucesso e
checkpoint pré-mudança precisam apontar para a mesma revisão imutável. Plano só ativa depois de criado,
todo passo precisa permanecer dentro da janela temporal de sua tentativa, e todo efeito dentro do passo
que o declarou. Checkpoints também pertencem ao intervalo temporal e às revisões da tentativa. O passo
`deliver` concluído materializa a saída planejada num resultado e, quando necessário, em artefatos.
