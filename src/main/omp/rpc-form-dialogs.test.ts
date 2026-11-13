import { afterEach, expect, it } from 'vitest'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'
import { ompRpcDialogPresentation } from './rpc-dialogs'
import { structuredQuestionAnswers } from '../../shared/structured-agent-question-card'
import { isValidAgentSessionQuestionAnswers } from '../../shared/agent-session/agent-session-question-answer'

afterEach(closeOmpRpcAdapterFixtures)

it('submits closed form choices through the Native Chat answer validation', () => {
  const presentation = ompRpcDialogPresentation({
    id: 'optional-choice',
    method: 'ask',
    questions: [
      {
        id: 'style',
        question: 'Response style',
        options: [{ label: 'Concise' }, { label: 'Detailed' }],
        allowCustom: false,
        textInput: { allowEmpty: true }
      },
      {
        id: 'features',
        question: 'Features',
        options: [{ label: 'Forms' }, { label: 'Subagents' }],
        multi: true,
        allowCustom: false,
        textInput: { allowEmpty: true }
      }
    ]
  })
  if (presentation?.body.kind !== 'question' || !presentation.body.questions) {
    throw new Error('Missing form questions')
  }
  const questions = presentation.body.questions
  const answers = structuredQuestionAnswers(questions, [
    { indices: [2], other: '' },
    { indices: [1, 2], other: '' }
  ])
  expect(answers).not.toBeNull()
  expect(isValidAgentSessionQuestionAnswers(questions, answers!)).toBe(true)
  expect(presentation.reply({ kind: 'answers', answers: answers! })).toEqual({
    answers: [
      { id: 'style', selectedOptions: ['Detailed'] },
      { id: 'features', selectedOptions: ['Forms', 'Subagents'] }
    ]
  })
  const skipped = structuredQuestionAnswers(questions, [
    { indices: [0], other: '' },
    { indices: [0], other: '' }
  ])
  expect(skipped).not.toBeNull()
  expect(isValidAgentSessionQuestionAnswers(questions, skipped!)).toBe(true)
  expect(presentation.reply({ kind: 'answers', answers: skipped! })).toEqual({
    answers: [
      { id: 'style', selectedOptions: [] },
      { id: 'features', selectedOptions: [] }
    ]
  })
})

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
        { id: 'omp-empty-choice', label: 'Leave unselected' },
        { id: 'option-0', label: 'Forms' },
        { id: 'option-1', label: 'Subagents' }
      ]
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
