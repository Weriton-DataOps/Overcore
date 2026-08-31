# ADR-001 — OverCore independente e invocado por contrato

- Estado: aceito
- Data: 2026-08-29

## Contexto

Omni, OverCore e Oracle são iniciativas diferentes. Misturá-las num mesmo runtime ou repositório
criaria dependência circular e impediria que cada uma evoluísse segundo sua responsabilidade.

## Decisão

1. O OverCore nasce em pasta e repositório próprios.
2. Recebe tarefas por um contrato público e neutro.
3. O primeiro cliente previsto é o Omni, mas o núcleo não depende dele.
4. O Task Manager pertence ao OverCore e administra a vida da tarefa; não interpreta conversa aberta.
5. Resultado volta diretamente ao cliente.
6. Oracle é integração futura, opcional e assíncrona.
7. Memória pessoal e personalidade não entram no OverCore.
8. O primeiro marco será uma fatia vertical pequena, não a implementação antecipada da arquitetura-alvo.
9. Agentes, skills, modelos, ferramentas, capabilities e procedures serão definidos e aprovados em
   etapas próprias antes de qualquer implementação.

## Consequências

- contratos podem ser testados antes de escolher tecnologia;
- o Omni poderá delegar sem compartilhar sua implementação interna;
- o OverCore poderá aceitar outros clientes;
- Oracle poderá observar sem governar a execução;
- novos componentes só serão extraídos quando o runtime provar a necessidade.
