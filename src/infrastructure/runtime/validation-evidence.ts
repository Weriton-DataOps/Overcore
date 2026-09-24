import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}

/** Local historical receipts, never authority to execute or proof of current code. */
export async function readValidationEvidence(projectRoot: string) {
  const directory = join(projectRoot, '.overcore-runtime', 'evaluations', 'omni-flow')
  const evidence: RecordValue[] = []
  let examined = 0
  try {
    // Do not follow a redirected evidence directory or file.
    for (const path of [join(projectRoot, '.overcore-runtime'), join(projectRoot, '.overcore-runtime', 'evaluations'), directory]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('redirected-evidence')
    }
    const files = (await readdir(directory)).filter(name => /^flow-\d+\.json$/.test(name)).sort().reverse().slice(0, 40)
    for (const name of files) {
      examined++
      try {
        const path = join(directory, name)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) continue
        const raw = await readFile(path, 'utf8')
        if (Buffer.byteLength(raw) > 1_048_576) continue
        const receipt = record(JSON.parse(raw))
        const item = record(receipt.evidence), report = record(item.report), execution = record(item.execution)
        if (receipt.success !== true || receipt.cleanupComplete !== true || item.reportCase !== true ||
          !/^task-[a-z0-9-]{8,100}$/.test(String(item.taskId)) || !/^flow-[a-z0-9-]{8,100}$/.test(String(item.flowId)) ||
          !Array.isArray(item.statuses) || item.statuses.at(-1) !== 'succeeded' ||
          typeof report.content !== 'string' || report.digest !== `sha256:${createHash('sha256').update(report.content).digest('hex')}` ||
          typeof execution.finishedAt !== 'string' || !Number.isFinite(Date.parse(execution.finishedAt)) ||
          !Array.isArray(item.criteria) || item.criteria.length !== 4) continue
        const criteria = item.criteria.map(record)
        if (new Set(criteria.map(c => c.criterionId)).size !== 4 ||
          !criteria.some(c => c.criterionId === 'criterion-no-mutation') ||
          !criteria.every(c => typeof c.criterionId === 'string' && /^criterion-[a-z0-9-]{1,100}$/.test(c.criterionId) && c.status === 'passed' &&
            Array.isArray(c.evidenceRefs) && c.evidenceRefs.some(ref => typeof ref === 'string' &&
              ref.startsWith(c.criterionId === 'criterion-no-mutation' ? 'evidence-no-mutation' : 'evidence-criterion-review')))) continue
        evidence.push({ taskId: item.taskId, flowId: item.flowId, finishedAt: execution.finishedAt,
          reportDigest: report.digest, criteria: criteria.map(c => ({ criterionId: c.criterionId, status: 'passed' })),
          receiptDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
          provenance: 'local-integration-receipt', scope: 'direct-folder-contract-inspection',
          currentRuntimeValidated: false, behavioralValidation: false })
        if (evidence.length === 3) break
      } catch { /* One malformed receipt must not hide the others. */ }
    }
    return { protocolVersion: 1, status: 'observed', scope: 'historical-integration-evidence', examined, evidence }
  } catch {
    return { protocolVersion: 1, status: 'unavailable', scope: 'historical-integration-evidence', examined, evidence: [] }
  }
}
