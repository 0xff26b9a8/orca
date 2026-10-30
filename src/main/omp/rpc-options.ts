import { z } from 'zod'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { PiRpcRequester } from '../pi/rpc-options'

const stateSchema = z.object({
  model: z
    .object({
      provider: z.string(),
      id: z.string(),
      api: z.string().optional(),
      identity: z.object({ class: z.string() }).optional(),
      serviceTiers: z.array(z.string()).optional()
    })
    .nullish(),
  fastModeEnabled: z.boolean().optional(),
  fastModeActive: z.boolean().optional()
})

// OMP model-controls.setFastMode accepts priority only for its native service-tier families.
function supportsFastMode(model: NonNullable<z.infer<typeof stateSchema>['model']>): boolean {
  const openaiApi = ['openai-completions', 'openai-responses', 'openai-codex-responses'].includes(
    model.api ?? ''
  )
  const openai =
    ['openai', 'openai-codex'].includes(model.provider) ||
    (!['fireworks', 'github-copilot'].includes(model.provider) &&
      openaiApi &&
      model.identity?.class === 'openai')
  if (openai) {
    return (
      model.api !== 'openai-codex-responses' ||
      !model.serviceTiers?.length ||
      model.serviceTiers.includes('priority')
    )
  }
  return (
    model.api === 'anthropic-messages' ||
    ['google', 'google-vertex'].includes(model.provider) ||
    (model.provider === 'openrouter' &&
      ['openai', 'anthropic', 'gemini'].includes(model.identity?.class ?? ''))
  )
}

export async function readOmpFastOptions(
  rpc: PiRpcRequester,
  options: AgentSessionOptionsResult
): Promise<AgentSessionOptionsResult> {
  const state = stateSchema.parse(await rpc.request('get_state'))
  if (!state.model || state.fastModeEnabled === undefined || state.fastModeActive === undefined) {
    return options
  }
  const supported = supportsFastMode(state.model)
  const id = `${state.model.provider}/${state.model.id}`
  return {
    ...options,
    fastModeSupport: { supported, ...(!supported ? { reason: 'model-not-supported' } : {}) },
    models: options.models.map((model) => ({
      ...model,
      ...(model.id === id ? { supportsFastMode: supported } : {})
    })),
    current: {
      ...options.current,
      fastMode: state.fastModeEnabled,
      fastModeState: state.fastModeActive ? 'on' : 'off',
      confirmed: [...(options.current.confirmed ?? []), 'fastMode']
    }
  }
}
