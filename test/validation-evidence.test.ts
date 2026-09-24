import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readValidationEvidence } from '../src/infrastructure/runtime/validation-evidence.js'

test('historical validation exposes hashes and scope, rejects damaged and failed receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'overcore-receipts-'))
  try {
    assert.equal((await readValidationEvidence(root)).status, 'unavailable')
    const dir = join(root, '.overcore-runtime', 'evaluations', 'omni-flow')
    await mkdir(dir, { recursive: true })
    const content = 'PRIVATE REPORT CONTENT'
    const receipt = { success: true, cleanupComplete: true, evidence: {
      taskId: 'task-12345678', flowId: 'flow-12345678', statuses: ['running', 'succeeded'], reportCase: true,
      report: { content, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` },
      execution: { finishedAt: '2026-09-24T17:25:37.495Z' },
      criteria: ['inventory', 'map', 'inconsistencies', 'no-mutation'].map(id => ({ criterionId: `criterion-${id}`, status: 'passed',
        evidenceRefs: [id === 'no-mutation' ? 'evidence-no-mutation-abcd' : 'evidence-criterion-review-abcd'] }))
    } }
    await writeFile(join(dir, 'flow-100.json'), JSON.stringify(receipt))
    await writeFile(join(dir, 'flow-101.json'), JSON.stringify({ ...receipt, success: false }))
    await writeFile(join(dir, 'flow-102.json'), JSON.stringify(receipt).replace(content, 'tampered'))
    await writeFile(join(dir, 'flow-103.json'), '{')
    await writeFile(join(dir, 'flow-104.json'), 'x'.repeat(1_048_577))
    const result = await readValidationEvidence(root)
    assert.equal(result.evidence.length, 1)
    assert.equal(result.evidence[0]?.taskId, 'task-12345678')
    assert.equal(result.evidence[0]?.currentRuntimeValidated, false)
    assert.equal(result.evidence[0]?.behavioralValidation, false)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|REPORT CONTENT|tampered/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
