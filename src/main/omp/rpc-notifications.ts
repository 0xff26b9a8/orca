import { randomUUID } from 'node:crypto'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcSession } from '../pi/rpc-session'

export function receiveOmpNotification(frame: JsonlRpcRecord, session: PiRpcSession): boolean {
  if (frame.type === 'config_update') {
    void session.refreshOptions().catch(() => {
      receiveOmpNotification(
        {
          type: 'notice',
          level: 'error',
          message: 'OMP model options could not be refreshed. Retry opening the model picker.'
        },
        session
      )
    })
    return true
  }
  let text: string | undefined
  if (frame.type === 'command_output' && typeof frame.text === 'string') {
    text = frame.text
  }
  if (frame.type === 'notice' && typeof frame.message === 'string') {
    text = frame.message
  }
  if (frame.type === 'extension_error' && typeof frame.error === 'string') {
    text = `OMP extension: ${frame.error}`
  }
  if (frame.type === 'session_info_update') {
    if (typeof frame.title === 'string') {
      text = `OMP session: ${frame.title}`
    }
    void session.connection.request('get_state').catch((error) => session.fail(error))
  }
  if (text === undefined) {
    return false
  }
  session.lane.apply([
    {
      type: 'item.close',
      item: `omp-notification:${randomUUID()}`,
      body: {
        kind: 'status',
        text,
        tone: frame.type === 'extension_error' || frame.level === 'error' ? 'error' : 'info'
      }
    }
  ])
  return true
}
