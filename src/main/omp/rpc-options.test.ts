import { expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import { readOmpFastOptions } from './rpc-options'

it.each([
  [{ provider: 'relay', api: 'openai-responses', identity: { class: 'openai' } }, true],
  [{ provider: 'openai-codex', api: 'openai-codex-responses', serviceTiers: ['flex'] }, false],
  [{ provider: 'github-copilot', api: 'openai-responses', identity: { class: 'openai' } }, false]
])(
  'offers the existing Fast picker only for an OMP-supported model %j',
  async (model, supported) => {
    const id = `${model.provider}/test`
    const result = await readOmpFastOptions(
      {
        request: async () => ({
          model: { ...model, id: 'test' },
          fastModeEnabled: false,
          fastModeActive: false
        })
      },
      {
        models: [{ id, label: 'Test', isDefault: false, efforts: [] }],
        current: { model: id }
      }
    )
    expect(result.models[0]?.supportsFastMode).toBe(supported)
    expect(result.fastModeSupport?.supported).toBe(supported)
    expect(result.current).toMatchObject({
      fastMode: false,
      fastModeState: 'off',
      confirmed: ['fastMode']
    })
  }
)

it.each([
  { model: { id: 'test' } },
  { model: { provider: 'openai', id: 'test', serviceTiers: [1] } },
  { fastModeEnabled: 'true' }
])('keeps the base options when optional Fast metadata is malformed: %j', async (state) => {
  const options: AgentSessionOptionsResult = {
    models: [{ id: 'openai/test', label: 'Test', isDefault: false, efforts: [] }],
    current: { model: 'openai/test', effort: 'high' }
  }
  await expect(readOmpFastOptions({ request: async () => state }, options)).resolves.toBe(options)
})

it('still reports a failed transport while reading Fast metadata', async () => {
  const failure = new Error('RPC disconnected')
  await expect(
    readOmpFastOptions(
      {
        request: async () => {
          throw failure
        }
      },
      { models: [], current: {} }
    )
  ).rejects.toBe(failure)
})
