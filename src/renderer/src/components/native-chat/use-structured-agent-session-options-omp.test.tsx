// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  ATTACHED,
  renderOptions,
  descriptor,
  HOST_CATALOG,
  tick
} from './use-structured-agent-session-options.test-fixture'
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

describe('OMP resting session options', () => {
  beforeEach(() => {
    mocks.sendSelection = false
    forgetStructuredSessionSelection('session-1')
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
    mocks.coherentCatalog = false
    resetHostModelCatalogSnapshotsForTests()
  })

  it('keeps a model picker before the first send when the resting options are empty', async () => {
    const catalog = Promise.withResolvers<unknown>()
    answer({
      modelCatalog: () => catalog.promise,
      options: async () => ({ models: [], current: {} })
    })
    const { result, unmount } = renderOptions(
      { ...ATTACHED, agent: 'omp' },
      mutateWith(async () => null).mutate
    )
    await tick()
    await act(async () =>
      catalog.resolve({ ...HOST_CATALOG, origin: 'probe', listingNamesConfiguredModel: false })
    )
    await waitFor(() => {
      const model = descriptor(result.current.optionSnapshot, 'model')
      expect(
        model?.kind.type === 'select' &&
          model.kind.choices.some((choice) => choice.value === 'gpt-hosted')
      ).toBe(true)
    })
    unmount()
  })
})
