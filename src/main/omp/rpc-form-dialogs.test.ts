import { afterEach, expect, it } from 'vitest'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

it('keeps a form as one grouped request and preserves optional and multiline text on submission', async () => {
  const h = await setupOmpRpcAdapter()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'form-1',
    method: 'ask',
    questions: [
      {
        id: 'field-0',
        question: 'Features',
        multi: true,
        allowCustom: false,
        options: [{ label: 'Forms' }, { label: 'Subagents' }],
        textInput: { allowEmpty: true }
      },
      {
        id: 'field-1',
        question: 'Notes',
        options: [],
        encodedText: true,
        textInput: { allowEmpty: true, multiline: true, initialValue: 'draft' }
      },
      {
        id: 'field-2',
        question: 'Optional comment',
        options: [],
        encodedText: true,
        textInput: { allowEmpty: true, placeholder: 'Leave blank if not needed' }
      }
    ]
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row || row.body.kind !== 'question') {
    throw new Error('Form was not displayed')
  }
  expect(row.body.questions).toEqual([
    {
      id: 'field-0',
      question: 'Features',
      multiSelect: true,
      options: [
        { id: 'option-0', label: 'Forms' },
        { id: 'option-1', label: 'Subagents' }
      ],
      freeTextInput: { allowEmpty: true }
    },
    {
      id: 'field-1',
      question: 'Notes',
      multiSelect: false,
      options: [],
      freeTextQuestionId: 'field-1',
      freeTextInput: { allowEmpty: true, multiline: true, initialValue: 'draft' }
    },
    {
      id: 'field-2',
      question: 'Optional comment',
      multiSelect: false,
      options: [],
      freeTextQuestionId: 'field-2',
      freeTextInput: { allowEmpty: true, placeholder: 'Leave blank if not needed' }
    }
  ])
  expect(h.connection.sent).not.toContainEqual(expect.objectContaining({ id: 'form-1' }))
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: row.itemId,
    commit: async () => {},
    response: {
      kind: 'answers',
      answers: [
        { questionId: 'field-0', optionIds: [], other: '' },
        { questionId: 'field-1', optionIds: [], other: '  first\nsecond  ' },
        { questionId: 'field-2', optionIds: [], other: '' }
      ]
    }
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'form-1',
    answers: [
      { id: 'field-0', selectedOptions: [], customInput: '' },
      { id: 'field-1', selectedOptions: [], customInput: '"  first\\nsecond  "' },
      { id: 'field-2', selectedOptions: [], customInput: '""' }
    ]
  })
})
