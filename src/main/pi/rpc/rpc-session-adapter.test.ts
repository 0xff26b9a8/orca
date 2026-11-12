import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  file,
  sessionId,
  setup
} from './rpc-session-adapter.test-fixture'
import { agentSessionLaunchFolderMissing } from '../../runtime/agent-session/agent-session-launch-directory'

afterEach(closePiRpcAdapterFixtures)

describe('Pi RPC session ownership and delivery', () => {
  it('keeps passive, request-scoped actual separate from future picks and raw successful controls', async () => {
    const h = await setup({}, undefined, { thinkingLevel: 'medium' })
    await vi.waitFor(() => expect(h.connection.requests).toContain('get_commands'))
    const model = { provider: 'anthropic', id: 'model-1', reasoning: true }
    let effort: string | undefined = 'minimal'
    h.connection.requestOverride = (command) => {
      if (command === 'set_thinking_level') {
        return Promise.resolve({}) // Native success has no echo.
      }
      if (command === 'get_state') {
        return Promise.resolve({
          sessionFile: file,
          model,
          thinkingLevel: effort,
          isStreaming: false,
          isCompacting: false
        })
      }
      return undefined
    }
    const pick = (key: string, value: string) =>
      h.adapter.setOption({ sessionId, fence: 7, key, value })
    const read = () => h.adapter.readOptions({ sessionId, fence: 7 })
    const saved = { model: 'anthropic/model-1', effort: 'off' }
    const settle = async () => {
      const reports = h.lifecycle.mock.calls.length
      h.connection.receive({ type: 'agent_start' })
      h.connection.receive({ type: 'agent_settled' })
      await vi.waitFor(() => expect(h.lifecycle.mock.calls.length).toBeGreaterThan(reports))
    }
    await pick('model', saved.model)
    await pick('effort', saved.effort)
    expect((await read()).projectCurrent?.(saved)).toMatchObject({ effort: 'off', confirmed: [] })
    await settle()
    const applied = await read()
    expect(applied.projectCurrent?.(saved)).toMatchObject({
      effort: 'minimal',
      confirmed: expect.arrayContaining(['effort'])
    })
    const requests = h.connection.requests.length
    await read()
    await read()
    expect(h.connection.requests).toHaveLength(requests)
    expect(applied.projectCurrent?.({ ...saved, effort: 'high' })).toMatchObject({
      effort: 'high',
      confirmed: ['model']
    })

    // An extension changes actual; equal raw input skips setters and leaves that actual intact.
    effort = 'low'
    await settle()
    const changed = await read()
    expect(changed.projectCurrent?.(saved)).toMatchObject({
      effort: 'low',
      confirmed: ['model', 'effort']
    })
    const controls = h.connection.requests.filter((command) => command.startsWith('set_'))
    expect(
      await h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId: 'equal-raw',
        executionOptions: saved,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same request' }] }
      })
    ).toMatchObject({ state: 'admitted', ranOptions: saved })
    expect(h.connection.requests.filter((command) => command.startsWith('set_'))).toEqual(controls)

    const pending = Promise.withResolvers<unknown>()
    const requested = Promise.withResolvers<void>()
    const ordinary = h.connection.requestOverride
    h.connection.requestOverride = (command) => {
      if (command === 'get_state') {
        requested.resolve()
        return pending.promise
      }
      return ordinary(command)
    }
    h.connection.receive({ type: 'agent_start' })
    h.connection.receive({ type: 'agent_settled' })
    await requested.promise
    await pick('effort', 'high')
    pending.resolve({
      sessionFile: file,
      model,
      thinkingLevel: 'minimal',
      isStreaming: false,
      isCompacting: false
    })
    await vi.waitFor(async () => expect((await read()).current.effort).toBe('high'))
    expect((await read()).projectCurrent?.({ ...saved, effort: 'high' })).toMatchObject({
      effort: 'high',
      confirmed: []
    })
    expect(applied.projectCurrent?.(saved)?.confirmed).toEqual([])

    h.connection.requestOverride = ordinary
    effort = undefined
    await settle()
    expect((await read()).projectCurrent?.({ ...saved, effort: 'high' })?.confirmed).not.toContain(
      'effort'
    )
    h.connection.requestOverride = (command) =>
      command === 'set_thinking_level'
        ? Promise.reject(new Error('native refused'))
        : ordinary(command)
    await expect(pick('effort', 'low')).rejects.toThrow('native refused')
    expect((await read()).projectCurrent?.({ ...saved, effort: 'high' })?.confirmed).not.toContain(
      'effort'
    )
    await pick('model', 'anthropic/workspace-model')
    expect(
      (await read()).projectCurrent?.({ model: 'anthropic/workspace-model', effort: 'off' })
    ).toMatchObject({ effort: 'off', confirmed: [] })
    await h.adapter.closeSession(sessionId)
    expect(changed.projectCurrent?.(saved)?.confirmed).toEqual([])
  })

  it('reports root-only close without claiming descendant proof', async () => {
    const h = await setup()
    h.connection.closeResult = { root: 'exited', tree: null }
    await expect(h.adapter.closeSession(sessionId)).rejects.toMatchObject({
      name: 'AgentSessionAcquisitionRootExitObservedError',
      deathEvidenceKind: 'exit-observed'
    })
    expect(h.connection.lastCloseResult).toEqual({ root: 'exited', tree: null })
  })

  it('refuses a floating chat whose folder is gone with the reason the person reads', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    h.resolveLaunch.mockRejectedValueOnce(agentSessionLaunchFolderMissing('/gone/floating'))
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchFolderMissing'
    })
    expect(h.connections).toHaveLength(1)
  })

  it('names a launch that could not be resolved on the host', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    h.resolveLaunch.mockRejectedValueOnce(new Error('selector_not_found'))
    await expect(h.adapter.acquire({ ...h.input, fence: 8 })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchPreparationFailed'
    })
    expect(h.connections).toHaveLength(1)
  })

  it('does not spawn a start cancelled while resolving its workspace', async () => {
    const h = await setup()
    await h.adapter.closeSession(sessionId)
    const launch = await h.resolveLaunch.mock.results[0]?.value
    const resolving = Promise.withResolvers<NonNullable<typeof launch>>()
    h.resolveLaunch.mockImplementationOnce(() => resolving.promise)
    const controller = new AbortController()
    const started = h.adapter.acquire({ ...h.input, fence: 8, signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('Pi closed while starting'))
    await expect(started).rejects.toMatchObject({
      message: 'Pi closed while starting',
      reason: undefined
    })
    expect(h.connections).toHaveLength(1)
    await expect(h.adapter.acquire({ ...h.input, fence: 9 })).resolves.toMatchObject({
      process: { pid: 4123 }
    })
    resolving.resolve(launch!)
    await Promise.resolve()
    expect(h.connections).toHaveLength(2)
  })
})
