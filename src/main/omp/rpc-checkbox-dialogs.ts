import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcDialogCallbacks } from '../pi/rpc/rpc-dialog-callbacks'
import {
  OMP_CHECKBOX_OTHER,
  ompRpcCheckboxDialog,
  ompRpcCheckboxTitle
} from './rpc-checkbox-presentation'
export { ompRpcCheckboxDialogPresentation } from './rpc-checkbox-presentation'

const inputSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.enum(['input', 'editor']),
  title: z.string()
})

type Checkbox = NonNullable<ReturnType<typeof ompRpcCheckboxDialog>>
type Selection = {
  id: string
  requestId: string | number
  current: Checkbox
  callbacks: PiRpcDialogCallbacks
  desired?: string[]
  other?: string
  inputId?: string | number
  awaitingInput?: boolean
  otherSubmitted?: boolean
  expected?: string[]
  completion?: ReturnType<typeof Promise.withResolvers<void>>
  timer?: ReturnType<typeof setTimeout>
}

/** OMP's select replies toggle one checkbox; only Done commits the selection. */
export class OmpRpcCheckboxDialogs {
  private readonly selections = new Map<string, Selection>()

  constructor(private readonly send: (frame: JsonlRpcRecord) => Promise<void>) {}

  receive(frame: JsonlRpcRecord, callbacks: PiRpcDialogCallbacks): boolean {
    const input = inputSchema.safeParse(frame)
    if (input.success) {
      const selection = [...this.selections.values()].find(
        (selection) =>
          selection.awaitingInput &&
          selection.current.title === ompRpcCheckboxTitle(input.data.title)
      )
      if (!selection) {
        return [...this.selections.values()].some(
          (selection) => selection.inputId === input.data.id
        )
      }
      clearTimeout(selection.timer)
      selection.awaitingInput = false
      selection.requestId = selection.inputId = input.data.id
      void this.advance(selection).catch((error: unknown) => this.reject(selection, error))
      return true
    }
    const current = ompRpcCheckboxDialog(frame)
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
      this.selections.set(String(current.id), {
        id: String(current.id),
        requestId: current.id,
        current,
        callbacks
      })
      return false
    }
    if (current.id === selection.current.id) {
      return true
    }
    clearTimeout(selection.timer)
    selection.current = current
    selection.requestId = current.id
    selection.inputId = undefined
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
      return this.send({ ...frame, id: selection.requestId })
    }
    const desired = z.array(z.string()).parse(frame.ompCheckboxValues)
    selection.desired = desired
    selection.other = z.string().min(1).optional().parse(frame.ompCheckboxOther)
    const completion = Promise.withResolvers<void>()
    selection.completion = completion
    void this.advance(selection).catch((error: unknown) => this.reject(selection, error))
    return completion.promise
  }

  withdraw(id: string, callbacks: PiRpcDialogCallbacks): boolean {
    const selection = [...this.selections.values()].find(
      (selection) => selection.id === id || String(selection.requestId) === id
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
          id: selection.requestId,
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
    if (selection.inputId !== undefined) {
      selection.otherSubmitted = true
      if (current.otherMarkable) {
        selection.expected = [
          ...current.checked.filter((label) => label !== OMP_CHECKBOX_OTHER),
          OMP_CHECKBOX_OTHER
        ]
        this.waitFor(selection)
      }
      await this.send({
        type: 'extension_ui_response',
        id: selection.inputId,
        value: selection.other
      })
      if (!current.otherMarkable) {
        this.finish(selection)
      }
      return
    }
    const toggle = current.choices.find(
      (label) => current.checked.includes(label) !== desired.includes(label)
    )
    const requestOther =
      toggle === undefined && selection.other !== undefined && !selection.otherSubmitted
    if (toggle !== undefined) {
      selection.expected = current.checked.includes(toggle)
        ? current.checked.filter((label) => label !== toggle)
        : [...current.checked, toggle]
      this.waitFor(selection)
    } else if (requestOther) {
      selection.awaitingInput = true
      this.waitFor(selection)
    }
    await this.send({
      type: 'extension_ui_response',
      id: current.id,
      value: toggle ?? (requestOther ? OMP_CHECKBOX_OTHER : current.done)
    })
    if (toggle === undefined && !requestOther) {
      this.finish(selection)
    }
  }

  private finish(selection: Selection): void {
    if (this.selections.get(selection.id) === selection) {
      this.selections.delete(selection.id)
      clearTimeout(selection.timer)
      selection.completion?.resolve()
    }
  }

  private waitFor(selection: Selection): void {
    clearTimeout(selection.timer)
    selection.timer = setTimeout(() => {
      this.remove(selection, new Error('OMP did not acknowledge the checkbox selection'), true)
      void this.send({
        type: 'extension_ui_response',
        id: selection.requestId,
        cancelled: true
      }).catch(() => {})
    }, 60_000)
    selection.timer.unref()
  }

  private reject(selection: Selection, error: unknown): void {
    clearTimeout(selection.timer)
    selection.expected = undefined
    selection.desired = undefined
    selection.awaitingInput = false
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
