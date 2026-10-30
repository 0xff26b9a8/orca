import { beforeEach, expect, it, vi } from 'vitest'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import { openOmpRpcConnection } from './rpc-connection'

const transport = vi.hoisted(() => ({
  request: vi.fn<(command: string) => Promise<unknown>>(),
  send: vi.fn(),
  receive: (_frame: { type: string; [key: string]: unknown }) => {}
}))

vi.mock('../jsonl-rpc/agent-connection', () => ({
  JsonlRpcAgentConnection: class {
    request = transport.request
    send = transport.send
    constructor(_launch: unknown, options: JsonlRpcAgentConnectionOptions) {
      transport.receive = (frame) => options.onRecord?.(frame)
      queueMicrotask(() => transport.receive({ type: 'ready', supportedProtocolVersions: [1, 2] }))
    }
  }
}))

beforeEach(() => vi.clearAllMocks())

it('opens older RPC UI sessions without opting into grouped Ask', async () => {
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    if (command === 'set_ask_dialog') {
      throw new JsonlRpcResponseError(command, 'Unknown command: set_ask_dialog')
    }
    if (command === 'get_available_commands') {
      return { commands: [] }
    }
    return { isSettled: true, queuedMessageCount: 0, sessionFile: '/session.jsonl' }
  })
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  await expect(connection.request('get_state')).resolves.toMatchObject({ pendingMessageCount: 0 })
  await connection.send({ type: 'prompt', id: 'old', message: 'Hello' })
  expect(transport.send).toHaveBeenCalledWith({ type: 'prompt', id: 'old', message: 'Hello' })
})

it('does not hide failures while enabling grouped Ask', async () => {
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    throw new JsonlRpcResponseError(command, 'Extension initialization failed')
  })
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  await expect(connection.request('get_state')).rejects.toThrow('Extension initialization failed')
  expect(transport.send).not.toHaveBeenCalled()
})

it('loads relocation policy before the first prompt and applies dynamic command aliases', async () => {
  const catalog = Promise.withResolvers<unknown>()
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    if (command === 'get_available_commands') {
      return catalog.promise
    }
    return {}
  })
  const received = vi.fn()
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, { onRecord: received })
  let sent = false
  const first = connection
    .send({ type: 'prompt', id: 'first', message: '/move elsewhere' })
    .then(() => {
      sent = true
    })
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith('get_available_commands'))
  expect(sent).toBe(false)
  expect(transport.send).not.toHaveBeenCalled()
  catalog.resolve({ commands: [{ name: 'move', source: 'builtin' }] })
  await first
  expect(transport.send).not.toHaveBeenCalled()
  expect(received).toHaveBeenCalledWith(
    expect.objectContaining({ promptId: 'first', success: false })
  )
  transport.receive({
    type: 'available_commands_update',
    commands: [
      { name: 'wt', source: 'builtin', aliases: ['worktree'] },
      { name: 'custom', source: 'extension' }
    ]
  })
  await connection.send({ type: 'prompt', id: 'alias', message: '/worktree:elsewhere' })
  expect(transport.send).not.toHaveBeenCalled()
  await connection.send({ type: 'prompt', id: 'extension', message: '/custom' })
  expect(transport.send).toHaveBeenCalledOnce()
})
