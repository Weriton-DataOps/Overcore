import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorCapabilityCatalog,
  ExecutorCapabilityUnavailableError,
  localExecutorCapabilities
} from '../src/application/executor-capability.js'

test('catálogo local seleciona apenas executor que declarou operação e efeito necessários', () => {
  const catalog = new ExecutorCapabilityCatalog(localExecutorCapabilities({
    hasFileReplacement: true,
    hasPostgresTableProbe: true
  }))
  assert.equal(catalog.select('execute-inspection').executorId, 'overcore-contract-inspector-v1')
  assert.equal(catalog.select('execute-file-replacement').executorId, 'overcore-file-effect-harness-v1')
  assert.equal(catalog.select('execute-postgres-table-probe').executorId, 'overcore-postgres-table-probe-v1')
})

test('catálogo recusa dispatch quando a capacidade não foi entregue ao Worker', () => {
  const catalog = new ExecutorCapabilityCatalog(localExecutorCapabilities({
    hasFileReplacement: false,
    hasPostgresTableProbe: false
  }))
  assert.throws(
    () => catalog.select('execute-file-replacement'),
    (error: unknown) => error instanceof ExecutorCapabilityUnavailableError && error.executionKind === 'execute-file-replacement'
  )
})
