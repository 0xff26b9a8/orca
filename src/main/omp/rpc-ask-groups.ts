import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcDialogCallbacks } from '../pi/rpc/rpc-dialog-callbacks'
import type { PiRpcDialogPresentation } from '../pi/rpc/rpc-extension-dialogs'
import { MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS } from '../native-chat/agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import { ompRpcFormPresentation } from './rpc-form-presentation'

const answersSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      selectedOptions: z.array(z.string()),
      customInput: z.string().optional()
    })
  )
})

const formEntriesSchema = z.array(
  z.tuple([z.string(), z.union([z.string(), z.number(), z.array(z.string())])])
)

function formData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid OMP form data')
  }
  // Validate entries without dropping a legitimate field named __proto__.
  return Object.fromEntries(formEntriesSchema.parse(Object.entries(value)))
}

type AskGroup = {
  id: string
  pages: JsonlRpcRecord[]
  index: number
  answers: z.infer<typeof answersSchema>['answers']
  data: Record<string, unknown>
  presentations: Map<unknown, PiRpcDialogPresentation>
  next?: JsonlRpcRecord
}

/** Keep host-sized cards local; OMP receives one complete reply to its original request. */
export class OmpRpcAskGroups {
  private readonly groups = new Map<string, AskGroup>()
  private readonly pages = new Map<string, AskGroup>()

  constructor(
    private readonly present: (frame: unknown) => PiRpcDialogPresentation | null,
    private readonly send: (frame: JsonlRpcRecord) => Promise<void>
  ) {}

  presentation = (frame: unknown): PiRpcDialogPresentation | null => {
    for (const group of this.groups.values()) {
      const page = group.presentations.get(frame)
      if (page) {
        return page
      }
    }
    return this.present(frame)
  }

  receive(frame: JsonlRpcRecord, callbacks: PiRpcDialogCallbacks): boolean {
    for (const group of this.groups.values()) {
      if (group.presentations.has(frame)) {
        return false
      }
    }
    if ((frame.method !== 'ask' && frame.method !== 'form') || typeof frame.id !== 'string') {
      return false
    }
    const presentation = this.present(frame)
    const questions =
      presentation?.body.kind === 'question' ? presentation.body.questions : undefined
    if (!questions || questions.length <= MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS) {
      return false
    }
    if (this.groups.has(frame.id)) {
      throw new Error('OMP Ask identity violation')
    }
    const pages: JsonlRpcRecord[] = []
    const presentations = new Map<unknown, PiRpcDialogPresentation>()
    for (let start = 0; start < questions.length; start += MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS) {
      const page: JsonlRpcRecord = {
        ...frame,
        id: `orca-omp-ask:${randomUUID()}`,
        ...(frame.method === 'ask' && Array.isArray(frame.questions)
          ? {
              questions: frame.questions.slice(start, start + MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS)
            }
          : {})
      }
      if (frame.method === 'form') {
        const form = ompRpcFormPresentation(
          frame,
          start,
          start + MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS
        )
        if (!form) {
          throw new Error('Invalid OMP form page')
        }
        presentations.set(page, { ...form, id: String(page.id) })
      }
      pages.push(page)
    }
    const group: AskGroup = {
      id: frame.id,
      pages,
      index: 0,
      answers: [],
      data: Object.create(null),
      presentations
    }
    this.groups.set(group.id, group)
    this.pages.set(String(pages[0]!.id), group)
    try {
      callbacks.receive(pages[0]!)
    } catch (error) {
      this.forget(group)
      throw error
    }
    return true
  }

  reply = async (frame: JsonlRpcRecord): Promise<void> => {
    const group = this.pages.get(String(frame.id))
    if (!group) {
      return this.send(frame)
    }
    if (frame.cancelled === true) {
      await this.send({ ...frame, id: group.id })
      this.forget(group)
      return
    }
    const answers = group.presentations.size ? [] : answersSchema.parse(frame).answers
    const data = group.presentations.size ? formData(frame.data) : {}
    const next = group.pages[group.index + 1]
    if (next) {
      group.answers.push(...answers)
      Object.assign(group.data, data)
      group.next = next
      return
    }
    await this.send({
      ...frame,
      id: group.id,
      ...(group.presentations.size
        ? { data: Object.assign(Object.create(null), group.data, data) }
        : { answers: [...group.answers, ...answers] })
    })
    this.forget(group)
  }

  advance(callbacks: PiRpcDialogCallbacks): void {
    for (const group of this.groups.values()) {
      const next = group.next
      if (!next) {
        continue
      }
      this.pages.delete(String(group.pages[group.index]!.id))
      group.next = undefined
      group.index++
      this.pages.set(String(next.id), group)
      callbacks.receive(next)
    }
  }

  withdraw(id: string, callbacks: PiRpcDialogCallbacks): void {
    const group = this.groups.get(id)
    callbacks.withdraw(group ? String(group.pages[group.index]!.id) : id)
    if (group) {
      this.forget(group)
    }
  }

  clear(): void {
    this.groups.clear()
    this.pages.clear()
  }

  forgetRow(itemId: string, matches: (itemId: string, requestId: string) => boolean): void {
    for (const [id, group] of this.pages) {
      if (matches(itemId, id)) {
        this.forget(group)
        return
      }
    }
  }

  private forget(group: AskGroup): void {
    this.groups.delete(group.id)
    this.pages.delete(String(group.pages[group.index]!.id))
  }
}
