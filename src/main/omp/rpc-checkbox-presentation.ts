import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  piRpcDialogPresentation,
  type PiRpcDialogPresentation
} from '../pi/rpc/rpc-extension-dialogs'

export const OMP_CHECKBOX_OTHER = 'Other (type your own)'
const checkboxSchema = lazyZodSchema(() =>
  z.object({
    id: z.union([z.string(), z.number()]),
    method: z.literal('select'),
    title: z.string(),
    message: z.string().optional(),
    options: z.array(z.string()).min(1).max(64),
    selectionMarker: z.literal('checkbox'),
    checkedIndices: z.array(z.number().int().nonnegative()).max(64),
    markableCount: z.number().int().positive().max(64)
  })
)

export function ompRpcCheckboxTitle(title: string): string {
  return title.replace(/^\(\d+ selected\) /gm, '')
}

export function ompRpcCheckboxDialog(value: unknown) {
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
      .some((label, index) => index + dialog.markableCount !== done && label !== OMP_CHECKBOX_OTHER)
  ) {
    return null
  }
  const choices = dialog.options.filter(
    (label, index) => index < dialog.markableCount && label !== OMP_CHECKBOX_OTHER
  )
  const other = dialog.options.indexOf(OMP_CHECKBOX_OTHER)
  const title = ompRpcCheckboxTitle(dialog.title)
  return {
    ...dialog,
    title,
    done: dialog.options[done]!,
    choices,
    checked: dialog.checkedIndices.map((index) => dialog.options[index]!),
    otherAvailable: other !== -1,
    otherMarkable: other !== -1 && other < dialog.markableCount,
    key: JSON.stringify([title, dialog.message, choices, other !== -1])
  }
}

export function ompRpcCheckboxDialogPresentation(value: unknown): PiRpcDialogPresentation | null {
  const dialog = ompRpcCheckboxDialog(value)
  const presentation = dialog && piRpcDialogPresentation(value)
  if (!dialog || !presentation || presentation.body.kind !== 'question') {
    return null
  }
  const options = presentation.body.options.filter(
    (option) => option.label !== dialog.done && option.label !== OMP_CHECKBOX_OTHER
  )
  return {
    ...presentation,
    body: {
      ...presentation.body,
      options: [],
      questions: [
        {
          id: 'q1',
          question: [dialog.title, dialog.message]
            .filter((text) => text !== undefined)
            .join('\n\n'),
          multiSelect: true,
          ...(dialog.otherAvailable ? { freeTextQuestionId: 'q1' } : {}),
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
      const other = answer.other?.trim() || undefined
      if (
        answer.questionId !== 'q1' ||
        (other !== undefined && !dialog.otherAvailable) ||
        (answer.optionIds.length === 0 && other === undefined) ||
        new Set(answer.optionIds).size !== answer.optionIds.length
      ) {
        throw new Error('OMP checkbox requires offered selections or custom input')
      }
      return {
        ompCheckboxValues: answer.optionIds.map((id) => {
          const option = options.find((option) => option.id === id)
          if (!option) {
            throw new Error('OMP checkbox selected an unavailable option')
          }
          return option.label
        }),
        ...(other !== undefined ? { ompCheckboxOther: other } : {})
      }
    }
  }
}
