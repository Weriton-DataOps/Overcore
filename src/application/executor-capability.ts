import type { OutboxMessage } from '../domain/types.js'

export type ExecutionKind = OutboxMessage['kind']

export interface ExecutorCapability {
  executorId: string
  executionKinds: ExecutionKind[]
  operations: string[]
  effectModes: Array<'none' | 'journaled'>
  runtime: 'deterministic' | 'agent-sdk' | 'harness' | 'hybrid'
}

const REQUIRED: Record<ExecutionKind, { operation: string; effectMode: 'none' | 'journaled' }> = {
  'execute-inspection': { operation: 'filesystem.read', effectMode: 'none' },
  'execute-file-replacement': { operation: 'filesystem.modify', effectMode: 'journaled' },
  'execute-postgres-table-probe': { operation: 'database.schema.modify', effectMode: 'journaled' }
}

export class ExecutorCapabilityUnavailableError extends Error {
  constructor(readonly executionKind: ExecutionKind) {
    super(`Nenhum executor declarado cobre ${executionKind}. A tarefa não será despachada por suposição.`)
    this.name = 'ExecutorCapabilityUnavailableError'
  }
}

/**
 * Catálogo local e imutável para o processo atual. Ele não descobre agentes,
 * não instala skills e não é um Registry distribuído: apenas declara o que o
 * Worker realmente recebeu na inicialização.
 */
export class ExecutorCapabilityCatalog {
  constructor(private readonly capabilities: ExecutorCapability[]) {
    const ids = new Set<string>()
    for (const capability of capabilities) {
      if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(capability.executorId) || ids.has(capability.executorId)) {
        throw new Error('Catálogo de executores possui identidade ausente ou duplicada.')
      }
      ids.add(capability.executorId)
    }
  }

  select(executionKind: ExecutionKind): ExecutorCapability {
    const required = REQUIRED[executionKind]
    const selected = this.capabilities.find((capability) =>
      capability.executionKinds.includes(executionKind) &&
      capability.operations.includes(required.operation) &&
      capability.effectModes.includes(required.effectMode)
    )
    if (!selected) throw new ExecutorCapabilityUnavailableError(executionKind)
    return structuredClone(selected)
  }

  list(): ExecutorCapability[] {
    return this.capabilities.map((capability) => structuredClone(capability))
  }
}

export function localExecutorCapabilities(input: {
  hasFileReplacement: boolean
  hasPostgresTableProbe: boolean
}): ExecutorCapability[] {
  return [
    {
      executorId: 'overcore-contract-inspector-v1',
      executionKinds: ['execute-inspection'],
      operations: ['filesystem.read', 'runtime.assemble-report'],
      effectModes: ['none'],
      runtime: 'hybrid'
    },
    ...(input.hasFileReplacement ? [{
      executorId: 'overcore-file-effect-harness-v1',
      executionKinds: ['execute-file-replacement'] as ExecutionKind[],
      operations: ['filesystem.read', 'filesystem.modify'],
      effectModes: ['none', 'journaled'] as Array<'none' | 'journaled'>,
      runtime: 'harness' as const
    }] : []),
    ...(input.hasPostgresTableProbe ? [{
      executorId: 'overcore-postgres-table-probe-v1',
      executionKinds: ['execute-postgres-table-probe'] as ExecutionKind[],
      operations: ['database.schema.read', 'database.schema.modify'],
      effectModes: ['none', 'journaled'] as Array<'none' | 'journaled'>,
      runtime: 'harness' as const
    }] : [])
  ]
}
