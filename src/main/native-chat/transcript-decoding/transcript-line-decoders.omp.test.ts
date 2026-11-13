import { describe, expect, it } from 'vitest'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

const line = (record: unknown): string => JSON.stringify(record)

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'message',
    id: 'rec-1',
    parentId: 'rec-0',
    timestamp: '2026-07-16T00:27:02.222Z',
    message: { role, content, ...extra }
  })

describe('decodeOmpTranscriptLine', () => {
  it('preserves tool result image attachments on historical replay', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [
        { type: 'text', text: 'Screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ]),
      'f'
    )
    expect(decoded?.blocks).toEqual([
      { type: 'tool-result', output: 'Screenshot' },
      { type: 'image-ref', url: 'data:image/png;base64,aW1hZ2U=' }
    ])
  })
  it('skips malformed lines and non-conversation records', () => {
    expect(decodeOmpTranscriptLine('not json', 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'session_init', id: 'a' }), 'f')).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'mode_change', id: 'a' }), 'f')).toBeNull()
    expect(
      decodeOmpTranscriptLine(line({ type: 'custom', customType: 'tool_execution_start' }), 'f')
    ).toBeNull()
    expect(decodeOmpTranscriptLine(line({ type: 'a-type-from-the-future' }), 'f')).toBeNull()
  })

  it('decodes a user turn', () => {
    const decoded = decodeOmpTranscriptLine(
      message('user', [{ type: 'text', text: 'resume' }]),
      'f'
    )
    expect(decoded).toEqual({
      id: 'rec-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'resume' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
  })

  it('keeps thinking and tool calls together on a mixed assistant turn', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'thinking', thinking: 'Checking the goal' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'toolCall', id: 'call-1', name: 'goal', arguments: { op: 'get' } }
      ]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([
      { type: 'text', text: 'Checking the goal' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool-call', name: 'goal', input: { op: 'get' } }
    ])
  })

  it('projects an OMP todo call into the shared task-list tool shape', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        {
          type: 'toolCall',
          id: 'todo-1',
          name: 'todo',
          arguments: { op: 'init', items: ['Inspect the protocol'], list: [] }
        }
      ]),
      'f'
    )
    expect(decoded?.blocks).toEqual([
      {
        type: 'tool-call',
        name: 'update_plan',
        callId: 'todo-1',
        input: {
          explanation: 'OMP phases: Todo',
          plan: [{ step: 'Todo: Inspect the protocol', status: 'pending' }]
        }
      }
    ])
  })

  it('keeps a thinking-only assistant turn on the assistant role', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'thinking', thinking: 'Weighing two options' }]),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Weighing two options' }])
  })

  it('passes tool arguments through unchanged', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [
        { type: 'toolCall', name: 'goal', arguments: { op: 'get', objective: null } }
      ]),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'goal',
      input: { op: 'get', objective: null }
    })
  })

  it('decodes a tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'ok' }], {
        toolCallId: 'call-1',
        toolName: 'goal',
        isError: false
      }),
      'f'
    )
    expect(decoded?.role).toBe('tool')
    expect(decoded?.blocks).toEqual([{ type: 'tool-result', output: 'ok' }])
  })

  it('flags an errored tool result', () => {
    const decoded = decodeOmpTranscriptLine(
      message('toolResult', [{ type: 'text', text: 'boom' }], {
        toolCallId: 'call-2',
        isError: true
      }),
      'f'
    )
    expect(decoded?.blocks[0]).toEqual({ type: 'tool-result', output: 'boom', isError: true })
  })

  it('surfaces a displayed custom_message, and hides a state-only one', () => {
    const custom = (display: boolean): string =>
      line({
        type: 'custom_message',
        id: 'rec-c',
        customType: 'rewind-report',
        display,
        content: [{ type: 'text', text: 'Investigation summary' }],
        timestamp: '2026-07-16T00:27:02.222Z'
      })
    expect(decodeOmpTranscriptLine(custom(true), 'f')).toEqual({
      id: 'rec-c',
      role: 'system',
      blocks: [{ type: 'text', text: 'Investigation summary' }],
      timestamp: Date.parse('2026-07-16T00:27:02.222Z'),
      source: 'transcript'
    })
    expect(decodeOmpTranscriptLine(custom(false), 'f')).toBeNull()
  })

  it('marks a cancelled run, which carries no exitCode at all', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-c1',
        message: { role: 'bashExecution', command: 'sleep 99', output: 'partial', cancelled: true }
      }),
      'f'
    )
    expect(decoded?.blocks[1]).toEqual({ type: 'tool-result', output: 'partial', isError: true })
  })

  it('lists file mention paths without dumping their auto-read contents', () => {
    const decoded = decodeOmpTranscriptLine(
      line({
        type: 'message',
        id: 'rec-f',
        message: {
          role: 'fileMention',
          files: [
            { path: 'src/a.ts', content: 'SECRET FILE BODY' },
            { path: 'src/b.ts' },
            { image: true }
          ]
        }
      }),
      'f'
    )
    expect(decoded?.role).toBe('system')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: '@src/a.ts\n@src/b.ts' }])
    expect(JSON.stringify(decoded)).not.toContain('SECRET FILE BODY')
  })

  it('drops blob-handle images, which the renderer cannot load', () => {
    expect(
      decodeOmpTranscriptLine(
        message('user', [{ type: 'image', data: 'blob:sha256:abc', mimeType: 'image/webp' }]),
        'f'
      )
    ).toBeNull()
  })

  it('keeps partial content when a turn aborted mid-stream', () => {
    const decoded = decodeOmpTranscriptLine(
      message('assistant', [{ type: 'text', text: 'Partial answer' }], { stopReason: 'aborted' }),
      'f'
    )
    expect(decoded?.role).toBe('assistant')
    expect(decoded?.blocks).toEqual([{ type: 'text', text: 'Partial answer' }])
  })
})
