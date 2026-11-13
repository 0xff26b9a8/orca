import { afterEach, expect, it, vi } from 'vitest'
import { StructuredAgentSessionOpenChildWork } from '../native-chat/agent-session-wire/observations/structured-agent-session-open-child-work'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

it.each(['attempt', 'registration'] as const)(
  'releases unfinished OMP child work on process exit through the %s callback',
  async (reporting) => {
    const h = await setupOmpRpcAdapter(reporting)
    const work = new StructuredAgentSessionOpenChildWork()
    h.childWork.mockImplementation((evidence) => work.observe('omp-test', evidence))
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'child', agent: 'task', status: 'started' }
    })
    await vi.waitFor(() => expect(work.hasOpen('omp-test')).toBe(true))
    await h.adapter.closeSession('omp-test')
    await h.adapter.drainObservedExits()
    expect(work.hasOpen('omp-test')).toBe(false)
  }
)
