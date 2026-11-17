import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcDialogCallbacks } from '../pi/rpc/rpc-dialog-callbacks'
import {
  piRpcDialogPresentation,
  type PiRpcDialogPresentation
} from '../pi/rpc/rpc-extension-dialogs'

const OTHER = 'Other (type your own)'
const checkboxSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal('select'),
  title: z.string(),
  message: z.string().optional(),
  options: z.array(z.string()).min(1).max(64),
  selectionMarker: z.literal('checkbox'),
  checkedIndices: z.array(z.number().int().nonnegative()).max(64),
  markableCount: z.number().int().positive().max(64)
})

function checkboxDialog(value: unknown) {
  if (z.object({ timeout: z.number() }).safeParse(value).success) {
    return null
  }
  const parsed = checkboxSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const dialog = parsed.data
  const done = dialog.options.findIndex((label) => /^(?:\S+ )?Done selecting$/.test(label))
  if (
    done < dialog.markableCount ||
    new Set(dialog.options).size !== dialog.options.length ||
    new Set(dialog.checkedIndices).size !== dialog.checkedIndices.length ||
    dialog.checkedIndices.some((index) => index >= dialog.markableCount) ||
    dialog.options
      .slice(dialog.markableCount)
      .some((label, index) => index + dialog.markableCount !== done && label !== OTHER)
  ) {
    return null
  }
  const choices = dialog.options.filter(
    (label, index) => index < dialog.markableCount && label !== OTHER
  )
  const title = dialog.title.replace(/^\(\d+ selected\) /, '')
  return {
    ...dialog,
    done: dialog.options[done]!,
    choices,
    checked: dialog.checkedIndices
      .map((index) => dialog.options[index]!)
      .filter((label) => label !== OTHER),
    key: JSON.stringify([title, dialog.message, choices, dialog.options.includes(OTHER)])
  }
}

export function ompRpcCheckboxDialogPresentation(value: unknown): PiRpcDialogPresentation | null {
  const dialog = checkboxDialog(value)
  const presentation = dialog && piRpcDialogPresentation(value)
  if (!dialog || !presentation || presentation.body.kind !== 'question') {
    return null
  }
  const options = presentation.body.options.filter((option) => option.label !== dialog.done)
  return {
    ...presentation,
    body: {
      ...presentation.body,
      options: [],
      questions: [
        {
          id: 'q1',
          question: [dialog.title.replace(/^\(\d+ selected\) /, ''), dialog.message]
            .filter((text) => text !== undefined)
            .join('\n\n'),
          multiSelect: true,
          options: options.map((option) =>
            dialog.checked.includes(option.label)
              ? {
                  ...option,
                  description: ['Previously selected in OMP; select to keep.', option.description]
                    .filter(Boolean)
                    .join('\n')
                }
              : option
          )
        }
      ]
    },
    reply: (response) => {
      if (response === null) {
        return { cancelled: true }
      }
      if (response.kind !== 'answers' || response.answers.length !== 1) {
        throw new Error('OMP checkbox requires one answer')
      }
      const answer = response.answers[0]!
      if (
        answer.questionId !== 'q1' ||
        answer.other !== undefined ||
        answer.optionIds.length === 0 ||
        new Set(answer.optionIds).size !== answer.optionIds.length
      ) {
        throw new Error('OMP checkbox requires offered selections')
      }
      return {
        ompCheckboxValues: answer.optionIds.map((id) => {
          const option = options.find((option) => option.id === id)
          if (!option) {
            throw new Error('OMP checkbox selected an unavailable option')
          }
          return option.label
        })
      }
    }
  }
}

type Checkbox = NonNullable<ReturnType<typeof checkboxDialog>>
type Selection = {
  id: string
  current: Checkbox
  callbacks: PiRpcDialogCallbacks
  desired?: string[]
  expected?: string[]
  completion?: ReturnType<typeof Promise.withResolvers<void>>
  timer?: ReturnType<typeof setTimeout>
}

/** OMP's select replies toggle one checkbox; only Done commits the selection. */
export class OmpRpcCheckboxDialogs {
  private readonly selections = new Map<string, Selection>()

  constructor(private readonly send: (frame: JsonlRpcRecord) => Promise<void>) {}

  receive(frame: JsonlRpcRecord, callbacks: PiRpcDialogCallbacks): boolean {
    const current = checkboxDialog(frame)
    if (!current) {
      return false
    }
    const selection = [...this.selections.values()].find(
      (selection) => selection.expected && selection.current.key === current.key
    )
    if (!selection) {
      if (this.selections.has(String(current.id)) || this.selections.size >= 64) {
        throw new Error('OMP checkbox identity or capacity violation')
      }
      this.selections.set(String(current.id), { id: String(current.id), current, callbacks })
      return false
    }
    if (current.id === selection.current.id) {
      return true
    }
    clearTimeout(selection.timer)
    selection.current = current
    if (
      selection.expected!.length !== current.checked.length ||
      selection.expected!.some((label) => !current.checked.includes(label))
    ) {
      this.remove(selection, new Error('OMP checkbox state changed unexpectedly'), true)
      void this.send({ type: 'extension_ui_response', id: current.id, cancelled: true }).catch(
        () => {}
      )
      return true
    }
    selection.expected = undefined
    void this.advance(selection).catch((error: unknown) => this.reject(selection, error))
    return true
  }

  reply = (frame: JsonlRpcRecord): Promise<void> => {
    const selection = this.selections.get(String(frame.id))
    if (!selection) {
      if ('ompCheckboxValues' in frame) {
        return Promise.reject(new Error('OMP checkbox is no longer available'))
      }
      return this.send(frame)
    }
    if (frame.cancelled === true) {
      this.remove(selection, new Error('OMP checkbox was cancelled'))
      return this.send({ ...frame, id: selection.current.id })
    }
    const desired = z.array(z.string()).parse(frame.ompCheckboxValues)
    selection.desired = desired
    const completion = Promise.withResolvers<void>()
    selection.completion = completion
    void this.advance(selection).catch((error: unknown) => this.reject(selection, error))
    return completion.promise
  }

  withdraw(id: string, callbacks: PiRpcDialogCallbacks): boolean {
    const selection = [...this.selections.values()].find(
      (selection) => selection.id === id || String(selection.current.id) === id
    )
    if (!selection) {
      return false
    }
    callbacks.withdraw(selection.id)
    this.remove(selection, new Error('OMP checkbox was withdrawn'))
    return true
  }

  clear(): void {
    for (const selection of this.selections.values()) {
      if (selection.completion) {
        void this.send({
          type: 'extension_ui_response',
          id: selection.current.id,
          cancelled: true
        }).catch(() => {})
      }
      this.remove(selection, new Error('OMP checkbox session ended'))
    }
  }

  forgetRow(itemId: string, matches: (itemId: string, requestId: string) => boolean): void {
    for (const selection of this.selections.values()) {
      if (matches(itemId, selection.id)) {
        this.remove(selection, new Error('OMP checkbox was dismissed'))
      }
    }
  }

  private async advance(selection: Selection): Promise<void> {
    const { current, desired = [] } = selection
    const toggle = current.choices.find(
      (label) => current.checked.includes(label) !== desired.includes(label)
    )
    if (toggle !== undefined) {
      selection.expected = current.checked.includes(toggle)
        ? current.checked.filter((label) => label !== toggle)
        : [...current.checked, toggle]
      selection.timer = setTimeout(() => {
        this.remove(selection, new Error('OMP did not acknowledge the checkbox selection'), true)
        void this.send({
          type: 'extension_ui_response',
          id: selection.current.id,
          cancelled: true
        }).catch(() => {})
      }, 60_000)
      selection.timer.unref()
    }
    await this.send({
      type: 'extension_ui_response',
      id: current.id,
      value: toggle ?? (desired.includes(OTHER) ? OTHER : current.done)
    })
    if (toggle === undefined && this.selections.get(selection.id) === selection) {
      this.selections.delete(selection.id)
      selection.completion?.resolve()
    }
  }

  private reject(selection: Selection, error: unknown): void {
    clearTimeout(selection.timer)
    selection.expected = undefined
    selection.desired = undefined
    selection.completion?.reject(error)
    selection.completion = undefined
  }

  private remove(selection: Selection, error: Error, withdraw = false): void {
    this.selections.delete(selection.id)
    clearTimeout(selection.timer)
    if (withdraw) {
      selection.callbacks.withdraw(selection.id)
    }
    selection.completion?.reject(error)
  }
}
