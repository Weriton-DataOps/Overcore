import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { fingerprint, stableId } from '../domain/fingerprint.js'
import type {
  ContextReference,
  JsonObject,
  ReadinessCheck,
  ReadinessCheckId,
  TaskDraft
} from '../domain/types.js'
import type {
  DiscoveryAssessment,
  DiscoveryPort,
  DiscoveryRequest
} from '../ports/discovery.js'

const MUTATING_OUTPUTS = new Set(['file', 'repository-change', 'artifact-set'])

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function evidence(
  draft: TaskDraft,
  checkId: ReadinessCheckId,
  kind: 'inspection' | 'schema-validation' | 'policy-check' | 'resource-check' | 'environment-check',
  capturedAt: string,
  summary: string,
  sourceRefs: string[] = []
): JsonObject {
  return {
    evidenceId: stableId(`evidence-${checkId}`, `${draft.draftId}:${draft.revision}:${summary}`),
    kind,
    capturedAt,
    summary,
    digest: fingerprint({ checkId, kind, summary, sourceRefs }).value,
    sourceRefs
  }
}

function check(
  checkId: ReadinessCheckId,
  status: ReadinessCheck['status'],
  summary: string,
  evidenceRefs: string[],
  decisionRefs: string[] = []
): ReadinessCheck {
  return { checkId, status, summary, evidenceRefs, decisionRefs }
}

function decision(
  id: string,
  topic: string,
  question: string,
  reason: string,
  options: Array<{ optionId: string; label: string; consequence: string }>,
  recommendedOptionId: string,
  impactIfUnresolved: string,
  evidenceRefs: string[]
): JsonObject {
  return {
    decisionId: id,
    topic,
    question,
    reason,
    options,
    recommendedOptionId,
    impactIfUnresolved,
    evidenceRefs
  }
}

function discoveryGrantRefs(draft: TaskDraft): Set<string> {
  return new Set(array(draft.discoveryAuthority.grants).map((grant) => String(grant.resourceRef)))
}

function executionOperations(draft: TaskDraft): string[] {
  return array(draft.availableExecutionAuthority.grants)
    .flatMap((grant) => Array.isArray(grant.operations) ? grant.operations.map(String) : [])
}

function hasMutationAuthority(draft: TaskDraft): boolean {
  return executionOperations(draft).some((operation) => /(?:^|\.)(?:create|modify|write)$/.test(operation))
}

function expired(value: unknown, at: string): boolean {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= Date.parse(at)
}

async function inaccessibleLocalReferences(
  references: ContextReference[],
  maxOperations: number
): Promise<{ unavailable: ContextReference[]; inspected: number; exhausted: boolean }> {
  const local = references.filter((reference) => reference.uri.startsWith('file:'))
  const selected = local.slice(0, maxOperations)
  const unavailable: ContextReference[] = []
  for (const reference of selected) {
    try {
      await stat(fileURLToPath(reference.uri))
    } catch {
      unavailable.push(reference)
    }
  }
  return { unavailable, inspected: selected.length, exhausted: local.length > selected.length }
}

/**
 * Descoberta inicial, determinística e somente de leitura.
 *
 * Ela prova o encadeamento do Preflight sem antecipar o futuro Agente de Discovery.
 */
export class BaselineDiscovery implements DiscoveryPort {
  async inspect(request: DiscoveryRequest): Promise<DiscoveryAssessment> {
    const { draft, generatedAt, profile } = request
    const evidenceItems: JsonObject[] = []
    const requiredDecisions: JsonObject[] = []
    const automaticDecisions: JsonObject[] = []
    const checks = new Map<ReadinessCheckId, ReadinessCheck>()

    const addEvidence = (
      checkId: ReadinessCheckId,
      kind: Parameters<typeof evidence>[2],
      summary: string,
      sourceRefs: string[] = []
    ): string => {
      const item = evidence(draft, checkId, kind, generatedAt, summary, sourceRefs)
      evidenceItems.push(item)
      return String(item.evidenceId)
    }

    const deadline = object(draft.executionHints).deadline
    if (expired(deadline, generatedAt)) {
      const evidenceRef = addEvidence(
        'budget-feasible',
        'environment-check',
        `O prazo ${String(deadline)} terminou antes do Preflight em ${generatedAt}.`
      )
      const generalRef = addEvidence(
        'objective-clear',
        'schema-validation',
        'O objetivo possui forma válida, mas a constraint temporal torna a intenção inviável.'
      )
      for (const checkId of [
        'objective-clear',
        'context-resolvable',
        'authority-sufficient',
        'criteria-testable',
        'output-defined',
        'rollback-ready'
      ] as ReadinessCheckId[]) {
        checks.set(checkId, check(
          checkId,
          'passed',
          checkId === 'objective-clear'
            ? 'O objetivo está estruturalmente definido.'
            : 'Nenhuma outra lacuna altera a impossibilidade temporal comprovada.',
          [generalRef]
        ))
      }
      checks.set('budget-feasible', check(
        'budget-feasible',
        'failed',
        'O prazo solicitado já terminou e não pode ser cumprido retroativamente.',
        [evidenceRef]
      ))
      return {
        readinessChecks: [...checks.values()],
        automaticDecisions,
        requiredDecisions,
        evidence: evidenceItems,
        failure: {
          code: 'preflight-deadline-expired',
          summary: 'A tarefa não pode cumprir um prazo já encerrado sem mudar uma constraint material.',
          evidenceRefs: [evidenceRef]
        }
      }
    }

    const assumptions = draft.context.assumptions
    const objectiveEvidence = addEvidence(
      'objective-clear',
      'schema-validation',
      assumptions.length === 0
        ? 'O objetivo não depende de suposição aberta declarada no draft.'
        : `${assumptions.length} suposição(ões) declarada(s) ainda podem alterar materialmente o objetivo.`
    )
    const assumptionDecisionIds: string[] = []
    for (const assumption of assumptions) {
      const assumptionId = String(assumption.id)
      const decisionId = stableId('decision-assumption', `${draft.draftId}:${draft.revision}:${assumptionId}`)
      const confirmId = stableId('option-confirm', decisionId)
      const reviseId = stableId('option-revise', decisionId)
      assumptionDecisionIds.push(decisionId)
      requiredDecisions.push(decision(
        decisionId,
        'scope',
        `A suposição "${String(assumption.statement)}" deve ser confirmada?`,
        String(assumption.impactIfFalse),
        [
          {
            optionId: confirmId,
            label: 'Confirmar a suposição',
            consequence: 'O Preflight poderá preparar a próxima revisão usando essa premissa.'
          },
          {
            optionId: reviseId,
            label: 'Revisar o draft',
            consequence: 'O cliente corrige objetivo, contexto ou constraints antes de nova inspeção.'
          }
        ],
        reviseId,
        'A execução não começa com uma premissa material ainda aberta.',
        [objectiveEvidence]
      ))
    }
    checks.set('objective-clear', check(
      'objective-clear',
      assumptions.length === 0 ? 'passed' : 'needs-decision',
      assumptions.length === 0
        ? 'O objetivo está suficientemente claro para a inspeção determinística atual.'
        : 'Existem suposições materiais que precisam ser resolvidas em conjunto.',
      [objectiveEvidence],
      assumptionDecisionIds
    ))

    const references = draft.context.references
    const grantedRefs = discoveryGrantRefs(draft)
    const missingGrantRefs = references.filter((reference) => !grantedRefs.has(reference.refId))
    const inspection = await inaccessibleLocalReferences(
      references.filter((reference) => grantedRefs.has(reference.refId)),
      draft.preflightBudget.maxInspectionOperations
    )
    const contextEvidence = addEvidence(
      'context-resolvable',
      'resource-check',
      `Discovery ${profile.depth}: ${inspection.inspected} referência(s) local(is) inspecionada(s); ${missingGrantRefs.length} sem concessão e ${inspection.unavailable.length} indisponível(is).`,
      references.map((reference) => reference.refId)
    )
    if (inspection.unavailable.length > 0) {
      const unavailable = inspection.unavailable.map((reference) => reference.refId).join(', ')
      checks.set('context-resolvable', check(
        'context-resolvable',
        'failed',
        `Referências locais declaradas não puderam ser resolvidas: ${unavailable}.`,
        [contextEvidence]
      ))
      for (const checkId of [
        'authority-sufficient',
        'criteria-testable',
        'budget-feasible',
        'output-defined',
        'rollback-ready'
      ] as ReadinessCheckId[]) {
        const ref = addEvidence(checkId, 'schema-validation', 'O check estrutural não remove a falha de contexto comprovada.')
        checks.set(checkId, check(checkId, 'passed', 'Nenhuma falha adicional foi comprovada antes de resolver o contexto.', [ref]))
      }
      checks.set('objective-clear', check(
        'objective-clear',
        'passed',
        'O objetivo tem forma válida; a falha comprovada está nas referências.',
        [objectiveEvidence]
      ))
      return {
        readinessChecks: [...checks.values()],
        automaticDecisions: [],
        requiredDecisions: [],
        evidence: evidenceItems,
        failure: {
          code: 'preflight-context-unavailable',
          summary: `O Preflight não encontrou ${unavailable} dentro da autoridade de descoberta atual.`,
          evidenceRefs: [contextEvidence]
        }
      }
    }

    const contextDecisionIds: string[] = []
    if (missingGrantRefs.length > 0 || inspection.exhausted || expired(draft.discoveryAuthority.expiresAt, generatedAt)) {
      const decisionId = stableId('decision-discovery-authority', `${draft.draftId}:${draft.revision}`)
      const authorizeId = stableId('option-authorize-discovery', decisionId)
      const reviseId = stableId('option-revise-context', decisionId)
      contextDecisionIds.push(decisionId)
      requiredDecisions.push(decision(
        decisionId,
        'authority',
        'Como resolver o contexto que a autoridade ou o orçamento atual de Discovery não cobre?',
        'O Preflight não pode inventar acesso nem ultrapassar seu limite de inspeção.',
        [
          {
            optionId: authorizeId,
            label: 'Ampliar Discovery no próximo draft',
            consequence: 'O cliente inclui concessões ou orçamento adicionais numa nova revisão.'
          },
          {
            optionId: reviseId,
            label: 'Reduzir o contexto',
            consequence: 'O cliente remove as referências que não são necessárias para a tarefa.'
          }
        ],
        reviseId,
        'O contexto permanece não comprovado e a tarefa não é admitida.',
        [contextEvidence]
      ))
    }
    checks.set('context-resolvable', check(
      'context-resolvable',
      contextDecisionIds.length === 0 ? 'passed' : 'needs-decision',
      contextDecisionIds.length === 0
        ? 'As referências declaradas estão cobertas pela Discovery; recursos locais foram encontrados.'
        : 'Parte do contexto exige nova concessão, novo orçamento ou redução de escopo.',
      [contextEvidence],
      contextDecisionIds
    ))

    const outputKind = object(draft.executionHints).expectedOutputKind
    const mutationNeeded = typeof outputKind === 'string' && MUTATING_OUTPUTS.has(outputKind)
    const executionExpired = expired(draft.availableExecutionAuthority.expiresAt, generatedAt)
    const mutationAuthorized = !mutationNeeded || hasMutationAuthority(draft)
    const authorityEvidence = addEvidence(
      'authority-sufficient',
      'policy-check',
      `A autoridade de execução ${mutationAuthorized ? 'cobre' : 'não cobre'} o efeito provável; validade expirada: ${executionExpired}.`
    )
    const authorityDecisionIds: string[] = []
    if (!mutationAuthorized || executionExpired) {
      const decisionId = stableId('decision-execution-authority', `${draft.draftId}:${draft.revision}`)
      const renewId = stableId('option-adjust-authority', decisionId)
      const reduceId = stableId('option-reduce-effects', decisionId)
      authorityDecisionIds.push(decisionId)
      requiredDecisions.push(decision(
        decisionId,
        'authority',
        'A próxima revisão deve ajustar a autoridade ou reduzir os efeitos da tarefa?',
        'O efeito provável não cabe integralmente na autoridade de execução disponível.',
        [
          {
            optionId: renewId,
            label: 'Ajustar a autoridade',
            consequence: 'O Omni avalia uma nova concessão no draft seguinte; nada é ampliado automaticamente.'
          },
          {
            optionId: reduceId,
            label: 'Reduzir os efeitos',
            consequence: 'O objetivo ou a saída são limitados ao que a autoridade atual permite.'
          }
        ],
        reduceId,
        'O TaskRequest não é emitido com autoridade insuficiente ou expirada.',
        [authorityEvidence]
      ))
    }
    checks.set('authority-sufficient', check(
      'authority-sufficient',
      authorityDecisionIds.length === 0 ? 'passed' : 'needs-decision',
      authorityDecisionIds.length === 0
        ? 'A autoridade disponível cobre os efeitos inferidos a partir da saída.'
        : 'A autoridade precisa ser ajustada ou o efeito precisa ser reduzido.',
      [authorityEvidence],
      authorityDecisionIds
    ))

    const criteriaEvidence = addEvidence(
      'criteria-testable',
      'schema-validation',
      `${draft.knownAcceptanceCriteria.length} critério(s) de aceitação declarado(s).`
    )
    const criteriaDecisionIds: string[] = []
    if (draft.knownAcceptanceCriteria.length === 0) {
      const decisionId = stableId('decision-acceptance-criteria', `${draft.draftId}:${draft.revision}`)
      const defineId = stableId('option-define-criteria', decisionId)
      const humanId = stableId('option-human-criteria', decisionId)
      criteriaDecisionIds.push(decisionId)
      requiredDecisions.push(decision(
        decisionId,
        'behavior',
        'Como o sucesso desta tarefa será comprovado?',
        'Sem ao menos um critério observável, conclusão vira opinião do executor.',
        [
          {
            optionId: defineId,
            label: 'Definir prova objetiva',
            consequence: 'O cliente acrescenta comando, teste, schema ou inspeção esperada.'
          },
          {
            optionId: humanId,
            label: 'Usar validação humana',
            consequence: 'A próxima revisão declara explicitamente a revisão humana como prova.'
          }
        ],
        defineId,
        'A tarefa não começa sem uma definição verificável de pronto.',
        [criteriaEvidence]
      ))
    }
    checks.set('criteria-testable', check(
      'criteria-testable',
      criteriaDecisionIds.length === 0 ? 'passed' : 'needs-decision',
      criteriaDecisionIds.length === 0
        ? 'Existe ao menos um critério que pode ser convertido em verificação executável.'
        : 'Ainda não existe critério de aceitação.',
      [criteriaEvidence],
      criteriaDecisionIds
    ))

    const budgetEvidence = addEvidence(
      'budget-feasible',
      'policy-check',
      `O envelope permite ${draft.executionBudget.limits.maxDurationMs} ms e ${draft.executionBudget.limits.maxAttempts} tentativa(s).`
    )
    checks.set('budget-feasible', check(
      'budget-feasible',
      'passed',
      'Os limites declarados são positivos e o prazo, quando presente, ainda não terminou.',
      [budgetEvidence]
    ))

    const outputEvidence = addEvidence(
      'output-defined',
      'schema-validation',
      typeof outputKind === 'string' ? `A saída foi declarada como ${outputKind}.` : 'O tipo de saída ainda não foi declarado.'
    )
    const outputDecisionIds: string[] = []
    if (typeof outputKind !== 'string') {
      const decisionId = stableId('decision-output-kind', `${draft.draftId}:${draft.revision}`)
      const artifactId = stableId('option-artifact-output', decisionId)
      const noArtifactId = stableId('option-no-artifact-output', decisionId)
      outputDecisionIds.push(decisionId)
      requiredDecisions.push(decision(
        decisionId,
        'output',
        'A tarefa deve produzir um artefato persistente ou apenas um resultado comunicado?',
        'O executor precisa saber o formato da entrega antes de montar o plano.',
        [
          {
            optionId: artifactId,
            label: 'Produzir artefato',
            consequence: 'O próximo draft informa arquivo, relatório, JSON ou mudança de repositório.'
          },
          {
            optionId: noArtifactId,
            label: 'Não produzir artefato',
            consequence: 'O próximo draft declara no-artifact como saída.'
          }
        ],
        artifactId,
        'Sem o formato da entrega, o plano pode executar a ação certa e devolver a coisa errada.',
        [outputEvidence]
      ))
    }
    checks.set('output-defined', check(
      'output-defined',
      outputDecisionIds.length === 0 ? 'passed' : 'needs-decision',
      outputDecisionIds.length === 0 ? 'O tipo de saída está definido.' : 'O formato da entrega ainda precisa ser escolhido.',
      [outputEvidence],
      outputDecisionIds
    ))

    const rollbackEvidence = addEvidence(
      'rollback-ready',
      'policy-check',
      mutationNeeded
        ? 'A saída material será preparada com checkpoint anterior à primeira alteração.'
        : 'A saída não exige efeito material e, portanto, não requer rollback.'
    )
    if (mutationNeeded) {
      automaticDecisions.push({
        decisionId: stableId('decision-checkpoint', `${draft.draftId}:${draft.revision}`),
        topic: 'risk',
        decision: 'Exigir checkpoint verificável antes da primeira alteração material.',
        reason: 'A saída prevista modifica ou cria artefatos e precisa de recuperação observável.',
        reversible: true,
        rollback: 'Descartar o checkpoint como requisito se a tarefa for revisada para somente leitura.',
        evidenceRefs: [rollbackEvidence]
      })
    }
    checks.set('rollback-ready', check(
      'rollback-ready',
      'passed',
      mutationNeeded
        ? 'O requisito de checkpoint foi registrado como decisão automática reversível.'
        : 'Não existem efeitos materiais prováveis nesta revisão.',
      [rollbackEvidence]
    ))

    return {
      readinessChecks: [...checks.values()],
      automaticDecisions,
      requiredDecisions,
      evidence: evidenceItems
    }
  }
}
