import { runInNewContext } from 'node:vm'
import { z } from 'zod'
import type { AgentJournalQuestion } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQuestionAnswer } from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import type { PiRpcDialogPresentation } from '../pi/rpc/rpc-extension-dialogs'
import { ompRpcFormFields, type OmpRpcFormField } from './rpc-form-fields'

const formSchema = z.object({
  id: z.string(),
  method: z.literal('form'),
  html: z.string().max(128 * 1024)
})
const resolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const
type FormValue = string | number | string[]

function question(field: OmpRpcFormField, index: number, context: string): AgentJournalQuestion {
  const id = `field-${index}`
  const options = (field.options ?? []).flatMap((option, optionIndex) =>
    option.disabled
      ? []
      : [
          {
            id: `option-${optionIndex}`,
            label: option.label || option.value || 'Empty value',
            ...(option.checked
              ? { description: 'Previously selected in OMP; select to keep.' }
              : {})
          }
        ]
  )
  if (field.options && !field.required) {
    options.push({ id: 'none', label: 'None' })
  }
  if (options.length > 64) {
    throw new Error('OMP form exceeds the option limit')
  }
  return {
    id,
    question: [context, field.question].filter(Boolean).join('\n\n'),
    multiSelect: field.multi,
    options,
    ...(!field.options || field.other ? { freeTextQuestionId: id } : {}),
    ...(!field.options
      ? {
          freeTextInput: {
            allowEmpty: true,
            multiline: field.type === 'textarea',
            initialValue: field.value,
            placeholder: field.placeholder
          }
        }
      : {})
  }
}

function fieldValue(
  field: OmpRpcFormField,
  answer: AgentSessionQuestionAnswer
): FormValue | undefined {
  if (new Set(answer.optionIds).size !== answer.optionIds.length) {
    throw new Error('Duplicate OMP form selection')
  }
  if (field.options) {
    const none = answer.optionIds.includes('none')
    const other = answer.other?.trim()
    if (none) {
      if (field.required || answer.optionIds.length !== 1 || other) {
        throw new Error('Invalid empty OMP form answer')
      }
      return field.multi && field.options.length > 1 ? [] : undefined
    }
    if (other && !field.other) {
      throw new Error('OMP form does not offer Other')
    }
    if (
      other &&
      field.options.some((option) => option.value === other) &&
      !field.options.some((option) => option.value === other && !option.disabled)
    ) {
      throw new Error('OMP form selected a disabled value')
    }
    const values = answer.optionIds.map((id) => {
      const option = field.options!.find((_, index) => id === `option-${index}`)
      if (!option || option.disabled) {
        throw new Error('OMP form selected an unavailable option')
      }
      return option.value
    })
    if (other) {
      values.push(other)
    }
    if ((!field.multi && values.length > 1) || new Set(values).size !== values.length) {
      throw new Error('Invalid OMP form selections')
    }
    if (field.required && values.length === 0) {
      throw new Error('OMP form requires a selection')
    }
    return field.multi && field.options.length > 1 ? values : values[0]
  }
  if (answer.optionIds.length || answer.other === undefined) {
    throw new Error('OMP form requires text')
  }
  const text = answer.other
  if (!text.trim()) {
    if (field.required) {
      throw new Error('OMP form requires text')
    }
    return text
  }
  if (field.minLength !== undefined && text.length < field.minLength) {
    throw new Error('OMP form answer is too short')
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    throw new Error('OMP form answer is too long')
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) {
    throw new Error('OMP form requires an email address')
  }
  if (field.type === 'url' && !URL.canParse(text)) {
    throw new Error('OMP form requires a full URL')
  }
  if (field.pattern) {
    // Bound model-authored patterns without running form scripts or blocking the host indefinitely.
    const matches: unknown = runInNewContext(
      'let regex; try { regex = new RegExp(`^(?:${pattern})$`, "v") } catch {} ; regex ? regex.test(text) : true',
      { pattern: field.pattern, text },
      { timeout: 50 }
    )
    if (matches !== true) {
      throw new Error('OMP form answer does not match the required pattern')
    }
  }
  if (field.type === 'number' || field.type === 'range') {
    const value = Number(text)
    if (
      !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    ) {
      throw new Error('OMP form number is outside the allowed range')
    }
    return value
  }
  return text
}

export function ompRpcFormPresentation(
  value: unknown,
  start = 0,
  end = 64
): PiRpcDialogPresentation | null {
  const parsed = formSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  try {
    const { id, html } = parsed.data
    const form = ompRpcFormFields(html)
    if (form.fields.length === 0) {
      return {
        id,
        body: {
          kind: 'approval',
          title: form.context || 'OMP form',
          detail: null,
          options: [
            { id: 'submit', label: 'Submit', intent: 'allow_once' },
            { id: 'cancel', label: 'Cancel', intent: 'reject_once' }
          ],
          resolution
        },
        reply: (response) => {
          if (response === null || (response.kind === 'option' && response.optionId === 'cancel')) {
            return { cancelled: true }
          }
          if (response.kind !== 'option' || response.optionId !== 'submit') {
            throw new Error('Invalid OMP form submission')
          }
          return { data: form.hidden }
        }
      }
    }
    const fields = form.fields.slice(start, end)
    const questions = fields.map((field, index) =>
      question(field, start + index, start === 0 && index === 0 ? form.context : '')
    )
    return {
      id,
      body: {
        kind: 'question',
        question: questions[0]!.question,
        options: [],
        questions,
        resolution
      },
      reply: (response) => {
        if (response === null) {
          return { cancelled: true }
        }
        if (
          response.kind !== 'answers' ||
          response.answers.length !== fields.length ||
          new Set(response.answers.map((answer) => answer.questionId)).size !== fields.length
        ) {
          throw new Error('OMP form requires an answer to every field')
        }
        const data: Record<string, FormValue> = Object.assign(
          Object.create(null),
          start === 0 ? form.hidden : {}
        )
        fields.forEach((field, index) => {
          const answer = response.answers.find(
            (answer) => answer.questionId === `field-${start + index}`
          )
          if (!answer) {
            throw new Error('Invalid OMP form field identity')
          }
          const value = fieldValue(field, answer)
          if (value !== undefined) {
            data[field.name] = value
          }
        })
        return { data }
      }
    }
  } catch {
    return null
  }
}
