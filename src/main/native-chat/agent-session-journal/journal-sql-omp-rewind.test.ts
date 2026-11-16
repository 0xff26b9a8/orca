import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { encodeOmpRewindTarget } from '../../../shared/omp-rewind-target'
import { rewindMessage, sqlRewindFixture } from './journal-sql-rewind.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('rewinds imported OMP history by native entry identity', async () => {
  const f = sqlRewindFixture(cleanup, 'omp')
  const native = (recordId: string) => ({
    provider: 'legacy' as const,
    agent: 'omp',
    sessionId: 'native',
    recordId
  })
  await f.write(native('u1'), rewindMessage('first', 'user'))
  await f.write(native('a1'), rewindMessage('first reply'))
  await f.write(native('u2'), rewindMessage('second', 'user'))
  await f.write(native('a2'), rewindMessage('second reply'))
  const { complete } = f.prepare(agentJournalItemKey(native('u2')))
  await complete()
  expect(f.item(agentJournalItemKey(native('u1')))?.body).toMatchObject({ role: 'user' })
  expect(f.item(agentJournalItemKey(native('a1')))?.body).toMatchObject({ role: 'assistant' })
  expect(f.item(agentJournalItemKey(native('u2')))).toBeUndefined()
  expect(f.item(agentJournalItemKey(native('a2')))).toBeUndefined()
})

it('cuts at the OMP turn opener and retains late output owned by earlier turns', async () => {
  const f = sqlRewindFixture(cleanup, 'omp')
  const host = (clientMessageId: string) => ({ provider: 'orca' as const, clientMessageId })
  await f.write(host('first-turn'), {
    kind: 'turn',
    turnId: 'first',
    state: 'completed',
    userItemId: 'orca:first',
    providerTurnId: encodeOmpRewindTarget({ sessionFile: 'native', timestamp: 100 })
  })
  await f.write(host('first'), rewindMessage('first', 'user'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:first-turn' }
  })
  await f.write(host('second-turn'), {
    kind: 'turn',
    turnId: 'second',
    state: 'completed',
    userItemId: 'orca:second',
    providerTurnId: encodeOmpRewindTarget({ sessionFile: 'native', timestamp: 200 })
  })
  await f.write(host('second'), rewindMessage('second', 'user'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:second-turn' }
  })
  await f.write(host('late'), rewindMessage('late first reply'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:first-turn' },
    ownerFence: 0,
    executionOwner: 0
  })
  const { complete } = f.prepare('orca:second')
  await complete()
  expect(f.item('orca:second-turn')).toBeUndefined()
  expect(f.item('orca:second')).toBeUndefined()
  expect(f.item('orca:first')?.body).toMatchObject({ role: 'user' })
  expect(f.item('orca:late')).toMatchObject({
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'late first reply' }]
    },
    turnScope: { kind: 'turn', turnItemId: 'orca:first-turn' }
  })
})
