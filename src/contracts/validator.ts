import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRequire } from 'node:module'

import type { ErrorObject, ValidateFunction, Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'

import type { JsonObject, TaskDraft, TaskReadinessReport, TaskRequest, TaskState } from '../domain/types.js'
import { assertPreflightDomain } from './preflight-domain-validator.js'

export type ContractName =
  | 'task-draft'
  | 'task-readiness-report'
  | 'task-request'
  | 'task-result'
  | 'authorization-request'
  | 'authorization-decision'
  | 'authorization-enforcement'
  | 'execution-plan'
  | 'task-state'

const paths: Record<ContractName, string[]> = {
  'task-draft': ['contratos', 'task-draft.schema.json'],
  'task-readiness-report': ['contratos', 'task-readiness-report.schema.json'],
  'task-request': ['contratos', 'task-request.schema.json'],
  'task-result': ['contratos', 'task-result.schema.json'],
  'authorization-request': ['contratos', 'authorization-request.schema.json'],
  'authorization-decision': ['contratos', 'authorization-decision.schema.json'],
  'authorization-enforcement': ['internos', 'authorization-enforcement.schema.json'],
  'execution-plan': ['internos', 'execution-plan.schema.json'],
  'task-state': ['internos', 'task-state.schema.json']
}

const require = createRequire(import.meta.url)
const Ajv2020 = (require('ajv/dist/2020').default ?? require('ajv/dist/2020')) as typeof Ajv2020Type
const addFormats = (require('ajv-formats').default ?? require('ajv-formats')) as FormatsPlugin

export class ContractValidationError extends Error {
  constructor(readonly contract: ContractName, readonly details: ErrorObject[]) {
    super(`Documento inválido para ${contract}: ${formatErrors(details)}`)
    this.name = 'ContractValidationError'
  }
}

function formatErrors(errors: ErrorObject[]): string {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ')
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonObject
}

export class ContractValidator {
  private readonly validators = new Map<ContractName, ValidateFunction>()

  private constructor(private readonly projectRoot: string) {}

  static async create(projectRoot: string): Promise<ContractValidator> {
    const instance = new ContractValidator(projectRoot)
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      // Os contratos usam `required` dentro de if/then para campos definidos no objeto raiz.
      // Também refinam `items` em if/then herdando `type: array` da definição raiz.
      // Ambos são JSON Schema válidos, mas os lints strictRequired/strictTypes exigem repetição local.
      strictRequired: false,
      strictTypes: false,
      validateFormats: true
    })
    addFormats(ajv)
    const schemas = new Map<ContractName, JsonObject>()
    for (const [name, parts] of Object.entries(paths) as Array<[ContractName, string[]]>) {
      const schema = await readJson(join(projectRoot, ...parts))
      schemas.set(name, schema)
      ajv.addSchema(schema)
    }
    for (const [name, schema] of schemas) {
      const id = String(schema.$id)
      const validate = ajv.getSchema(id)
      if (!validate) throw new Error(`Schema ${id} nÃ£o foi compilado.`)
      instance.validators.set(name, validate)
    }
    return instance
  }

  assert(name: ContractName, document: unknown): void {
    const validate = this.validators.get(name)
    if (!validate) throw new Error(`Validador ${name} não foi carregado a partir de ${this.projectRoot}.`)
    if (!validate(document)) throw new ContractValidationError(name, validate.errors ?? [])
  }

  taskRequest(document: unknown): asserts document is TaskRequest {
    this.assert('task-request', document)
  }

  taskDraft(document: unknown): asserts document is TaskDraft {
    this.assert('task-draft', document)
  }

  taskReadinessReport(document: unknown): asserts document is TaskReadinessReport {
    this.assert('task-readiness-report', document)
  }

  preflightReport(draft: TaskDraft, report: unknown): asserts report is TaskReadinessReport {
    this.taskReadinessReport(report)
    if (report.preparedRequest) this.taskRequest(report.preparedRequest)
    assertPreflightDomain(draft, report)
  }

  taskState(document: unknown): asserts document is TaskState {
    this.assert('task-state', document)
  }
}
