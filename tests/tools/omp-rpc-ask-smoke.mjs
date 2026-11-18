import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const root = await mkdtemp(resolve('.tmp/omp-rpc-form-'))
const account = join(root, 'agent'),
  cwd = join(root, 'workspace')
for (const path of [account, cwd, join(root, 'temp')]) {
  await mkdir(path, { recursive: true })
}
const call = {
  arguments: {
    html: `<form>
  <input type="hidden" name="marker" value="native-form">
  <fieldset><legend>Which response style do you prefer?</legend>
    <label><input type="radio" name="response_style" value="concise" checked> Concise</label>
    <label><input type="radio" name="response_style" value="detailed"> Detailed</label>
  </fieldset>
  <fieldset><legend>Which features would you like to test?</legend>
    <label><input type="checkbox" name="features" value="forms" checked> Forms</label>
    <label><input type="checkbox" name="features" value="background_tasks"> Background tasks</label>
    <label><input type="checkbox" name="features" value="subagents"> Subagents</label>
  </fieldset>
  <label>Pick a number from 1 to 10 <input type="number" name="number" min="1" max="10" value="5" required></label>
  <label>Write a short test message <textarea name="message"></textarea></label>
</form>`
  }
}
const requests = [],
  frames = []
let invoked = false
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) {
    body += part
  }
  if (!body) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
    return
  }
  const request = JSON.parse(body)
  requests.push(request)
  const first =
    !invoked &&
    request.messages.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('REPLAY_HTML_ASK')
    )
  if (first) {
    invoked = true
  }
  const delta = first
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'replay-ask',
            type: 'function',
            function: { name: 'ask', arguments: JSON.stringify(call.arguments) }
          }
        ]
      }
    : { role: 'assistant', content: 'Replay completed' }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of [
    {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'ask-replay',
      choices: [{ index: 0, delta, finish_reason: null }]
    },
    {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'ask-replay',
      choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }
  ]) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
await writeFile(
  join(account, 'models.yml'),
  JSON.stringify({
    providers: {
      openai: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'isolated-placeholder',
        api: 'openai-completions',
        models: [
          {
            id: 'ask-replay',
            name: 'Ask replay',
            reasoning: false,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  })
)
const outfile = join(root, 'adapter.cjs')
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      export {openOmpRpcConnection} from './src/main/omp/rpc-connection';
      export {piRpcDialogPresentation} from './src/main/pi/rpc/rpc-extension-dialogs';
      export {createOmpRpcDialogs} from './src/main/omp/rpc-dialogs';
      export {structuredQuestionAnswers} from './src/shared/native-chat/input/questions/structured-agent-question-card';
      export {isValidAgentSessionQuestionAnswers} from './src/shared/agent-session/requests/prompts/agent-session-question-answer';
      export {agentSessionPromptQuestions} from './src/shared/agent-session/requests/prompts/agent-session-question-answer';
    `
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile
})
const {
  openOmpRpcConnection,
  piRpcDialogPresentation,
  createOmpRpcDialogs,
  structuredQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  agentSessionPromptQuestions
} = createRequire(import.meta.url)(outfile)
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  PI_CODING_AGENT_DIR: account,
  APPDATA: join(root, 'appdata'),
  LOCALAPPDATA: join(root, 'localappdata'),
  TEMP: join(root, 'temp'),
  TMP: join(root, 'temp'),
  TMPDIR: join(root, 'temp'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  OMP_PROFILE: '',
  PI_PROFILE: ''
}
for (const key of Object.keys(env)) {
  if (/API_KEY|TOKEN|CODEX|ANTHROPIC_AUTH/i.test(key)) {
    delete env[key]
  }
}
const config = join(root, 'rpc.yml')
await writeFile(config, 'ask:\n  timeout: 0\n')
let hostDialogs
const connection = openOmpRpcConnection(
  {
    command: resolve(process.argv[2]),
    args: [
      '--mode',
      'rpc-ui',
      '--provider',
      'openai',
      '--model',
      'ask-replay',
      '--no-extensions',
      '--tools',
      'ask',
      '--config',
      config
    ],
    cwd,
    env
  },
  {
    onRecord: (frame) => {
      frames.push(frame)
      if (frame.type === 'extension_ui_request') {
        hostDialogs?.receive(frame)
      }
    }
  }
)
const wait = async (predicate) => {
  const until = Date.now() + 25000
  while (Date.now() < until) {
    if (await predicate()) {
      return
    }
    await delay(25)
  }
  throw new Error(
    `Replay timed out: ${JSON.stringify(
      frames.map((f) => ({ type: f.type, method: f.method, error: f.error }))
    )}`
  )
}
const dialogs = () =>
  frames.filter(
    (frame) =>
      frame.type === 'extension_ui_request' &&
      ['select', 'input', 'editor', 'ask'].includes(frame.method)
  )
let dialogIndex = 0
const nextDialog = async () => {
  await wait(() => dialogs().length > dialogIndex)
  const frame = dialogs()[dialogIndex++]
  assert.notEqual(frame.method, 'ask', 'Native HTML Ask must keep its own field-by-field flow')
  return frame
}
const answer = async (frame, selection) => {
  const presentation = piRpcDialogPresentation(frame)
  assert.equal(presentation?.body.kind, 'question')
  const questions = agentSessionPromptQuestions(presentation.body)
  const answers = structuredQuestionAnswers(questions, [selection])
  assert.ok(answers)
  assert.equal(isValidAgentSessionQuestionAnswers(questions, answers), true)
  await connection.send({
    type: 'extension_ui_response',
    id: frame.id,
    ...presentation.reply({ kind: 'answers', answers })
  })
}
const pick = async (frame, label) => {
  const index = frame.options.indexOf(label)
  assert.notEqual(index, -1, `Missing native option: ${label}`)
  await answer(frame, { indices: [index], other: '' })
}
const finishChoices = async (frame) => {
  const index = frame.options.findIndex((label) => /Done selecting/.test(label))
  assert.notEqual(index, -1)
  await answer(frame, { indices: [index], other: '' })
}
const toolResults = () =>
  frames.filter((frame) => frame.type === 'tool_execution_end' && frame.toolName === 'ask')
const resultData = (result) => {
  assert.equal(result.isError, false)
  const text = result.result.content.find((content) => content.type === 'text').text
  return JSON.parse(text.slice(text.indexOf('{')))
}
try {
  await connection.request('get_state')
  await connection.send({ type: 'prompt', id: 'replay', message: 'REPLAY_HTML_ASK' })
  const radio = await nextDialog()
  assert.equal(radio.method, 'select')
  assert.equal(radio.selectionMarker, 'radio')
  assert.equal(radio.initialIndex, 0)
  assert.deepEqual(radio.options.slice(0, 2), ['Concise', 'Detailed'])
  await pick(radio, 'Concise')
  const checked = await nextDialog()
  assert.equal(checked.selectionMarker, 'checkbox')
  assert.deepEqual(checked.checkedIndices, [0])
  await pick(checked, 'Background tasks')
  const added = await nextDialog()
  assert.deepEqual(added.checkedIndices, [0, 1])
  await pick(added, 'Subagents')
  const expanded = await nextDialog()
  assert.deepEqual(expanded.checkedIndices, [0, 1, 2])
  await pick(expanded, 'Forms')
  const removed = await nextDialog()
  assert.deepEqual(removed.checkedIndices, [1, 2])
  await finishChoices(removed)
  const numeric = await nextDialog()
  assert.equal(numeric.method, 'editor')
  assert.equal(numeric.prefill, '5')
  await answer(numeric, { indices: [], other: '99' })
  const retry = await nextDialog()
  assert.match(retry.title, /Must be at most 10/)
  assert.equal(retry.prefill, '99')
  await answer(retry, { indices: [], other: '7' })
  const notes = await nextDialog()
  await answer(notes, { indices: [], other: '  first\nsecond  ' })
  await wait(() => toolResults().length === 1)
  assert.deepEqual(resultData(toolResults()[0]), {
    marker: 'native-form',
    response_style: 'concise',
    features: ['background_tasks', 'subagents'],
    number: 7,
    message: '  first\nsecond  '
  })
  await wait(async () => (await connection.request('get_state')).isSettled)
  invoked = false
  await connection.send({ type: 'prompt', id: 'empty-replay', message: 'REPLAY_HTML_ASK' })
  await pick(await nextDialog(), 'Detailed')
  await pick(await nextDialog(), 'Forms')
  const empty = await nextDialog()
  assert.deepEqual(empty.checkedIndices, [])
  await finishChoices(empty)
  await answer(await nextDialog(), { indices: [], other: '5' })
  await answer(await nextDialog(), { indices: [], other: '' })
  await wait(() => toolResults().length === 2)
  assert.deepEqual(resultData(toolResults()[1]), {
    marker: 'native-form',
    response_style: 'detailed',
    features: [],
    number: 5,
    message: ''
  })
  await wait(async () => (await connection.request('get_state')).isSettled)
  invoked = false
  await connection.send({ type: 'prompt', id: 'cancel-replay', message: 'REPLAY_HTML_ASK' })
  const cancelled = await nextDialog()
  const presentation = piRpcDialogPresentation(cancelled)
  await connection.send({
    type: 'extension_ui_response',
    id: cancelled.id,
    ...presentation.reply(null)
  })
  await wait(() => toolResults().length === 3)
  assert.equal(toolResults()[2].isError, true)
  assert.match(toolResults()[2].result.content[0].text, /Ask tool was cancelled by the user/)
  await wait(async () => (await connection.request('get_state')).isSettled)
  const cards = [],
    failures = []
  hostDialogs = createOmpRpcDialogs(
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
  call.arguments.html =
    '<form><label><input type="checkbox" name="approve" value="approved">Approve isolated test action</label></form>'
  invoked = false
  await connection.send({ type: 'prompt', id: 'checkbox-card', message: 'REPLAY_HTML_ASK' })
  await wait(() => cards.length > 0)
  const card = cards[0]
  const questions = agentSessionPromptQuestions(card.body)
  assert.deepEqual(
    questions[0].options.map((option) => option.label),
    ['Approve isolated test action']
  )
  const answers = structuredQuestionAnswers(questions, [{ indices: [0], other: '' }])
  assert.equal(isValidAgentSessionQuestionAnswers(questions, answers), true)
  await hostDialogs.respond(card.id, { kind: 'answers', answers }, async () => {})
  await wait(() => toolResults().length === 4)
  assert.deepEqual(resultData(toolResults()[3]), { approve: 'approved' })
  assert.equal(cards.length, 1, 'One checkbox submission must not publish toggle or Done cards')
  assert.deepEqual(failures, [])
  call.arguments.html = `<form><fieldset><legend>Configuration (multiple choices)</legend>
    <p>Choose the configuration rules that apply.</p>
    <label><input type="checkbox" name="config" value="templates" checked>Templates only</label>
    <label><input type="checkbox" name="config" value="diff" checked>Promote via diff</label>
    <label><input type="checkbox" name="config" value="repo" checked>Home repo</label>
    </fieldset><label>Next question<input name="next"></label></form>`
  for (const [index, example] of [
    { indices: [0], other: 'Runtime workers', expected: ['templates', 'Runtime workers'] },
    { indices: [], other: 'Runtime workers', expected: ['Runtime workers'] }
  ].entries()) {
    await wait(async () => (await connection.request('get_state')).isSettled)
    cards.length = 0
    invoked = false
    await connection.send({
      type: 'prompt',
      id: `checkbox-other-${index}`,
      message: 'REPLAY_HTML_ASK'
    })
    await wait(() => cards.length > 0)
    const card = cards[0]
    const questions = agentSessionPromptQuestions(card.body)
    const answers = structuredQuestionAnswers(questions, [example])
    assert.equal(isValidAgentSessionQuestionAnswers(questions, answers), true)
    await hostDialogs.respond(card.id, { kind: 'answers', answers }, async () => {})
    await wait(() => cards.length > 1)
    const next = cards[1]
    assert.equal(
      next.body.question,
      'Next question',
      'Other input and Done must stay inside Adapter'
    )
    const nextAnswers = structuredQuestionAnswers(agentSessionPromptQuestions(next.body), [
      { indices: [], other: 'Next answer' }
    ])
    await hostDialogs.respond(next.id, { kind: 'answers', answers: nextAnswers }, async () => {})
    await wait(() => toolResults().length === 5 + index)
    assert.deepEqual(resultData(toolResults()[4 + index]), {
      config: example.expected,
      next: 'Next answer'
    })
    assert.equal(
      cards.length,
      2,
      'One checkbox card and one following text field must be published'
    )
    assert.deepEqual(failures, [])
  }
  const result = {
    binary: resolve(process.argv[2]),
    transport: 'real OMP RPC v2',
    model: 'isolated local SSE fixture',
    nativeFieldFlow: true,
    hostAnswerValidation: true,
    nativeCheckboxState: true,
    singleCheckboxSubmission: true,
    checkboxOtherWithSelections: true,
    checkboxOtherAlone: true,
    checkboxOtherAdvancesToNextField: true,
    nativeValidation: true,
    emptyChoices: true,
    emptyText: true,
    typedValues: true,
    hiddenValue: true,
    multilineWhitespace: true,
    cancelled: true
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  hostDialogs?.close()
  await connection.close()
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
