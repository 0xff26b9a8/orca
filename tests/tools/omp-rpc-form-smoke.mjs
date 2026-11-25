import assert from 'node:assert/strict'

export async function runOmpRpcFormSmoke({
  connection,
  first,
  call,
  reset,
  wait,
  toolResults,
  resultData,
  attach,
  createOmpRpcDialogs,
  structuredQuestionAnswers,
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers
}) {
  const cards = [],
    failures = []
  const dialogs = createOmpRpcDialogs(
    {
      apply: (events) => {
        for (const event of events) {
          if (event.type === 'request.open') {
            cards.push({ id: event.request, body: event.body })
          }
        }
      },
      isRequestRow: (item, id) => item === id
    },
    (frame) => connection.send(frame),
    (error) => failures.push(error)
  )
  attach(dialogs)
  dialogs.receive(first)
  const answer = async (card, selections) => {
    const questions = agentSessionPromptQuestions(card.body)
    const answers = structuredQuestionAnswers(questions, selections)
    assert.ok(answers)
    assert.equal(isValidAgentSessionQuestionAnswers(questions, answers), true)
    await dialogs.respond(card.id, { kind: 'answers', answers }, async () => {})
  }
  const begin = async (html) => {
    await wait(async () => (await connection.request('get_state')).isSettled)
    cards.length = 0
    call.arguments.html = html
    reset()
    await connection.send({ type: 'prompt', message: 'REPLAY_HTML_ASK' })
    await wait(() => cards.length > 0)
    return cards[0]
  }
  const empty = (text = '') => ({ indices: [], other: text })
  const none = (card, index) => {
    const options = agentSessionPromptQuestions(card.body)[index].options
    const option = options.findIndex((option) => option.id === 'none')
    assert.notEqual(option, -1)
    return { indices: [option], other: '' }
  }
  const original = call.arguments.html
  await wait(() => cards.length === 1)
  await assert.rejects(
    answer(cards[0], [
      { indices: [0], other: '' },
      { indices: [1, 2], other: '' },
      empty('99'),
      empty('  first\nsecond  ')
    ])
  )
  await answer(cards[0], [
    { indices: [0], other: '' },
    { indices: [1, 2], other: '' },
    empty('7'),
    empty('  first\nsecond  ')
  ])
  await wait(() => toolResults().length === 1)
  assert.deepEqual(resultData(toolResults()[0]), {
    marker: 'native-form',
    response_style: 'concise',
    features: ['background_tasks', 'subagents'],
    number: 7,
    message: '  first\nsecond  '
  })
  const optional = await begin(original)
  await answer(optional, [{ indices: [1], other: '' }, none(optional, 1), empty('5'), empty()])
  await wait(() => toolResults().length === 2)
  assert.deepEqual(resultData(toolResults()[1]), {
    marker: 'native-form',
    response_style: 'detailed',
    features: [],
    number: 5,
    message: ''
  })
  const cancelled = await begin(original)
  await dialogs.respond(cancelled.id, null, async () => {})
  await wait(() => toolResults().length === 3)
  assert.equal(toolResults()[2].isError, true)
  const approval = await begin(
    '<form><p>Review isolated branch changes.</p><label><input type="checkbox" name="approve" value="yes">Approve scoped changes</label></form>'
  )
  await answer(approval, [{ indices: [0], other: '' }])
  await wait(() => toolResults().length === 4)
  assert.deepEqual(resultData(toolResults()[3]), { approve: 'yes' })
  for (const [index, selections] of [
    [{ indices: [0], other: 'Runtime workers' }, empty('Next answer')],
    [{ indices: [], other: 'Runtime workers' }, empty('Next answer')]
  ].entries()) {
    const card = await begin(`<form><fieldset><legend>Configuration</legend>
      <label><input type="checkbox" name="config" value="templates" checked>Templates only</label>
      <label><input type="checkbox" name="config" value="diff">Promote via diff</label>
      </fieldset><label>Next question<input name="next"></label></form>`)
    await answer(card, selections)
    await wait(() => toolResults().length === 5 + index)
    assert.deepEqual(resultData(toolResults()[4 + index]), {
      config: index === 0 ? ['templates', 'Runtime workers'] : ['Runtime workers'],
      next: 'Next answer'
    })
    assert.equal(cards.length, 1)
  }
  const paged = await begin(
    '<form><input name="a"><input name="b"><input name="c"><input name="d"><input type="number" name="n" required></form>'
  )
  await answer(paged, [empty('a'), empty('b'), empty('c'), empty('d')])
  await wait(() => cards.length === 2)
  await answer(cards[1], [empty('7')])
  await wait(() => toolResults().length === 7)
  assert.deepEqual(resultData(toolResults()[6]), { a: 'a', b: 'b', c: 'c', d: 'd', n: 7 })
  assert.deepEqual(failures, [])
  return {
    transport: 'real OMP RPC v2',
    dialog: 'native form',
    model: 'isolated local SSE fixture',
    singleCheckbox: true,
    groupedFields: true,
    other: true,
    numericRetry: true,
    optionalEmpty: true,
    hiddenValues: true,
    whitespace: true,
    cancellation: true,
    paging: true
  }
}
