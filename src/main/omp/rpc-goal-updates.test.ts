import { afterEach, expect, it } from 'vitest'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const goal = {
  id: 'goal-1',
  objective: 'Finish the tickets',
  status: 'active',
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1
}

it('updates Goal usage without appending the same active Goal notice after every tool', async () => {
  const h = await setupOmpRpcAdapter()
  h.connection.receive({ type: 'goal_updated', goal })
  await h.rig.rows()
  for (let step = 1; step <= 12; step++) {
    h.connection.receive({
      type: 'goal_updated',
      goal: { ...goal, tokensUsed: step * 100, timeUsedSeconds: step, updatedAt: step + 1 }
    })
    await h.rig.rows()
  }
  const goals = (await h.rig.rows()).filter(
    (row) => row.body.kind === 'status' && row.body.threadGoal
  )
  expect(goals).toHaveLength(1)
  expect((await h.rig.journal.reads.threadGoalSource()).goal).toMatchObject({
    tokensUsed: 1200,
    timeUsedSeconds: 12,
    updatedAt: 13
  })
  expect((await h.rig.journal.reads.threadGoalSource()).goal).not.toHaveProperty('id')
  const reopened = await h.rig.reopenJournal()
  expect((await reopened.reads.threadGoalSource()).goal).toMatchObject({
    objective: goal.objective,
    tokensUsed: 1200,
    timeUsedSeconds: 12,
    updatedAt: 13
  })
})

it('retains pause, resume, completion and clear while revising queued usage in place', async () => {
  const h = await setupOmpRpcAdapter()
  for (const status of ['active', 'paused', 'active', 'complete']) {
    h.connection.receive({ type: 'goal_updated', goal: { ...goal, status } })
    h.connection.receive({
      type: 'omp_state',
      state: {
        sessionFile: h.opened.link?.handle.nativeId,
        goal: { goal: { ...goal, status, tokensUsed: 500, timeUsedSeconds: 30 } }
      }
    })
  }
  const rows = (await h.rig.rows()).filter((row) => row.body.kind === 'status')
  expect(
    rows.map(
      (row) =>
        row.body.kind === 'status' &&
        row.body.threadGoal?.state === 'set' &&
        row.body.threadGoal.goal.status
    )
  ).toEqual(['active', 'paused', 'active', 'complete'])
  expect((await h.rig.journal.reads.threadGoalSource()).goal).toMatchObject({
    status: 'complete',
    tokensUsed: 500
  })
  expect(
    rows.every(
      (row) =>
        row.body.kind === 'status' &&
        row.body.threadGoal?.state === 'set' &&
        row.body.threadGoal.goal.tokensUsed === 500
    )
  ).toBe(true)
  h.connection.receive({ type: 'goal_updated', goal: null })
  h.connection.receive({ type: 'goal_updated', goal: null })
  const cleared = (await h.rig.rows()).filter((row) => row.body.kind === 'status')
  expect(cleared).toHaveLength(5)
  expect((await h.rig.journal.reads.threadGoalSource()).goal).toBeNull()
})
