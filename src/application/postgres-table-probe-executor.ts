import type { JsonObject } from '../domain/types.js'
import type { PostgresTableProbeExecutor } from '../ports/task-store.js'
import { PostgresTableProbeHarness } from './postgres-table-probe-harness.js'
import type { ExecutionControl } from '../ports/execution-control.js'

export class HarnessPostgresTableProbeExecutor implements PostgresTableProbeExecutor {
  constructor(private readonly harness: PostgresTableProbeHarness) {}
  reconcileCancellation(input: { taskId: string; effectKey: string; targetUri: string; tableName: string }) {
    return this.harness.reconcileCancellation(input)
  }
  async execute(input: Parameters<PostgresTableProbeExecutor['execute']>[0], control?: ExecutionControl): Promise<JsonObject> {
    return await this.harness.apply(input, control) as unknown as JsonObject
  }
}
