import { afterEach, expect, it, vi } from 'vitest'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'
import { FakeConnection } from '../pi/rpc-session-adapter.test-fixture'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeLook
} from '../../shared/native-chat/native-chat-notice'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

const adapters: OmpRpcSessionAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.closeAll()
    await adapter.drainObservedExits()
    adapter.acknowledgeSessionRelease('omp-test')
  }
  await closeProviderTimelineRigs()
})

async function setup(childReporting: 'attempt' | 'registration' = 'attempt') {
  const rig = await openProviderTimelineRig({ agent: 'omp', sessionId: 'omp-test' })
  let connection: FakeConnection | undefined
  const childWork = vi.fn()
  const settled = vi.fn()
  const adapter = new OmpRpcSessionAdapter({
    resolveLaunch: async () => ({
      command: 'omp',
      cwd: '/workspace',
      fullAccess: true,
      previous: null
    }),
    readProcessStartTime: async () => 12345,
    openConnection: (_launch, handlers) => {
      connection = new FakeConnection(handlers)
      return connection
    },
    onLifecycle: vi.fn(),
    onSettled: settled,
    onChildWorkEvidence: (_sessionId, evidence) => childWork(evidence),
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  adapters.push(adapter)
  const acquired = await adapter.acquire({
    identity: {
      sessionId: 'omp-test',
      agent: 'omp',
      hostId: 'local',
      workspaceId: 'folder',
      providerHandle: null
    },
    fence: 1,
    spawnToken: 'spawn',
    events: rig.eventSink,
    ...(childReporting === 'attempt' ? { childWork } : {})
  })
  const opened = await adapter.open({
    sessionId: 'omp-test',
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  if (!connection) {
    throw new Error('No child')
  }
  return { adapter, rig, connection, opened, childWork, settled }
}

it('rejects Goal on older OMP without closing the chat or simulating a goal', async () => {
  const h = await setup()
  h.connection.requestOverride = (command) =>
    command === 'goal'
      ? Promise.reject(new JsonlRpcResponseError(command, 'Unknown command: goal'))
      : undefined
  await expect(
    h.adapter.changeThreadGoal({
      sessionId: 'omp-test',
      fence: 1,
      replacesGoal: false,
      change: { kind: 'set', objective: 'Keep native ownership' }
    })
  ).resolves.toMatchObject({
    ok: false,
    rejected: expect.stringContaining('does not expose native Goal')
  })
  expect(h.connection.closed).toBe(false)
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'status' && row.body.threadGoal)
  ).toBe(false)
})

it('opens an OMP history identity and commits grouped Ask selections through existing cards', async () => {
  const h = await setup()
  expect(h.opened.link?.handle).toMatchObject({ agent: 'omp', transport: 'jsonl-rpc' })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'ask-1',
    method: 'ask',
    questions: [
      {
        id: 'one',
        question: 'Choose two',
        multi: true,
        recommended: -1,
        options: [{ label: 'A' }, { label: 'B' }]
      },
      { id: 'two', question: 'Explain', options: [] }
    ]
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row || row.body.kind !== 'question') {
    throw new Error('Ask not rendered')
  }
  expect(row.body.questions).toMatchObject([
    { id: 'one', multiSelect: true },
    { id: 'two', freeTextQuestionId: 'two' }
  ])
  const commit = vi.fn(async () => {})
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: row.itemId,
    commit,
    response: {
      kind: 'answers',
      answers: [
        { questionId: 'one', optionIds: ['option-0', 'option-1'] },
        { questionId: 'two', optionIds: [], other: 'my answer' }
      ]
    }
  })
  expect(commit).toHaveBeenCalledOnce()
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'ask-1',
    answers: [
      { id: 'one', selectedOptions: ['A', 'B'] },
      { id: 'two', selectedOptions: [], customInput: 'my answer' }
    ]
  })
})

it('keeps an initially empty Goal silent while reporting a later Goal removal', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'omp_state',
    state: { sessionFile: h.opened.link?.handle.nativeId, goal: null }
  })
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
  h.connection.receive({
    type: 'goal_updated',
    goal: {
      id: 'goal-1',
      objective: 'Ship it',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    }
  })
  h.connection.receive({ type: 'goal_updated', goal: null })
  expect(
    (await h.rig.rows()).flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))
  ).toEqual(['Goal: Ship it (active)', 'Goal cleared'])
})

it('withdraws cancelled and expired dialogs and refuses unsupported blocking UI', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'cancelled',
    method: 'input',
    title: 'Value'
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row) {
    throw new Error('Card missing')
  }
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'cancel-notice',
    method: 'cancel',
    targetId: 'cancelled'
  })
  await expect(
    h.adapter.answerPrompt({
      sessionId: 'omp-test',
      fence: 1,
      kind: 'question',
      itemId: row.itemId,
      commit: async () => {},
      response: {
        kind: 'answers',
        answers: [{ questionId: 'cancelled', optionIds: [], other: 'late' }]
      }
    })
  ).rejects.toThrow()
  h.connection.receive({ type: 'extension_ui_request', id: 'unknown', method: 'custom' })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'unknown',
    cancelled: true
  })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'secret',
    method: 'input',
    title: 'API key',
    secret: true
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'secret',
    cancelled: true
  })
  vi.useFakeTimers()
  try {
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'timeout',
      method: 'confirm',
      title: 'Approve?',
      timeout: 10
    })
    await vi.advanceTimersByTimeAsync(11)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'timeout',
      cancelled: true,
      timedOut: true
    })
  } finally {
    vi.useRealTimers()
  }
})

it('waits for OMP settlement and preserves failed prompt outcomes', async () => {
  const h = await setup()
  await h.adapter.dispatch({
    sessionId: 'omp-test',
    fence: 1,
    clientMessageId: 'prompt',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  })
  h.connection.receive({ type: 'agent_start' })
  h.connection.receive({
    type: 'response',
    command: 'prompt',
    promptId: 'orca-prompt:prompt',
    success: true
  })
  h.connection.receive({ type: 'agent_end' })
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'turn' && row.body.state === 'completed')
  ).toBe(false)
  h.connection.receive({
    type: 'prompt_result',
    id: 'orca-prompt:prompt',
    status: 'error',
    error: { message: 'quota exhausted' },
    sessionSettled: true
  })
  await vi.waitFor(async () =>
    expect(
      (await h.rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text?.includes('quota exhausted')
      )
    ).toBe(true)
  )
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'turn' && row.body.outcome === 'failure')
  ).toBe(true)
})

it.each(['attempt', 'registration'] as const)(
  'reports native subagents through %s reporting without orchestration workers',
  async (reporting) => {
    const h = await setup(reporting)
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'started', index: 0 }
    })
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'completed', index: 0 }
    })
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'completed', index: 0 }
    })
    await h.rig.rows()
    expect(h.childWork.mock.calls.flat(2)).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        outcome: 'succeeded',
        handle: { idKind: 'task_id', id: 'native-child' }
      })
    )
    expect(h.childWork.mock.calls.flat(2).filter((item) => item.type === 'ended')).toHaveLength(1)
    expect(await h.adapter.cancelTurn({ sessionId: 'omp-test', fence: 1 })).toEqual({
      cancelled: true
    })
    expect(h.connection.requests).toContain('abort')
  }
)

it.each([
  ['info', 'notice'],
  ['warning', 'warning'],
  ['error', 'error']
] as const)('renders OMP %s notifications using existing Chat notices', async (level, tone) => {
  const h = await setup()
  const message = 'xd://: mounted mcp__orca_component_fixtures_list_fixtures'
  h.connection.receive({ type: 'notice', level, message, source: 'xdev' })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'extension-notice',
    method: 'notify',
    message: 'Extension ready',
    notifyType: level
  })
  const messages = projectStructuredItemsToNativeChat(await h.rig.rows())
  expect(messages).toHaveLength(2)
  for (const [index, text] of [message, 'Extension ready'].entries()) {
    const row = messages[index]!
    expect(row.role).toBe('system')
    const block = nativeChatNoticeBlock(row.blocks)
    expect(block?.text).toBe(text)
    expect(block && nativeChatNoticeLook(block)).toEqual({ kind: 'line', tone })
  }
})

it('shows native command results and extension failures and rejects external session changes', async () => {
  const h = await setup()
  h.connection.receive({ type: 'command_output', text: 'Current model: model-1' })
  const commandOutputs = ['MCP servers:\n  fixtures: connected', 'Tools:\n  read\n  write']
  for (const text of commandOutputs) {
    h.connection.receive({ type: 'command_output', text })
  }
  h.connection.receive({
    type: 'extension_error',
    extensionPath: '/project/check.ts',
    event: 'tool_call',
    error: 'Extension refused this tool'
  })
  const rows = await h.rig.rows()
  expect(
    rows.some((row) => row.body.kind === 'status' && row.body.text === 'Current model: model-1')
  ).toBe(true)
  const messages = projectStructuredItemsToNativeChat(rows)
  for (const text of commandOutputs) {
    const message = messages.find((row) =>
      row.blocks.some((block) => block.type === 'text' && block.text === text)
    )
    expect(message?.role).toBe('system')
    const block = message && nativeChatNoticeBlock(message.blocks)
    expect(block && nativeChatNoticeLook(block)).toEqual({ kind: 'line', tone: 'notice' })
  }
  expect(
    rows.some(
      (row) =>
        row.body.kind === 'status' &&
        row.body.tone === 'error' &&
        row.body.text?.includes('Extension refused this tool')
    )
  ).toBe(true)
  h.connection.receive({
    type: 'omp_state',
    state: { sessionFile: '/different/session.jsonl', goal: null }
  })
  await vi.waitFor(() => expect(h.connection.closed).toBe(true))
})

it('refuses timed Ask immediately because OMP owns an earlier auto-answer deadline', async () => {
  const h = await setup()
  vi.useFakeTimers()
  try {
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'expired-ask',
      method: 'ask',
      timeout: 10,
      questions: [
        {
          id: 'q',
          question: 'Approve?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          recommended: 0
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(11)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'expired-ask',
      cancelled: true
    })
  } finally {
    vi.useRealTimers()
  }
})

it('keeps an active chat when optional model discovery fails after a config change', async () => {
  const h = await setup()
  h.connection.requestOverride = (command) =>
    command === 'get_available_models'
      ? Promise.reject(new Error('Temporary catalog failure'))
      : undefined
  h.connection.receive({ type: 'config_update', thinkingLevel: 'low' })
  await vi.waitFor(async () =>
    expect(
      (await h.rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text?.includes('could not be refreshed')
      )
    ).toBe(true)
  )
  expect(h.connection.closed).toBe(false)
})

it('sets native Fast mode and reports its actual preference and effective state', async () => {
  const h = await setup()
  let enabled = false
  h.connection.requestOverride = (command) =>
    command === 'get_state'
      ? Promise.resolve({
          sessionFile: h.opened.link?.handle.nativeId,
          model: { provider: 'anthropic', id: 'model-1', api: 'anthropic-messages' },
          fastModeEnabled: enabled,
          fastModeActive: enabled
        })
      : undefined
  const request = vi.spyOn(h.connection, 'request')
  const before = await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })
  expect(before.fastModeSupport).toEqual({ supported: true })
  expect(before.current.fastMode).toBe(false)
  await h.adapter.setOption({ sessionId: 'omp-test', fence: 1, key: 'fastMode', value: 'true' })
  expect(request).toHaveBeenCalledWith('set_fast_mode', { enabled: true })
  enabled = true
  expect((await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).current).toMatchObject({
    fastMode: true,
    fastModeState: 'on'
  })
})
