import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { FakeConnection, file, state } from '../pi/rpc-session-adapter.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/providers/structured-agent-registry'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'

it('rewinds a saved OMP prompt after closing and reopening the host', async () => {
  resetHostTestOperationIds()
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-cold-rewind-'))
  let store = await openTestAgentSessionRecordStore(root)
  const log = recordingStructuredAgentSessionLogger()
  let connection!: FakeConnection
  let host!: StructuredAgentSessionHost
  let adapter!: OmpRpcSessionAdapter
  let leafId: string | null = null
  const entries: {
    id: string
    parentId: string | null
    type: string
    message: Record<string, unknown>
  }[] = []
  const caller = { callerKey: 'client' }
  const boot = () => {
    adapter = new OmpRpcSessionAdapter({
      resolveLaunch: async () => {
        const previous = agentSessionProviderHandleChainHead(
          store.getRecord(SESSION)?.providerHandleChain ?? []
        )
        return {
          command: 'omp',
          cwd: root,
          fullAccess: true,
          previous,
          ...(previous ? { sessionFile: file } : {})
        }
      },
      readProcessStartTime: async () => 12345,
      openConnection: (_launch, handlers) => {
        connection = new FakeConnection(handlers)
        const request = connection.request.bind(connection)
        connection.request = async (command, params) => {
          if (command === 'get_entries') {
            return { entries, leafId }
          }
          if (command === 'get_state') {
            return { ...state, isSettled: true, queuedMessageCount: 0, goal: null }
          }
          if (command === 'navigate_tree') {
            if (typeof params?.entryId !== 'string') {
              throw new JsonlRpcResponseError(command, 'entryId must be a string')
            }
            leafId = entries.find((entry) => entry.id === params.entryId)!.parentId
            return { cancelled: false }
          }
          return request(command, params)
        }
        return connection
      },
      onLifecycle: (event) => void host.handleAdapterEvent(event),
      onSettled: ({ sessionId, clientMessageId, outcome }) => {
        if (outcome.state !== 'admitted') {
          void host.settleLateDispatch({ sessionId, clientMessageId, ...outcome })
        }
      },
      logger: log.logger
    })
    host = new StructuredAgentSessionHost({
      agents: new StructuredAgentRegistry([{ definition: OMP_RPC_AGENT, adapter }]),
      store,
      adapter,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'rewind-test',
      logger: log.logger,
      now: () => HOST_TEST_NOW,
      probeOwner: async () => ({ outcome: 'exit-observed' })
    })
  }
  const envelope = (method: string, fields: Record<string, unknown>) => ({
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  const attach = async () => {
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(SESSION)?.lease.runtimeFence ?? null, {
          provider: 'omp',
          agent: 'omp',
          accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root },
          providerHandle: undefined
        })
      )
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
  }
  boot()
  try {
    await attach()
    for (const timestamp of [100, 200]) {
      const body = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: `prompt ${timestamp}` }]
      }
      expect(
        await host.send(caller, { body, envelope: envelope('agentSession.send', { body }) })
      ).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(connection.sent.filter((frame) => frame.type === 'prompt')).toHaveLength(
          timestamp / 100
        )
      )
      connection.receive({ type: 'agent_start' })
      const message = { role: 'user', content: `prompt ${timestamp}`, timestamp }
      entries.push({ type: 'message', id: `u${timestamp}`, parentId: leafId, message })
      leafId = `u${timestamp}`
      connection.receive({ type: 'message_end', message })
      connection.receive({ type: 'agent_settled' })
      await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.status).not.toBe('working'))
      await host.flushStreamedEvents(SESSION)
    }
    const snapshot = await host.journalSnapshot(SESSION)
    const target = snapshot.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        item.body.blocks.some((block) => block.type === 'text' && block.text === 'prompt 200')
    )!
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
    await adapter.drainObservedExits()
    await closeTestJournalHostDatabase(root)
    store = await openTestAgentSessionRecordStore(root)
    boot()
    await attach()
    const fields = {
      itemId: target.itemId,
      expectedEpoch: (await host.journalSnapshot(SESSION)).cursor.epoch
    }
    const result = await host.rewind(caller, {
      ...fields,
      envelope: envelope('agentSession.rewind', fields)
    })
    expect(result).toMatchObject({ ok: true })
    expect(leafId).toBe('u100')
    expect(
      (await host.journalSnapshot(SESSION)).items.some((item) => item.itemId === target.itemId)
    ).toBe(false)
  } finally {
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
    await adapter.drainObservedExits()
    await closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
