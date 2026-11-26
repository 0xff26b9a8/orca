import { z } from 'zod'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { captureOmpSubagentStop, refreshOmpSubagents } from './rpc-session-events'
import type { PiRpcConnection, PiRpcSession } from '../pi/rpc/rpc-session'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

export async function supportsOmpSubagentStop(
  connection: Pick<PiRpcConnection, 'request'>
): Promise<boolean> {
  try {
    await connection.request('cancel_subagent', { subagentId: '' })
  } catch (error) {
    return (
      error instanceof JsonlRpcResponseError &&
      error.command === 'cancel_subagent' &&
      error.message === '`subagentId` must be a non-empty string.'
    )
  }
  return false
}

export async function stopOmpSubagents(
  session: PiRpcSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>[0],
  isCurrent: () => boolean
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const targets = [...new Set(input.taskIds)].map((id) => ({
    id,
    current: captureOmpSubagentStop(session, id)
  }))
  if (targets.some((target) => !target.current)) {
    throw new Error('OMP cannot stop a task that is not a live native subagent')
  }
  let cancelled = false
  let stillRunning = false
  for (const target of targets) {
    if (!isCurrent()) {
      break
    }
    if (!target.current?.()) {
      continue
    }
    let response: unknown
    try {
      response = await session.connection.request('cancel_subagent', { subagentId: target.id })
    } catch (error) {
      if (!isCurrent()) {
        break
      }
      if (target.current()) {
        // Preserve the cancellation error unless the roster can prove this run ended.
        await refreshOmpSubagents(session).catch(() => {})
      }
      if (isCurrent() && target.current()) {
        throw error
      }
      continue
    }
    const result = z.object({ cancelled: z.boolean() }).parse(response)
    cancelled ||= result.cancelled
    if (!isCurrent()) {
      break
    }
    if (result.cancelled && target.current()) {
      input.acknowledge?.({ taskId: target.id })
    } else if (target.current()) {
      await refreshOmpSubagents(session)
      if (isCurrent() && target.current()) {
        stillRunning = true
      }
    }
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
