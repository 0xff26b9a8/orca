import { expect, it } from 'vitest'
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
