import { z } from 'zod'
import { OmpRpcSubagents } from './rpc-subagents'
import { receiveOmpNotification } from './rpc-notifications'
import type { PiRpcSession } from '../pi/rpc-session'
import type { PiRpcSessionAdapterDeps } from '../pi/rpc-session-adapter'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

export const goalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'budget-limited', 'complete', 'dropped']),
  tokenBudget: z.number().optional(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

const reportedGoals = new WeakMap<
  PiRpcSession,
  { snapshot: string; signature: string; item: string; occurrence: number }
>()
const subagents = new WeakMap<PiRpcSession, OmpRpcSubagents>()
const fileMentionSchema = z.looseObject({
  role: z.literal('fileMention'),
  files: z.array(z.looseObject({ path: z.string(), content: z.string() })),
  timestamp: z.number()
})

export function reportGoal(session: PiRpcSession, value: unknown): void {
  const parsed = goalSchema.nullable().safeParse(value)
  if (!parsed.success) {
    return
  }
  const goal = parsed.data
  const snapshot = JSON.stringify(goal)
  const previous = reportedGoals.get(session)
  if (previous?.snapshot === snapshot) {
    return
  }
  const signature = JSON.stringify([goal?.id, goal?.createdAt, goal?.objective, goal?.status])
  const accounting = previous?.signature === signature
  const occurrence = accounting ? previous.occurrence : (previous?.occurrence ?? 0) + 1
  const item = accounting
    ? previous.item
    : `omp-goal:${goal?.id ?? 'cleared'}:${goal?.updatedAt ?? Date.now()}:${occurrence}`
  reportedGoals.set(session, { snapshot, signature, item, occurrence })
  if (previous === undefined && goal === null) {
    return
  }
  session.lane.apply([
    {
      type: accounting ? 'item.update' : 'item.close',
      item,
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

export function receiveOmpFrame(
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
