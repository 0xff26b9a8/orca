import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registration-types'
import { readPiRpcSessionOptions } from '../pi/rpc-options'
import { piRpcSessionlessEnvironment } from '../pi/rpc-launch'
import { assertStructuredAgentResolutionCurrent } from '../native-chat/structured-agent-command-resolution'
import { openOmpRpcConnection } from './rpc-connection'
import { buildOmpRpcLaunch, resolveOmpRpcInvocation } from './rpc-launch'
import { readOmpFastOptions } from './rpc-options'

export function createOmpRpcModelCatalogProbe(
  context: StructuredAgentModelCatalogContext
): AgentModelCatalogProbe {
  const probe: AgentModelCatalogProbe = async (account, options) => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const cwd = options?.workspacePath
    if (!cwd) {
      throw new Error('OMP lists models in the chat folder')
    }
    const { env, command, prefixArgs } = await resolveOmpRpcInvocation({
      accountDir: requireLegacyAgentSessionAccountHome(account).path,
      environment: () => context.environment.resolveAgentEnvironment('omp'),
      settings: context.deps.resolveAgentCommandSettings?.() ?? {},
      cwd,
      operation,
      refreshAfterMiss: context.environment.refreshAfterMissingProgram
    })
    const directory = join(context.deps.stateDirectory, 'omp-rpc')
    await mkdir(directory, { recursive: true })
    const scratch = await mkdtemp(join(directory, 'catalog-'))
    try {
      assertStructuredAgentResolutionCurrent(operation)
      return await runAgentModelCatalogSession(
        () =>
          openOmpRpcConnection(
            buildOmpRpcLaunch({
              command,
              prefixArgs,
              cwd,
              fullAccess: true,
              ...piRpcSessionlessEnvironment(env),
              extraArgs: ['--session-dir', scratch]
            }),
            {}
          ),
        async (connection) => {
          const options = await readOmpFastOptions(
            connection,
            await readPiRpcSessionOptions(connection)
          )
          const models = options.models.map((model) => ({
            ...model,
            isDefault: model.id === options.current.model,
            ...(model.id === options.current.model && options.current.effort
              ? { defaultEffort: options.current.effort }
              : {})
          }))
          assertStructuredAgentResolutionCurrent(operation)
          if (!models.length) {
            throw new Error('OMP listed no models')
          }
          return {
            models,
            origin: 'probe' as const,
            fastModeSupport: options.fastModeSupport,
            configured: options.current
          }
        },
        { label: 'OMP RPC model discovery', signal: options.signal }
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  probe.sessionless = true
  return probe
}
