import { afterEach, expect, it, vi } from 'vitest'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers
} from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import {
  closeOmpRpcAdapterFixtures,
  setupOmpRpcAdapter as setup
} from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const checkbox = {
  type: 'extension_ui_request',
  id: 'q3-checkbox',
  method: 'select',
  title: '(3 selected) Q3 configuration',
  options: [
    'Templates only',
    'Promote via diff',
    'Home repo',
    'Other (type your own)',
    '✔ Done selecting'
  ],
  selectionMarker: 'checkbox',
  checkedIndices: [0, 1, 2],
  markableCount: 4
}

async function openCheckbox(initial = checkbox) {
  const h = await setup()
  h.connection.receive(initial)
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row || row.body.kind !== 'question') {
    throw new Error('Missing checkbox card')
  }
  const submit = (optionIds: string[], other: string) =>
    h.adapter.answerPrompt({
      sessionId: 'omp-test',
      fence: 1,
      kind: 'question',
      itemId: row.itemId,
      commit: async () => {},
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds, other }] }
    })
  const sent = (id: string, value: string) =>
    vi.waitFor(() =>
      expect(h.connection.sent).toContainEqual({ type: 'extension_ui_response', id, value })
    )
  return { ...h, row, body: row.body, submit, sent }
}

it.each(['input', 'editor'] as const)(
  'submits checkbox Other through native %s and Done from the original card',
  async (method) => {
    const h = await openCheckbox({
      ...checkbox,
      title: 'Q3 configuration\n\n(3 selected) Runtime configuration rules'
    })
    const questions = agentSessionPromptQuestions(h.body)
    expect(
      isValidAgentSessionQuestionAnswers(questions, [
        { questionId: 'q1', optionIds: ['option-0'], other: 'Runtime workers' }
      ])
    ).toBe(true)
    const answer = h.submit(['option-0'], 'Runtime workers')
    await h.sent('q3-checkbox', 'Promote via diff')
    h.connection.receive({
      ...checkbox,
      id: 'q3-toggle',
      title: 'Q3 configuration\n\n(2 selected) Runtime configuration rules',
      checkedIndices: [0, 2]
    })
    await h.sent('q3-toggle', 'Home repo')
    h.connection.receive({
      ...checkbox,
      id: 'q3-other',
      title: 'Q3 configuration\n\n(1 selected) Runtime configuration rules',
      checkedIndices: [0]
    })
    await h.sent('q3-other', 'Other (type your own)')
    h.connection.receive({
      type: 'extension_ui_request',
      method,
      id: 'q3-text',
      title: 'Q3 configuration\n\nRuntime configuration rules'
    })
    await h.sent('q3-text', 'Runtime workers')
    h.connection.receive({
      ...checkbox,
      id: 'q3-done',
      title: 'Q3 configuration\n\n(2 selected) Runtime configuration rules',
      checkedIndices: [0, 3]
    })
    await answer
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'q3-done',
      value: '✔ Done selecting'
    })
    expect((await h.rig.rows()).filter((row) => row.body.kind === 'question')).toEqual([h.row])
  }
)

it('accepts Other alone and leaves unrelated input requests for the user', async () => {
  const h = await openCheckbox()
  const answer = h.submit([], 'Runtime workers')
  await h.sent('q3-checkbox', 'Templates only')
  h.connection.receive({ ...checkbox, id: 'q3-toggle-1', checkedIndices: [1, 2] })
  await h.sent('q3-toggle-1', 'Promote via diff')
  h.connection.receive({ ...checkbox, id: 'q3-toggle-2', checkedIndices: [2] })
  await h.sent('q3-toggle-2', 'Home repo')
  h.connection.receive({ ...checkbox, id: 'q3-other', checkedIndices: [] })
  await h.sent('q3-other', 'Other (type your own)')
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'unrelated',
    title: 'A separate question'
  })
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'q3-text',
    title: 'Q3 configuration'
  })
  await h.sent('q3-text', 'Runtime workers')
  h.connection.receive({ ...checkbox, id: 'q3-done', checkedIndices: [3] })
  await answer
  expect(h.connection.sent).not.toContainEqual(expect.objectContaining({ id: 'unrelated' }))
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'question')).toMatchObject([
    { itemId: h.row.itemId },
    { body: { question: 'A separate question' } }
  ])
})

it('withdraws the original checkbox when its native Other input is cancelled', async () => {
  const h = await openCheckbox()
  const answer = expect(
    h.submit(['option-0', 'option-1', 'option-2'], 'Runtime workers')
  ).rejects.toThrow('OMP checkbox was withdrawn')
  await h.sent('q3-checkbox', 'Other (type your own)')
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'q3-text',
    title: 'Q3 configuration'
  })
  await h.sent('q3-text', 'Runtime workers')
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'cancel',
    id: 'cancel',
    targetId: 'q3-text'
  })
  await answer
})

it('completes legacy Other editors without waiting for a checkbox the native tool will not send', async () => {
  const h = await openCheckbox({
    ...checkbox,
    options: [
      'Templates only',
      'Promote via diff',
      'Home repo',
      '✔ Done selecting',
      'Other (type your own)'
    ],
    markableCount: 3
  })
  const answer = h.submit(['option-0', 'option-1', 'option-2'], 'Runtime workers')
  await h.sent('q3-checkbox', 'Other (type your own)')
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'editor',
    id: 'legacy-other',
    title: '(3 selected) Q3 configuration'
  })
  await answer
  expect(h.connection.sent).toEqual([
    { type: 'extension_ui_response', id: 'q3-checkbox', value: 'Other (type your own)' },
    { type: 'extension_ui_response', id: 'legacy-other', value: 'Runtime workers' }
  ])
})

it('retries failed Other input delivery against its current native request', async () => {
  const h = await openCheckbox()
  const answer = expect(
    h.submit(['option-0', 'option-1', 'option-2'], 'Runtime workers')
  ).rejects.toThrow('Write failed')
  await h.sent('q3-checkbox', 'Other (type your own)')
  vi.spyOn(h.connection, 'send').mockRejectedValueOnce(new Error('Write failed'))
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'q3-text',
    title: 'Q3 configuration'
  })
  await answer
  const retry = h.submit(['option-0', 'option-1', 'option-2'], 'Revised answer')
  await h.sent('q3-text', 'Revised answer')
  h.connection.receive({ ...checkbox, id: 'q3-done', checkedIndices: [0, 1, 2, 3] })
  await retry
  expect(h.connection.sent).toEqual([
    { type: 'extension_ui_response', id: 'q3-checkbox', value: 'Other (type your own)' },
    { type: 'extension_ui_response', id: 'q3-text', value: 'Revised answer' },
    { type: 'extension_ui_response', id: 'q3-done', value: '✔ Done selecting' }
  ])
})

it('retries Done without reopening Other after native custom input was accepted', async () => {
  const h = await openCheckbox()
  const answer = expect(
    h.submit(['option-0', 'option-1', 'option-2'], 'Runtime workers')
  ).rejects.toThrow('Write failed')
  await h.sent('q3-checkbox', 'Other (type your own)')
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'q3-text',
    title: 'Q3 configuration'
  })
  await h.sent('q3-text', 'Runtime workers')
  vi.spyOn(h.connection, 'send').mockRejectedValueOnce(new Error('Write failed'))
  h.connection.receive({ ...checkbox, id: 'q3-done', checkedIndices: [0, 1, 2, 3] })
  await answer
  await h.submit(['option-0', 'option-1', 'option-2'], 'Runtime workers')
  expect(h.connection.sent).toEqual([
    { type: 'extension_ui_response', id: 'q3-checkbox', value: 'Other (type your own)' },
    { type: 'extension_ui_response', id: 'q3-text', value: 'Runtime workers' },
    { type: 'extension_ui_response', id: 'q3-done', value: '✔ Done selecting' }
  ])
})
