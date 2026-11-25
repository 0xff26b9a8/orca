import { afterEach, expect, it } from 'vitest'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import {
  closeOmpRpcAdapterFixtures,
  setupOmpRpcAdapter as setup
} from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

async function openForm(html: string) {
  const h = await setup()
  h.connection.receive({ type: 'extension_ui_request', id: 'native-form', method: 'form', html })
  const card = async () => {
    const row = (await h.rig.rows()).findLast((row) => row.body.kind === 'question')
    if (!row || row.body.kind !== 'question') {
      throw new Error('Missing native form card')
    }
    return { ...row, body: row.body }
  }
  const submit = async (answers: AgentSessionQuestionAnswer[]) => {
    const row = await card()
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(row.body), answers)).toBe(
      true
    )
    return h.adapter.answerPrompt({
      sessionId: 'omp-test',
      fence: 1,
      kind: 'question',
      itemId: row.itemId,
      commit: async () => {},
      response: { kind: 'answers', answers }
    })
  }
  return { ...h, card, submit }
}

it('answers the native HTML approval form without cancelling the Ask tool', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'native-form',
    method: 'form',
    html: '<form><p>Review the isolated branch changes.</p><label><input type="checkbox" name="approve" value="yes">Approve the scoped changes</label></form>'
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  expect(h.connection.sent).not.toContainEqual({
    type: 'extension_ui_response',
    id: 'native-form',
    cancelled: true
  })
  if (!row || row.body.kind !== 'question') {
    throw new Error('Missing native form card')
  }
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: row.itemId,
    commit: async () => {},
    response: { kind: 'answers', answers: [{ questionId: 'field-0', optionIds: ['option-0'] }] }
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'native-form',
    data: { approve: 'yes' }
  })
})

it('serializes choice values, Other, hidden data and whitespace into one native form response', async () => {
  const h = await openForm(`<form>
    <script>throw new Error('must never execute')</script><input type="hidden" name="marker" value="a&amp;b">
    <fieldset><legend>Choose the deployment target</legend>
      <label><input type="radio" name="target" value="dev" required>Same label</label>
      <label><input type="radio" name="target" value="prod" required>Same label</label>
    </fieldset>
    <label><input type="checkbox" name="features" value="cache" checked>Cache</label>
    <label><input type="checkbox" name="features" value="jobs">Jobs</label>
    <label for="region">Region</label><select id="region" name="region" required>
      <option value="blocked" disabled>Unavailable</option><option value="eu-west">Europe &amp; UK</option>
    </select><label>Notes<textarea name="notes" required></textarea></label>
    </form>`)
  await h.submit([
    { questionId: 'field-0', optionIds: ['option-1'] },
    { questionId: 'field-1', optionIds: ['option-0'], other: 'runtime' },
    { questionId: 'field-2', optionIds: ['option-1'] },
    { questionId: 'field-3', optionIds: [], other: '  first\nsecond  ' }
  ])
  expect(h.connection.sent).toEqual([
    {
      type: 'extension_ui_response',
      id: 'native-form',
      data: {
        marker: 'a&b',
        target: 'prod',
        features: ['cache', 'runtime'],
        region: 'eu-west',
        notes: '  first\nsecond  '
      }
    }
  ])
})

it('pages large forms locally and keeps invalid numeric answers retryable before submission', async () => {
  const h = await openForm(`<form>
    <input type="hidden" name="first" value="fallback">
    <label>First<input name="first"></label><label>Second<input name="second"></label>
    <label>Third<input name="third"></label><label>Fourth<input name="fourth"></label>
    <label>Count<input type="number" name="count" min="1" max="10" required></label>
    <input name="__proto__">
    </form>`)
  await h.submit([
    { questionId: 'field-0', optionIds: [], other: 'one' },
    { questionId: 'field-1', optionIds: [], other: '' },
    { questionId: 'field-2', optionIds: [], other: 'three' },
    { questionId: 'field-3', optionIds: [], other: 'four' }
  ])
  expect(h.connection.sent).toEqual([])
  await expect(
    h.submit([
      { questionId: 'field-4', optionIds: [], other: '99' },
      { questionId: 'field-5', optionIds: [], other: 'kept' }
    ])
  ).rejects.toThrow()
  expect(h.connection.sent).toEqual([])
  await h.submit([
    { questionId: 'field-4', optionIds: [], other: '7' },
    { questionId: 'field-5', optionIds: [], other: 'kept' }
  ])
  expect(h.connection.sent).toEqual([
    {
      type: 'extension_ui_response',
      id: 'native-form',
      data: {
        first: 'one',
        second: '',
        third: 'three',
        fourth: 'four',
        count: 7,
        ['__proto__']: 'kept'
      }
    }
  ])
})

it('preserves empty optional choices and text without sending invented values', async () => {
  const h = await openForm(`<form>
    <label><input type="checkbox" name="approve" value="yes">Approve</label>
    <label><input type="checkbox" name="features" value="a">A</label>
    <label><input type="checkbox" name="features" value="b">B</label>
    <label>Notes<textarea name="notes"></textarea></label></form>`)
  await h.submit([
    { questionId: 'field-0', optionIds: ['none'] },
    { questionId: 'field-1', optionIds: ['none'] },
    { questionId: 'field-2', optionIds: [], other: '' }
  ])
  expect(h.connection.sent).toEqual([
    {
      type: 'extension_ui_response',
      id: 'native-form',
      data: { features: [], notes: '' }
    }
  ])
})

it('cancels a paged form without submitting the completed first page', async () => {
  const h = await openForm(
    '<form><input name="a"><input name="b"><input name="c"><input name="d"><input name="e"></form>'
  )
  await h.submit([
    { questionId: 'field-0', optionIds: [], other: 'a' },
    { questionId: 'field-1', optionIds: [], other: 'b' },
    { questionId: 'field-2', optionIds: [], other: 'c' },
    { questionId: 'field-3', optionIds: [], other: 'd' }
  ])
  await h.adapter.cancelTurn({ sessionId: 'omp-test', fence: 1 })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'native-form',
    cancelled: true
  })
  expect(h.connection.sent.some((frame) => frame.data !== undefined)).toBe(false)
})
