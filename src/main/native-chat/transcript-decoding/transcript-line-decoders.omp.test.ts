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
})
