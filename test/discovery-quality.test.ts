import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { ContractValidator } from '../src/contracts/validator.js'
import { discoveryQualityCases, qualityDraft, scoreQuestions } from '../integration/discovery-quality-cases.js'

test('casos de qualidade são contratos válidos, sem depender de login ou rede', async () => {
  const validator: ContractValidator = await ContractValidator.create(process.cwd())
  assert.equal(new Set(discoveryQualityCases.map((item) => item.id)).size, discoveryQualityCases.length)
  for (const item of discoveryQualityCases) {
    validator.taskDraft(qualityDraft(item, '2026-09-23T12:00:00Z'))
    assert.ok(item.maximum <= 3)
    assert.ok(item.minimum <= item.maximum)
  }
})

test('avaliação detecta perguntas ausentes, ruído e assunto errado sem julgar sua própria resposta', () => {
  const complete = discoveryQualityCases.find((item) => item.id === 'complete-inspection')!
  const ambiguous = discoveryQualityCases.find((item) => item.id === 'ambiguous-target')!
  assert.deepEqual(scoreQuestions(complete, []), [])
  assert.ok(scoreQuestions(complete, [{ topic: 'scope' }]).length > 0)
  assert.ok(scoreQuestions(ambiguous, []).length > 0)
  assert.ok(scoreQuestions(ambiguous, [{ topic: 'output' }]).length > 0)
  assert.deepEqual(scoreQuestions(ambiguous, [{ topic: 'target' }]), [])
  const large = discoveryQualityCases.find((item) => item.id === 'large-request')!
  const unnecessary = [{ topic: 'scope', question: 'A pasta está vazia ou tem base existente?' }]
  assert.ok(scoreQuestions(large, unnecessary).length > 0)
})

test('avaliação exige escolha inequívoca do modo antes de consumir login', () => {
  for (const args of [[], ['--dry-run', '--live'], ['--live', '--unknown']]) {
    const result = spawnSync(process.execPath, [join(process.cwd(), '.test-dist/integration/discovery-quality.js'), ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Informe exatamente um modo/)
  }
})
