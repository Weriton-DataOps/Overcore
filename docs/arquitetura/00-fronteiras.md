# Fronteiras do OverCore

## Responsabilidade

O OverCore transforma uma tarefa operacional já estruturada em execução controlada e resultado
verificável. Ele pode decompor, ordenar, delegar, executar, retomar e avaliar passos dentro da
autoridade recebida.

## Relação com o Omni

O Omni entende o usuário, preserva continuidade pessoal e formula a tarefa. O OverCore não importa
código, memória ou contratos internos do Omni. A comunicação futura ocorrerá somente pelos contratos
públicos do OverCore.

O OverCore também não depende do Omni: CLI, API e automações poderão usar a mesma porta.

Antes da admissão, lacunas previsíveis voltam no `TaskReadinessReport` como `decisions-required`.
Depois que a tarefa já existe, uma condição descoberta durante o trabalho produz `TaskResult blocked`
com `inputRequired`. O OverCore não inicia uma conversa paralela com o usuário.

## Relação com o Oracle

Oracle é uma iniciativa independente e futura. Não participa do caminho crítico da tarefa e não
aprova o resultado antes de ele voltar ao cliente.

No futuro, um adaptador poderá publicar eventos sanitizados para observação assíncrona:

```text
OverCore -> TaskResult -> cliente
    |
    `------ telemetry port -> Oracle (futuro e opcional)
```

## Memória e conhecimento

O OverCore poderá manter experiência operacional sobre tarefas, projetos, executores, falhas e
procedimentos. Memória pessoal, personalidade e preferências implícitas permanecem no Omni. Uma
preferência só governa a execução quando chega explicitamente no `TaskRequest`.

## Autoridade

O Omni decide a autoridade por meio da porta pública `Authority Provider`; o Overcore nunca concede
permissão a si próprio. Depois de criar o plano, o Overcore apresenta todas as ações em lote. O Omni
avalia seu crachá privado e devolve uma decisão mínima, temporária e vinculada ao fingerprint da
revisão exata. O `Authorization Enforcement` do Overcore valida, persiste e aplica essa decisão; o
Harness futuramente executará sob esses limites.

Retry da mesma revisão pode reutilizar uma decisão ainda válida. Replanejamento recebe nova avaliação
automática do Omni. Isso não significa interromper o usuário: ele só precisa participar quando o Omni
concluir que seu crachá atual não cobre a expansão material solicitada.

Uma ação negada bloqueia a ativação do plano inteiro. O Overcore não omite a ação e não inicia uma
execução parcial escondida.

## Registros

O sistema registra estados, eventos sanitizados, referências a artefatos, decisões estruturadas e
evidências. Não registra raciocínio interno do modelo como Decision Log.
