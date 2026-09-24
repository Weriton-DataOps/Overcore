import type { AcceptanceCriterion, InspectionEvidence, InspectionAssessment } from '../domain/types.js'
import { sha256 } from '../domain/fingerprint.js'
import { verifyNonMutation } from './inspection-non-mutation.js'

const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/\.$/, '')
const readable = new Set([
  'Nenhum arquivo terminado em .schema.json na pasta contratos falha no parse JSON.',
  'Todos os arquivos são JSON legível.',
  'Todos os *.schema.json de contratos são JSON legível.'
].map(normalize))
const closed = new Set([
  'Cada contrato declara additionalProperties igual a false no objeto raiz.',
  'Todos declaram additionalProperties=false na raiz.',
  'Todos os contratos declaram additionalProperties=false na raiz.'
].map(normalize))
const nonMutation = new Set([
  'Nenhum arquivo da pasta contratos foi criado, alterado ou removido durante a execução.',
  'Nenhum arquivo diretamente na pasta inspecionada foi criado, alterado ou removido durante a execução.'
].map(normalize))

// Exact assertions, never a guess based on the verification method or criterion ID.
export function deterministicCheck(criterion: AcceptanceCriterion): 'readable' | 'rootClosed' | 'nonMutation' | undefined {
  if (criterion.verification.procedureRef) return undefined
  const expected = normalize(criterion.verification.expected)
  if (['test', 'inspection'].includes(criterion.verification.method) && nonMutation.has(expected)) return 'nonMutation'
  if (criterion.verification.method === 'test' && readable.has(expected)) return 'readable'
  if (criterion.verification.method === 'schema' && closed.has(expected)) return 'rootClosed'
  return undefined
}

export function parseAssessment(output: string, criteria: AcceptanceCriterion[], report: string, sources: Record<string, string>): InspectionAssessment[] {
  const json: unknown = JSON.parse(output.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''))
  if (!Array.isArray(json) || json.length !== criteria.length) throw new Error('Avaliação sem todos os critérios solicitados.')
  const seen = new Set<string>()
  return json.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Avaliação inválida.')
    const item = row as InspectionAssessment
    if (!criteria.some(c => c.id === item.criterionId) || seen.has(item.criterionId)) throw new Error('Avaliação com ID de critério desconhecido ou duplicado.')
    if (!['passed', 'failed', 'unverified'].includes(item.status)) throw new Error('Avaliação com status inválido.')
    if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1500) throw new Error('Avaliação exige reason entre 1 e 1500 caracteres.')
    if (!Array.isArray(item.reportQuotes) || !Array.isArray(item.sourceQuotes)) throw new Error('Avaliação exige listas reportQuotes e sourceQuotes.')
    seen.add(item.criterionId)
    if (item.reportQuotes.some(q => typeof q !== 'string' || !q.trim() || !report.includes(q)) ||
        item.sourceQuotes.some(q => !q || typeof q.file !== 'string' || typeof q.quote !== 'string' || !q.quote.trim() || !sources[q.file]?.includes(q.quote))) {
      throw new Error('Avaliação citou evidência ausente do relatório ou dos arquivos.')
    }
    if (item.status === 'passed' && (!item.reportQuotes.length || !item.sourceQuotes.length)) throw new Error('Aprovação sem evidência verificável.')
    return item
  })
}

export function verifyInspectionCriteria(criteria: AcceptanceCriterion[], inspection: InspectionEvidence): Map<string, 'readable' | 'rootClosed' | 'nonMutation' | 'assessment'> {
  const verified = new Map<string, 'readable' | 'rootClosed' | 'nonMutation' | 'assessment'>()
  for (const criterion of criteria) {
    const check = deterministicCheck(criterion)
    if (check === 'nonMutation') {
      verifyNonMutation(inspection.nonMutation)
      verified.set(criterion.id, check)
    } else if (check) {
      if (!inspection.files.length || inspection.files.some(file => !file[check])) throw new Error(`Critério ${criterion.id} reprovado: ${check}.`)
      verified.set(criterion.id, check)
    } else {
      const evaluation = inspection.assessments?.find(item => item.criterionId === criterion.id)
      if (!inspection.agentRuntime || inspection.agentRuntime.outputDigest !== sha256(inspection.agentRuntime.report) ||
          !evaluation || evaluation.status !== 'passed') throw new Error(`Critério ${criterion.id} sem aprovação comprovada: ${evaluation?.reason ?? 'avaliação específica ausente'}.`)
      verified.set(criterion.id, 'assessment')
    }
  }
  return verified
}
