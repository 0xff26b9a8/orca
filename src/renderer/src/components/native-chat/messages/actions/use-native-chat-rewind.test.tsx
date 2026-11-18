// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, message: vi.fn() } }))

import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { encodeOmpRewindTarget } from '../../../../../../shared/omp-rewind-target'
import { useNativeChatRewind } from './use-native-chat-rewind'

import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../drafts/native-chat-draft-views'

type Input = Parameters<typeof useNativeChatRewind>[0]

afterEach(cleanup)
beforeEach(() => {
  toastError.mockReset()
  writeNativeChatDraftCache('pane', '')
})
const done = { kind: 'done' as const, value: { itemId: 'user', epoch: 'new' } }
const item = (
  itemId: string,
  sequence: number,
  role: 'user' | 'assistant' = 'user'
): AgentJournalRenderItem => ({
  itemId,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [{ type: 'text', text: `text of ${itemId}` }] }
})
function input(): Input & { send: ReturnType<typeof vi.fn> } {
  return {
    sessionId: 'session',
    capturePresentation: () => () => true,
    composerScopeKey: 'pane',
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'old',
      fence: 1,
      status: 'ready' as const,
      cursor: { epoch: 'old', sequence: 12 },
      items: [item('user', 10), item('reply', 11, 'assistant'), item('later', 12)]
    },
    support: { supported: true as const },
    blocked: false,
    send: vi.fn().mockResolvedValue(done)
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function render(props: Input) {
  return renderHook((value: Input) => useNativeChatRewind(value), { initialProps: props })
}

describe('structured chat rewind', () => {
  it('offers an accepted OMP prompt once its native turn target is recorded', async () => {
    const props = input()
    const userId = agentJournalSubmissionKey('omp-prompt')
    const user = item(userId, 10)
    const turn = {
      ...item('omp-turn', 11),
      body: {
        kind: 'turn',
        turnId: 'omp-turn',
        state: 'completed',
        outcome: 'success',
        userItemId: userId,
        startedAt: 100,
        completedAt: 200
      }
    } satisfies AgentJournalRenderItem
    props.state.items = [user, turn]
    props.state.submissions = [
      {
        clientMessageId: 'omp-prompt',
        fence: 1,
        payloadFingerprint: 'omp-prompt',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 100,
        resolvedAt: 200
      }
    ]
    const view = render(props)
    expect([...(view.result.current.surface?.eligibleItemIds ?? [])]).toEqual([])
    view.rerender({
      ...props,
      state: {
        ...props.state,
        items: [
          user,
          {
            ...turn,
            body: {
              ...turn.body,
              providerTurnId: encodeOmpRewindTarget({
                sessionFile: '/sessions/omp.jsonl',
                timestamp: 100
              })
            }
          }
        ]
      }
    })
    expect([...(view.result.current.surface?.eligibleItemIds ?? [])]).toEqual(['orca:omp-prompt'])
    await act(() => view.result.current.request(userId, async () => true))
    expect(readNativeChatDraftCache('pane')).toBe('text of orca:omp-prompt')
  })

  it('awaits the suffix sequence in the same epoch before unblocking', async () => {
    const props = input()
    props.send.mockResolvedValue({
      kind: 'done',
      value: { itemId: 'user', epoch: 'old', sequence: 15 }
    })
    const view = render(props)
    await act(() => view.result.current.request('user', vi.fn().mockResolvedValue(true)))
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
    view.rerender({ ...props, state: { ...props.state, cursor: { epoch: 'old', sequence: 15 } } })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it('blocks only while the confirmed request is in flight', async () => {
    const props = input(),
      response = deferred<typeof done>()
    props.send.mockReturnValue(response.promise)
    const view = render(props)
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.request('user', async () => true)
    })
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
    await act(async () => {
      view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      response.resolve(done)
      await request
    })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it("holds only its own chat's sends when the view moves to another chat mid-rewind", async () => {
    const props = input(),
      response = deferred<typeof done>()
    props.send.mockReturnValue(response.promise)
    const view = render(props)
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.request('user', async () => true)
    })
    view.rerender({ ...props, sessionId: 'other' })
    expect(view.result.current.disabledReason).toBeNull()
    expect(view.result.current.admitsSend()).toBe(true)
    view.rerender(props)
    expect(view.result.current.admitsSend()).toBe(false)
    await act(async () => {
      view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      response.resolve(done)
      await request
    })
  })
})
