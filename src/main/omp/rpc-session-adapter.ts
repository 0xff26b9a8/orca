import { OmpRpcSubagents } from './rpc-subagents'
import { z } from 'zod'
import { PiRpcSessionAdapter, type PiRpcSessionAdapterDeps } from '../pi/rpc-session-adapter'
import type { PiRpcSession } from '../pi/rpc-session'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { applyPiRpcSessionOption } from '../pi/rpc-options'
import { JsonlRpcResponseError, type JsonlRpcRecord } from '../jsonl-rpc/peer'
import { createOmpRpcDialogs } from './rpc-dialogs'
import { buildOmpRpcLaunch, ompRpcProviderLink } from './rpc-launch'
import { openOmpRpcConnection } from './rpc-connection'
import { receiveOmpNotification } from './rpc-notifications'
import { OmpRpcFastOptions } from './rpc-options'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

const goalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'budget-limited', 'complete', 'dropped']),
  tokenBudget: z.number().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

const reportedGoals = new WeakMap<PiRpcSession, string>()
const subagents = new WeakMap<PiRpcSession, OmpRpcSubagents>()
const fileMentionSchema = z.looseObject({
  role: z.literal('fileMention'),
  files: z.array(z.looseObject({ path: z.string(), content: z.string() })),
  timestamp: z.number()
})

function reportGoal(session: PiRpcSession, value: unknown): void {
  const parsed = goalSchema.nullable().safeParse(value)
  if (!parsed.success) {
    return
  }
  const goal = parsed.data
  const snapshot = JSON.stringify(goal)
  const previous = reportedGoals.get(session)
  if (previous === snapshot) {
    return
  }
  reportedGoals.set(session, snapshot)
  if (previous === undefined && goal === null) {
    return
  }
  session.lane.apply([
    {
      type: 'item.close',
      item: `omp-goal:${goal?.id ?? 'cleared'}:${goal?.updatedAt ?? Date.now()}`,
      body: {
        kind: 'status',
        text: goal ? `Goal: ${goal.objective} (${goal.status})` : 'Goal cleared',
        threadGoal:
          goal && goal.status !== 'dropped'
            ? {
                state: 'set',
                goal: {
                  ...goal,
                  status: goal.status === 'budget-limited' ? 'budgetLimited' : goal.status,
                  tokenBudget: goal.tokenBudget ?? null
                }
              }
            : { state: 'cleared' }
      }
    }
  ])
}

function receiveOmpFrame(
  frame: JsonlRpcRecord,
  session: PiRpcSession,
  logger: PiRpcSessionAdapterDeps['logger']
): boolean {
  if (receiveOmpNotification(frame, session)) {
    return true
  }
  if (frame.type === 'message_start' || frame.type === 'message_end') {
    const mention = fileMentionSchema.safeParse(frame.message)
    if (mention.success) {
      session.turns.receive({ ...frame, message: { ...mention.data, content: [] } })
      return true
    }
  }
  let children = subagents.get(session)
  if (!children) {
    children = new OmpRpcSubagents((message) =>
      logger.warn(message, {
        scope: 'omp-rpc-subagents',
        sessionId: session.input.identity.sessionId
      })
    )
    subagents.set(session, children)
  }
  const evidence = children.receive(frame)
  if (evidence) {
    session.lane.childWork(evidence)
    return true
  }
  if (frame.type === 'goal_updated') {
    reportGoal(session, frame.goal)
    return true
  }
  if (frame.type === 'omp_state') {
    if (
      session.openedLink &&
      z.object({ sessionFile: z.string() }).parse(frame.state).sessionFile !== session.sessionFile
    ) {
      session.fail(
        new Error(
          'OMP changed its session file outside Orca. Reopen the target conversation explicitly.'
        )
      )
      return true
    }
    const state = z
      .object({ goal: z.object({ goal: goalSchema }).nullable() })
      .safeParse(frame.state)
    if (state.success) {
      reportGoal(session, state.data.goal?.goal ?? null)
    }
    return true
  }
  if (frame.type === 'prompt_result') {
    const result = z
      .object({
        status: z.enum(['completed', 'aborted', 'error']),
        error: z.object({ message: z.string() }).optional(),
        sessionSettled: z.boolean()
      })
      .parse(frame)
    session.turns.reportPromptOutcome(
      result.status === 'error'
        ? 'failure'
        : result.status === 'aborted'
          ? 'cancellation'
          : 'success',
      result.error?.message
    )
    if (result.sessionSettled) {
      session.turns.commandCompleted()
    }
    return true
  }
  if (frame.type === 'available_commands_update') {
    void session.startup.readCommands()
    return true
  }

  return false
}

export class OmpRpcSessionAdapter extends PiRpcSessionAdapter {
  readonly atRestCommands: StructuredAgentSessionAdapter['atRestCommands']

  constructor(
    deps: PiRpcSessionAdapterDeps & Pick<StructuredAgentSessionAdapter, 'atRestCommands'>
  ) {
    const fastOptions = new WeakMap<PiRpcSession['connection'], OmpRpcFastOptions>()
    super({
      ...deps,
      buildLaunch: buildOmpRpcLaunch,
      openConnection: (launch, handlers) => {
        const connection = (deps.openConnection ?? openOmpRpcConnection)(launch, handlers)
        const observed = new OmpRpcFastOptions()
        const rpc = { request: connection.request.bind(connection) }
        connection.request = (...args) => observed.request(rpc, ...args)
        fastOptions.set(connection, observed)
        return connection
      },
      dialect: {
        agent: 'omp',
        correlatedPrompts: true,
        idleAbort: true,
        prepare: async (connection) => {
          await connection.request('set_subagent_subscription', { level: 'progress' })
        },
        providerLink: ompRpcProviderLink,
        dialogs: createOmpRpcDialogs,
        receive: (frame, session) => receiveOmpFrame(frame, session, deps.logger)
      }
    })
    this.atRestCommands = deps.atRestCommands
    this.readOptions = async (input) => {
      const session = this.session(input.sessionId, input.fence)
      const options = await session.readOptions()
      return fastOptions.get(session.connection)?.read(options) ?? options
    }
  }

  setOption: StructuredAgentSessionAdapter['setOption'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    if (input.key === 'fastMode') {
      if (input.value !== 'true' && input.value !== 'false') {
        throw new Error('OMP Fast mode requires a boolean')
      }
      input.signal?.throwIfAborted()
      await waitForPromiseWithSignal(
        session.connection.request('set_fast_mode', { enabled: input.value === 'true' }),
        input.signal
      )
      session.selected.set('fastMode', input.value)
      return Object.fromEntries(session.selected)
    }
    const result = await applyPiRpcSessionOption(
      session.connection,
      session.selected,
      input.key,
      input.value,
      { signal: input.signal },
      session.optionProof
    )
    await session.refreshOptions().catch((error: unknown) =>
      this.deps.logger.warn('OMP options could not be refreshed after a write', {
        scope: 'omp-rpc',
        sessionId: input.sessionId,
        error
      })
    )
    return result
  }

  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = async (
    input
  ) => {
    const session = this.session(input.sessionId, input.fence)
    input.signal?.throwIfAborted()
    try {
      const current = z
        .object({ goal: goalSchema.nullable() })
        .parse(await session.connection.request('goal', { op: 'get' }))
      if (input.change.kind === 'set' && current.goal && current.goal.status !== 'dropped') {
        return {
          ok: false,
          rejected: 'OMP RPC cannot replace an existing Goal. Clear it before creating another.'
        }
      }
      for (const key of ['model', 'effort'] as const) {
        const value = input.executionOptions?.[key]
        if (value !== undefined) {
          await applyPiRpcSessionOption(
            session.connection,
            session.selected,
            key,
            value,
            { signal: input.signal },
            session.optionProof
          )
        }
      }
      const change = input.change
      const params =
        change.kind === 'set'
          ? { op: 'create', objective: change.objective }
          : change.kind === 'clear'
            ? { op: 'drop' }
            : { op: change.status === 'active' ? 'resume' : 'pause' }
      input.signal?.throwIfAborted()
      const answer = z
        .object({ goal: goalSchema.nullable() })
        .parse(await session.connection.request('goal', params))
      reportGoal(session, answer.goal)
      return { ok: true }
    } catch (error) {
      if (error instanceof JsonlRpcResponseError) {
        if (error.command === 'goal' && error.message === 'Unknown command: goal') {
          return {
            ok: false,
            rejected:
              'This OMP version does not expose native Goal over RPC. Update OMP to use Goal.'
          }
        }
        return { ok: false, rejected: error.message }
      }
      throw error
    }
  }
}
