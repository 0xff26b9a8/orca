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
    contents: `export {openOmpRpcConnection} from './src/main/omp/rpc-connection'; export {ensureOmpRpcFormBridge} from './src/main/omp/rpc-form-bridge';`
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile
})
const { openOmpRpcConnection, ensureOmpRpcFormBridge } = createRequire(import.meta.url)(outfile)
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
const bridge = await ensureOmpRpcFormBridge(join(root, 'bridge'))
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
      '--extension',
      bridge
    ],
    cwd,
    env
  },
  { onRecord: (frame) => frames.push(frame) }
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
try {
  await connection.request('get_state')
  await connection.send({ type: 'prompt', id: 'replay', message: 'REPLAY_HTML_ASK' })
  const groupFrames = () =>
    frames.filter((f) => f.type === 'extension_ui_request' && f.method === 'ask')
  await wait(() => groupFrames().length === 1)
  const group = groupFrames()[0]
  assert.equal(group.questions.length, 4)
  assert.equal(
    frames.some((f) => f.type === 'extension_ui_request' && f.method === 'select'),
    false
  )
  assert.deepEqual(
    group.questions.map((q) => q.id),
    ['field-0', 'field-1', 'field-2', 'field-3']
  )
  assert.equal(group.questions[2].textInput.initialValue, '5')
  assert.equal(group.questions[3].textInput.multiline, true)
  const answer = async (id, number) =>
    connection.send({
      type: 'extension_ui_response',
      id,
      answers: [
        { id: 'field-0', selectedOptions: ['Detailed'] },
        { id: 'field-1', selectedOptions: ['Forms', 'Subagents'] },
        { id: 'field-2', selectedOptions: [], customInput: JSON.stringify(number) },
        { id: 'field-3', selectedOptions: [], customInput: JSON.stringify('  first\nsecond  ') }
      ]
    })
  await answer(group.id, '99')
  await wait(() => groupFrames().length === 2)
  const retry = groupFrames()[1]
  assert.match(retry.questions[2].question, /Must be at most 10/)
  assert.equal(retry.questions[2].textInput.initialValue, '99')
  await answer(retry.id, '7')
  const toolResults = () =>
    frames.filter((f) => f.type === 'tool_execution_end' && f.toolName === 'ask')
  await wait(() => toolResults().length === 1)
  assert.equal(toolResults()[0].isError, false)
  const text = toolResults()[0].result.content.find((c) => c.type === 'text').text
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), {
    marker: 'native-form',
    response_style: 'detailed',
    features: ['forms', 'subagents'],
    number: 7,
    message: '  first\nsecond  '
  })
  await wait(async () => (await connection.request('get_state')).isSettled)
  invoked = false
  await connection.send({ type: 'prompt', id: 'cancel-replay', message: 'REPLAY_HTML_ASK' })
  await wait(() => groupFrames().length === 3)
  await connection.send({ type: 'extension_ui_response', id: groupFrames()[2].id, cancelled: true })
  await wait(() => toolResults().length === 2)
  assert.equal(toolResults()[1].isError, true)
  assert.match(toolResults()[1].result.content[0].text, /Ask tool was cancelled by the user/)
  const result = {
    binary: resolve(process.argv[2]),
    transport: 'real OMP RPC v2',
    model: 'isolated local SSE fixture',
    groupedForm: true,
    nativeValidation: true,
    retryKeepsInput: true,
    typedValues: true,
    hiddenValue: true,
    multilineWhitespace: true,
    cancelled: true
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await connection.close()
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
