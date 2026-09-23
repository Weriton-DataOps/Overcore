import type { JsonObject } from '../domain/types.js'
import type { FileReplacementExecutor } from '../ports/task-store.js'
import { FileEffectHarness } from './file-effect-harness.js'
import type { ExecutionControl } from '../ports/execution-control.js'

/** Adaptador estreito: o Worker entrega uma intenção congelada ao Harness. */
export class HarnessFileReplacementExecutor implements FileReplacementExecutor {
  constructor(private readonly harness: FileEffectHarness) {}

  reconcileCancellation(input: { taskId: string; effectKey: string; targetUri: string }) {
    return this.harness.reconcileCancellation(input)
  }

  async execute(input: Parameters<FileReplacementExecutor['execute']>[0], control?: ExecutionControl): Promise<JsonObject> {
    return await this.harness.apply({
      taskId: input.taskId,
      effectKey: input.effectKey,
      resourceRef: input.resourceRef,
      targetUri: input.targetUri,
      desiredContent: input.desiredContent,
      expectedBeforeDigest: input.expectedBeforeDigest,
      authorization: {
        enforcementId: input.authorization.enforcementId,
        expiresAt: input.authorization.expiresAt,
        operations: input.authorization.operations,
        requiredControls: input.authorization.requiredControls,
        authorizationRequest: input.authorization.authorizationRequest,
        actionId: input.actionId
      }
    }, control) as unknown as JsonObject
  }
}
