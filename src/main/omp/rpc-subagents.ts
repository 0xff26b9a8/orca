import { z } from 'zod'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

const childSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: z.enum(['started', 'pending', 'running', 'completed', 'failed', 'aborted']),
  description: z.string().optional(),
  task: z.string().optional(),
  parentToolCallId: z.string().optional(),
  detached: z.boolean().optional(),
  recentOutput: z.array(z.string()).optional(),
  tokens: z.number().nonnegative().optional(),
  currentTool: z.string().optional(),
  currentToolArgs: z.string().optional()
})

const progressSchema = z
  .object({ payload: z.looseObject({ progress: z.record(z.string(), z.unknown()) }) })
  .transform(({ payload }): unknown => ({ ...payload, ...payload.progress }))
  .pipe(childSchema)
const lifecycleSchema = z.object({ payload: childSchema }).transform(({ payload }) => payload)
type Child = z.infer<typeof childSchema> & { run: object }

export class OmpRpcSubagents {
  private readonly children = new Map<string, Child>()
  private readonly completed = new Set<string>()
  private readonly vanished = new Map<string, Child>()

  constructor(
    private readonly onDiagnostic: (message: string) => void,
    private readonly supportsStop: () => boolean = () => false
  ) {}

  captureStop(id: string): (() => boolean) | undefined {
    const child = this.children.get(id)
    return this.supportsStop() && child ? () => this.children.get(id)?.run === child.run : undefined
  }

  captureRoster(): ((value: unknown) => AgentChildWorkEvidence[]) | undefined {
    if (this.children.size === 0) {
      return undefined
    }
    const captured = new Map(this.children)
    return (value) => {
      const parsed = z.object({ subagents: z.array(childSchema) }).safeParse(value)
      if (!parsed.success) {
        return []
      }
      const roster = new Map(parsed.data.subagents.map((child) => [child.id, child]))
      const evidence: AgentChildWorkEvidence[] = []
      for (const [id, child] of captured) {
        // Frames received after the query take precedence over its snapshot.
        if (this.children.get(id) !== child) {
          continue
        }
        const reported = roster.get(id)
        if (
          reported &&
          (reported.parentToolCallId === undefined ||
            child.parentToolCallId === undefined ||
            reported.parentToolCallId === child.parentToolCallId)
        ) {
          if (['completed', 'failed', 'aborted'].includes(reported.status)) {
            evidence.push(
              ...(this.receive({ type: 'subagent_lifecycle', payload: reported }) ?? [])
            )
          }
          continue
        }
        this.children.delete(id)
        this.vanished.set(id, child)
        this.rememberCompleted(id)
        evidence.push({
          type: 'ended',
          observedAt: Date.now(),
          handle: {
            idKind: 'task_id',
            id,
            ...(child.parentToolCallId ? { runId: child.parentToolCallId } : {})
          },
          outcome: 'unknown'
        })
      }
      return evidence
    }
  }

  private rememberCompleted(id: string): void {
    this.completed.add(id)
    if (this.completed.size > 1024) {
      const oldest = this.completed.values().next().value
      if (oldest !== undefined) {
        this.completed.delete(oldest)
        this.vanished.delete(oldest)
      }
    }
  }

  receive(frame: JsonlRpcRecord): AgentChildWorkEvidence[] | null {
    if (frame.type !== 'subagent_lifecycle' && frame.type !== 'subagent_progress') {
      return null
    }
    const parsed = (
      frame.type === 'subagent_progress' ? progressSchema : lifecycleSchema
    ).safeParse(frame)
    if (!parsed.success) {
      if (frame.type === 'subagent_progress') {
        this.onDiagnostic('OMP ignored invalid subagent progress data')
        return []
      }
      throw new Error('OMP sent invalid subagent lifecycle data', { cause: parsed.error })
    }
    const incoming = parsed.data
    const previous = this.children.get(incoming.id) ?? this.vanished.get(incoming.id)
    const ended = (status: string) => ['completed', 'failed', 'aborted'].includes(status)
    const restart = incoming.status === 'started' && this.completed.has(incoming.id)
    if (
      this.completed.has(incoming.id) &&
      !restart &&
      !(this.vanished.has(incoming.id) && ended(incoming.status))
    ) {
      return []
    }
    this.completed.delete(incoming.id)
    this.vanished.delete(incoming.id)
    const child = { ...previous, ...incoming, run: restart ? {} : (previous?.run ?? {}) }
    this.children.set(child.id, child)
    const observedAt = Date.now()
    const handle = {
      idKind: 'task_id',
      id: child.id,
      ...(child.parentToolCallId ? { runId: child.parentToolCallId } : {})
    } as const
    const lastMessage = child.recentOutput?.[0]
    const live: AgentChildWorkEvidence = {
      type: 'live',
      observedAt,
      child: {
        handle,
        kind: 'agent',
        residency: child.detached ? 'background' : 'foreground',
        state: child.status === 'pending' ? 'waiting' : 'working',
        name: child.description ?? child.agent,
        agentType: child.agent,
        ...(child.task ? { description: child.task } : {}),
        ...(lastMessage ? { lastMessage } : {}),
        ...(child.tokens === undefined ? {} : { totalTokens: child.tokens }),
        operation: child.currentTool
          ? {
              toolName: child.currentTool,
              input: child.currentToolArgs,
              basis: 'reported',
              observedAt
            }
          : null,
        stoppable: this.supportsStop() && !ended(child.status)
      }
    }
    if (!ended(child.status)) {
      return [{ ...live, ...(restart ? { restart: true as const } : {}) }]
    }
    this.children.delete(child.id)
    this.rememberCompleted(child.id)
    return [
      live,
      {
        type: 'ended',
        observedAt,
        handle,
        outcome:
          child.status === 'completed'
            ? 'succeeded'
            : child.status === 'aborted'
              ? 'cancelled'
              : 'failed',
        ...(lastMessage ? { lastMessage } : {}),
        ...(child.tokens === undefined ? {} : { totalTokens: child.tokens })
      }
    ]
  }
}
