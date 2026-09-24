# Consulta de evidências integradas

GET autenticado `/v1/validation-evidence` consulta somente os recibos locais de
`.overcore-runtime/evaluations/omni-flow`. Não admite tarefa, não chama SDK e não executa fila.

A leitura é limitada a 40 arquivos recentes de até 1 MiB e retorna até três recibos válidos.
Recibos exigem sucesso, limpeza concluída, relatório com SHA-256 íntegro e quatro critérios
aprovados, incluindo evidência de ausência de mutação. Arquivos inválidos são ignorados.
Diretórios redirecionados e links simbólicos não são usados. A resposta exclui texto de relatório,
prompts, caminhos e credenciais; expõe IDs, hashes, data e alcance da validação.

`local-integration-receipt` é proveniência de arquivo local, não assinatura criptográfica.
`currentRuntimeValidated:false` e `behavioralValidation:false` são obrigatórios: um teste
anterior não prova o runtime atual nem substitui observação humana. Histórico desconhecido
ou endpoint antigo não significa que nenhum teste foi feito.

O Omni consulta isso antes de propor repetição paga e deve explicar a lacuna concreta.
Testes desta correção: suíte de 106 casos aprovada e consulta real pelo cliente Omni,
sem repetir teste pago. O relatório e os recibos locais não entram no repositório público.
