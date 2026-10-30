import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { isSubagentBlock } from '../../shared/native-chat-types'
import { structuredSessionBackgroundTasksView } from '../../shared/structured-session-background-tasks-view'
import { acpChildWorkStatusSink } from '../acp/acp-structured-child-work.test-support'
import { FakeConnection } from '../pi/rpc-session-adapter.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'

it('publishes concurrent native children to the shared composer strip and retains finished transcript rows', async () => {
  resetHostTestOperationIds()
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-subagent-publication-'))
  const store = await openTestAgentSessionRecordStore(root)
  const records = acpChildWorkStatusSink()
  const log = recordingStructuredAgentSessionLogger()
  let connection: FakeConnection | undefined
  const adapter = new OmpRpcSessionAdapter({
    resolveLaunch: async () => ({ command: 'omp', cwd: root, fullAccess: true, previous: null }),
    readProcessStartTime: async () => 12345,
    openConnection: (_launch, handlers) => {
      connection = new FakeConnection(handlers)
      connection.requestOverride = (command) =>
        command === 'get_entries' ? Promise.resolve({ entries: [], leafId: null }) : undefined
      return connection
    },
    onLifecycle: (event) => void host.handleAdapterEvent(event),
    onSettled: vi.fn(),
    onChildWorkEvidence: (id, evidence, producer) =>
      host.publishChildWorkEvidence(id, evidence, producer),
    logger: log.logger
  })
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([{ definition: OMP_RPC_AGENT, adapter }]),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'omp-subagent-test',
    mintSpawnToken: () => 'spawn',
    now: () => HOST_TEST_NOW,
    statusSink: records.sink,
    logger: log.logger
  })
  try {
    const attached = await host.attach(
      { callerKey: 'client' },
      hostTestAttachParams(null, {
        provider: 'omp',
        agent: 'omp',
        accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root },
        providerHandle: undefined
      })
    )
    if (!attached.ok) {
      throw new Error(JSON.stringify(attached))
    }
    await vi.waitFor(() => expect(connection?.requests).toContain('set_subagent_subscription'))
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
    if (!connection) {
      throw new Error('No OMP connection')
    }
    const wire = connection
    wire.receive({ type: 'agent_start' })
    await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.status).toBe('working'))
    const strip = async () => {
      const page = await host.history({ sessionId: SESSION, direction: 'tail' })
      if (!page.ok) {
        throw new Error('No history')
      }
      return structuredSessionBackgroundTasksView(page.page.backgroundTasks, null)
    }
    for (const id of ['task-child', 'eval-child']) {
      wire.receive({
        type: 'subagent_lifecycle',
        payload: {
          id,
          agent: 'task',
          agentSource: 'bundled',
          status: 'started',
          index: 0,
          description: id,
          parentToolCallId: `call-${id}`
        }
      })
    }
    await vi.waitFor(async () => expect((await strip()).children).toHaveLength(2))
    expect((await strip()).show).toBe(true)
    wire.receive({
      type: 'subagent_progress',
      payload: {
        index: 0,
        agent: 'task',
        agentSource: 'bundled',
        task: 'Inspect the repository',
        parentToolCallId: 'call-task-child',
        progress: {
          id: 'task-child',
          agent: 'task',
          status: 'running',
          tokens: 123,
          currentTool: 'read',
          currentToolArgs: 'README.md',
          recentOutput: ['Found the entry point']
        }
      }
    })
    await vi.waitFor(async () =>
      expect((await strip()).children).toContainEqual(
        expect.objectContaining({
          providerId: 'task-child',
          totalTokens: 123,
          lastMessage: 'Found the entry point'
        })
      )
    )
    wire.receive({ type: 'agent_end', messages: [] })
    await vi.waitFor(async () => expect((await strip()).show).toBe(true))
    for (const id of ['task-child', 'eval-child']) {
      wire.receive({
        type: 'subagent_lifecycle',
        payload: {
          id,
          agent: 'task',
          agentSource: 'bundled',
          status: 'completed',
          index: 0,
          parentToolCallId: `call-${id}`
        }
      })
    }
    await vi.waitFor(async () => expect((await strip()).show).toBe(false))
    await vi.waitFor(async () => {
      await host.flushStreamedEvents(SESSION)
      const snapshot = await host.journalSnapshot(SESSION)
      const children = snapshot.items.flatMap((item) =>
        item.body.kind === 'message' ? item.body.blocks.filter(isSubagentBlock) : []
      )
      expect(children).toHaveLength(2)
      expect(children.every((child) => child.state === 'completed')).toBe(true)
    })
  } finally {
    await adapter.closeAll()
    await host.flushAllStreamedEvents()
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
