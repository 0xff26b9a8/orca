import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRowJson,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './store-lifecycle/journal-host-database-test-support'
import type { JournalHostDatabase } from './database/journal-host-database'
import { restoreJournal } from './replay/journal-open'
import { openAgentSessionJournal } from './journal-store-factory'
import { openTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'

const sessionId = 'omp-legacy-goal'
const epoch = 'epoch-1'
const goal = {
  id: 'legacy-native-goal-id',
  objective: 'Finish the task',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 120,
  timeUsedSeconds: 30,
  createdAt: 1,
  updatedAt: 2
}
const base = { v: 2, epoch, fence: 1, ts: 1 }
let root: string
let database: JournalHostDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-omp-goal-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, epoch)
    insertTestJournalRowJson(
      db,
      sessionId,
      1,
      JSON.stringify({
        ...base,
        seq: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { transport: 'rpc', agent: 'omp', nativeId: 'native-session' }
      })
    )
  })
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function insertGoal(value: unknown): void {
  insertTestJournalRowJson(
    database.db,
    sessionId,
    2,
    JSON.stringify({
      ...base,
      seq: 2,
      kind: 'item',
      itemId: 'legacy-goal',
      revision: 1,
      body: { kind: 'status', text: 'Goal: Finish the task (active)', threadGoal: value }
    })
  )
}

it('preserves legacy OMP goal identity through SQL conversion and later writes', async () => {
  insertGoal({ state: 'set', goal })
  await database.close()
  const journal = await openAgentSessionJournal({
    database: await openTestAgentSessionDatabase(root),
    identity: {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'omp',
      providerHandle: { transport: 'rpc', agent: 'omp', nativeId: 'native-session' }
    }
  })
  try {
    expect((await journal.reads.threadGoalSource()).goal).toMatchObject({
      id: 'legacy-native-goal-id',
      tokensUsed: 120,
      status: 'active'
    })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'later' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    expect((await journal.reads.threadGoalSource()).goal).toMatchObject({
      id: 'legacy-native-goal-id',
      tokensUsed: 120,
      status: 'active'
    })
  } finally {
    await journal.close()
  }
})

it('still refuses undeclared future goal fields', () => {
  insertGoal({ state: 'set', goal: { ...goal, futureGoalState: 'unknown' } })
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 2 },
    damage: null
  })
})

it('still refuses unknown future goal states', () => {
  insertGoal({ state: 'future-state', goal })
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 2 },
    damage: null
  })
})
