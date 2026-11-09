import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { JsonlRpcPeer } from '../jsonl-rpc/peer'
import { OmpRpcSubagents } from './rpc-subagents'

it('retains child identity across malformed progress and publishes a later terminal exactly once', () => {
  const diagnostic = vi.fn()
  const children = new OmpRpcSubagents(diagnostic)
  const started = children.receive({
    type: 'subagent_lifecycle',
    payload: {
      id: 'child',
      agent: 'task',
      status: 'started',
      parentToolCallId: 'parent',
      description: 'Inspect code'
    }
  })
  expect(started).toMatchObject([
    { type: 'live', child: { handle: { id: 'child', runId: 'parent' } } }
  ])
  for (const payload of [
    undefined,
    {},
    { progress: null },
    { progress: { id: 'child', agent: 'task', status: 'future' } }
  ]) {
    expect(children.receive({ type: 'subagent_progress', payload })).toEqual([])
  }
  expect(diagnostic).toHaveBeenCalledTimes(4)
  const terminal = {
    type: 'subagent_lifecycle',
    payload: { id: 'child', agent: 'task', status: 'completed' }
  }
  expect(children.receive(terminal)).toMatchObject([
    { type: 'live', child: { name: 'Inspect code', handle: { id: 'child', runId: 'parent' } } },
    { type: 'ended', outcome: 'succeeded', handle: { id: 'child', runId: 'parent' } }
  ])
  expect(children.receive(terminal)).toEqual([])
})

it('keeps the peer alive for bad progress but explicitly fails for invalid lifecycle evidence', () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostic = vi.fn()
  const close = vi.fn()
  const ordinary = vi.fn()
  const children = new OmpRpcSubagents(diagnostic)
  const peer = new JsonlRpcPeer(input, output, {
    onRecord: (frame) => {
      if (children.receive(frame) === null) {
        ordinary(frame)
      }
    },
    onClose: close
  })
  const receive = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`)
  try {
    receive({ type: 'subagent_progress', payload: {} })
    receive({ type: 'agent_end', messages: [] })
    expect(diagnostic).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expect(ordinary).toHaveBeenCalledExactlyOnceWith({ type: 'agent_end', messages: [] })
    receive({
      type: 'subagent_lifecycle',
      payload: { id: 'child', agent: 'task', status: 'future' }
    })
    expect(close).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'OMP sent invalid subagent lifecycle data' })
    )
  } finally {
    peer.close()
    input.destroy()
    output.destroy()
  }
})

it('reconciles missing children without retiring live runs or applying stale snapshots', () => {
  const children = new OmpRpcSubagents(vi.fn(), () => true)
  const start = (id: string) =>
    children.receive({
      type: 'subagent_lifecycle',
      payload: { id, agent: 'task', status: 'started', parentToolCallId: `call-${id}` }
    })
  start('finished')
  start('working')
  const reconcile = children.captureRoster()
  expect(reconcile?.({})).toEqual([])
  expect(reconcile?.({ subagents: [{ id: 'working', agent: 'task', status: 'future' }] })).toEqual(
    []
  )
  const stopWorking = children.captureStop('working')
  expect(reconcile?.({ subagents: [{ id: 'working', agent: 'task', status: 'running' }] })).toEqual(
    [
      {
        type: 'ended',
        observedAt: expect.any(Number),
        handle: { idKind: 'task_id', id: 'finished', runId: 'call-finished' },
        outcome: 'unknown'
      }
    ]
  )
  expect(stopWorking?.()).toBe(true)
  const stale = children.captureRoster()
  children.receive({
    type: 'subagent_lifecycle',
    payload: { id: 'working', agent: 'task', status: 'completed' }
  })
  start('working')
  start('new-child')
  expect(stale?.({ subagents: [] })).toEqual([])
  expect(children.captureStop('working')?.()).toBe(true)
  expect(children.captureStop('new-child')?.()).toBe(true)
  expect(stopWorking?.()).toBe(false)
})

it('ignores late progress for vanished children and accepts their actual terminal outcome', () => {
  const children = new OmpRpcSubagents(vi.fn(), () => true)
  children.receive({
    type: 'subagent_lifecycle',
    payload: { id: 'child', agent: 'task', status: 'started', parentToolCallId: 'parent' }
  })
  children.captureRoster()?.({ subagents: [] })
  expect(
    children.receive({
      type: 'subagent_progress',
      payload: { progress: { id: 'child', agent: 'task', status: 'running' } }
    })
  ).toEqual([])
  expect(children.captureStop('child')).toBeUndefined()
  expect(
    children.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'child', agent: 'task', status: 'completed' }
    })
  ).toContainEqual({
    type: 'ended',
    observedAt: expect.any(Number),
    handle: { idKind: 'task_id', id: 'child', runId: 'parent' },
    outcome: 'succeeded'
  })
})
