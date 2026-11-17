import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionPromptQuestions } from '../../shared/agent-session/agent-session-question-answer'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  closeOmpRpcAdapterFixtures,
  setupOmpRpcAdapter as setup
} from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const checkbox = {
  type: 'extension_ui_request',
  id: 'checkbox-1',
  method: 'select',
  title: '(1 selected) Which features?',
  options: ['Forms', 'Background tasks', 'Subagents', 'Other (type your own)', '✔ Done selecting'],
  selectionMarker: 'checkbox',
  checkedIndices: [0],
  markableCount: 4
}

async function openCheckbox() {
  const h = await setup()
  h.connection.receive(checkbox)
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row || row.body.kind !== 'question') {
    throw new Error('Missing checkbox card')
  }
  const submit = (optionIds: string[]) =>
    h.adapter.answerPrompt({
      sessionId: 'omp-test',
      fence: 1,
      kind: 'question',
      itemId: row.itemId,
      commit: async () => {},
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds }] }
    })
  return { ...h, row, body: row.body, submit }
}

it('submits one checkbox card as native toggles followed by Done without redisplaying it', async () => {
  const h = await openCheckbox()
  const { row } = h
  expect(h.body.questions).toMatchObject([
    {
      id: 'q1',
      multiSelect: true,
      options: [
        { id: 'option-0', label: 'Forms' },
        { id: 'option-1', label: 'Background tasks' },
        { id: 'option-2', label: 'Subagents' },
        { id: 'option-3', label: 'Other (type your own)' }
      ]
    }
  ])
  const answer = h.submit(['option-1', 'option-2'])
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Forms'
    })
  )
  h.connection.receive({
    ...checkbox,
    id: 'checkbox-2',
    title: 'Which features?',
    checkedIndices: []
  })
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-2',
      value: 'Background tasks'
    })
  )
  h.connection.receive({ ...checkbox, id: 'checkbox-3', checkedIndices: [1] })
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-3',
      value: 'Subagents'
    })
  )
  h.connection.receive({
    ...checkbox,
    id: 'checkbox-4',
    title: '(2 selected) Which features?',
    checkedIndices: [1, 2]
  })
  await answer
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'checkbox-4',
    value: '✔ Done selecting'
  })
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'question')).toEqual([row])
})

it('cancels the latest native request if its checkbox state disagrees with the submitted selection', async () => {
  const h = await openCheckbox()
  const answer = expect(h.submit(['option-1'])).rejects.toThrow(
    'OMP checkbox state changed unexpectedly'
  )
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Forms'
    })
  )
  h.connection.receive({ ...checkbox, id: 'unexpected', checkedIndices: [0, 2] })
  await answer
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'unexpected',
    cancelled: true
  })
  await expect(h.submit(['option-0'])).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
})

it('keeps the latest native request retryable after final delivery fails', async () => {
  const h = await openCheckbox()
  const answer = expect(h.submit(['option-0', 'option-1'])).rejects.toThrow('Write failed')
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Background tasks'
    })
  )
  vi.spyOn(h.connection, 'send').mockRejectedValueOnce(new Error('Write failed'))
  h.connection.receive({ ...checkbox, id: 'retry-done', checkedIndices: [0, 1] })
  await answer
  await h.submit(['option-0', 'option-1'])
  expect(h.connection.sent).toEqual([
    { type: 'extension_ui_response', id: 'checkbox-1', value: 'Background tasks' },
    { type: 'extension_ui_response', id: 'retry-done', value: '✔ Done selecting' }
  ])
})

it('cancels a checkbox without submitting an empty answer or granting its offered action', async () => {
  const h = await openCheckbox()
  await h.adapter.dismissPrompt({
    sessionId: 'omp-test',
    fence: 1,
    itemId: h.row.itemId,
    commit: async () => {},
    answer: true
  })
  expect(h.connection.sent).toEqual([
    { type: 'extension_ui_response', id: 'checkbox-1', cancelled: true }
  ])
  await expect(h.submit(['option-0'])).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
})

it('releases an in-flight checkbox submission when its OMP process exits', async () => {
  const h = await openCheckbox()
  const answer = expect(h.submit(['option-1'])).rejects.toThrow('OMP checkbox was cancelled')
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Forms'
    })
  )
  h.connection.exit()
  await answer
})

it('keeps unrelated dialogs separate and withdraws a checkbox by its latest native identity', async () => {
  const h = await openCheckbox()
  const answer = expect(h.submit(['option-1', 'option-2'])).rejects.toThrow(
    'OMP checkbox was withdrawn'
  )
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Forms'
    })
  )
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'input',
    id: 'unrelated',
    title: 'Notes'
  })
  h.connection.receive({ ...checkbox, id: 'checkbox-next', checkedIndices: [] })
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'cancel',
    id: 'cancel',
    targetId: 'checkbox-next'
  })
  await answer
  const notes = (await h.rig.rows()).find(
    (row) => row.body.kind === 'question' && row.body.question === 'Notes'
  )
  if (!notes) {
    throw new Error('Missing unrelated dialog')
  }
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: notes.itemId,
    commit: async () => {},
    response: {
      kind: 'answers',
      answers: [{ questionId: 'unrelated', optionIds: [], other: 'Keep this dialog' }]
    }
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'unrelated',
    value: 'Keep this dialog'
  })
})

it('opens the native editor for custom input after reconciling the checked options', async () => {
  const h = await openCheckbox()
  const answer = h.submit(['option-1', 'option-3'])
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'checkbox-1',
      value: 'Forms'
    })
  )
  h.connection.receive({ ...checkbox, id: 'custom-toggle', checkedIndices: [] })
  await vi.waitFor(() =>
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'custom-toggle',
      value: 'Background tasks'
    })
  )
  h.connection.receive({ ...checkbox, id: 'custom-done', checkedIndices: [1] })
  await answer
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'custom-done',
    value: 'Other (type your own)'
  })
  h.connection.receive({
    type: 'extension_ui_request',
    method: 'editor',
    id: 'custom-editor',
    title: 'Specify another feature'
  })
  const row = (await h.rig.rows()).find(
    (row) => row.body.kind === 'question' && row.body.question === 'Specify another feature'
  )
  if (!row || row.body.kind !== 'question') {
    throw new Error('Missing native editor')
  }
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: row.itemId,
    commit: async () => {},
    response: {
      kind: 'answers',
      answers: [
        {
          questionId: agentSessionPromptQuestions(row.body)[0]!.id,
          optionIds: [],
          other: 'Native input'
        }
      ]
    }
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'custom-editor',
    value: 'Native input'
  })
})
