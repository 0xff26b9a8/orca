import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import type { Element, Root, RootContent } from 'hast'

export type OmpRpcFormOption = { value: string; label: string; checked: boolean; disabled: boolean }
export type OmpRpcFormField = {
  name: string
  question: string
  type: string
  required: boolean
  options?: OmpRpcFormOption[]
  multi: boolean
  other: boolean
  value: string
  placeholder: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

const skipped = new Set([
  'button',
  'head',
  'iframe',
  'link',
  'meta',
  'noscript',
  'script',
  'style',
  'template',
  'title'
])
const controls = new Set(['input', 'select', 'textarea'])
const blocks = new Set([
  'p',
  'div',
  'section',
  'article',
  'fieldset',
  'legend',
  'h1',
  'h2',
  'h3',
  'h4',
  'li',
  'tr',
  'pre',
  'br'
])

function text(node: RootContent | Root, omitControls = false): string {
  if (node.type === 'text') {
    return node.value
  }
  if (node.type === 'element') {
    if (skipped.has(node.tagName) || (omitControls && controls.has(node.tagName))) {
      return ''
    }
    if (node.tagName === 'img') {
      return String(node.properties.alt ?? '')
    }
  }
  if (!('children' in node)) {
    return ''
  }
  const content = node.children.map((child) => text(child, omitControls)).join('')
  return node.type === 'element' && blocks.has(node.tagName) ? `\n${content}\n` : content
}

function compact(value: string): string {
  return value
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function elements(root: Root | Element): Element[] {
  return root.children.flatMap((child) =>
    child.type === 'element' && !skipped.has(child.tagName) ? [child, ...elements(child)] : []
  )
}

function attr(node: Element, name: string): string {
  return String(node.properties[name] ?? '')
}

function numberAttr(node: Element, name: string): number | undefined {
  const raw = attr(node, name)
  const value = Number(raw)
  return raw.trim() && Number.isFinite(value) ? value : undefined
}

export function ompRpcFormFields(html: string): {
  fields: OmpRpcFormField[]
  hidden: Record<string, string>
  context: string
} {
  const document = fromHtmlIsomorphic(html, { fragment: true })
  const root = elements(document).find((node) => node.tagName === 'form') ?? document
  const all = elements(root)
  const labels = new Map(
    all
      .filter((node) => node.tagName === 'label' && attr(node, 'htmlFor'))
      .map((node) => [attr(node, 'htmlFor'), compact(text(node, true))])
  )
  const fields: OmpRpcFormField[] = []
  const groups = new Map<string, OmpRpcFormField>()
  const hidden: Record<string, string> = Object.create(null)
  let pending: string[] = []
  const visit = (node: Root | RootContent, wrapping = ''): void => {
    if (node.type === 'text') {
      pending.push(node.value)
      return
    }
    if (node.type !== 'element' && node.type !== 'root') {
      return
    }
    if (node.type === 'element') {
      if (skipped.has(node.tagName)) {
        return
      }
      if (node.tagName === 'label') {
        if (attr(node, 'htmlFor')) {
          return
        }
        const inputs = elements(node).filter((child) => controls.has(child.tagName))
        if (inputs.length) {
          const label = compact(text(node, true))
          for (const input of inputs) {
            visit(input, label)
          }
          return
        }
      }
      if (controls.has(node.tagName)) {
        const name = attr(node, 'name')
        const type =
          node.tagName === 'input' ? (attr(node, 'type') || 'text').toLowerCase() : node.tagName
        if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) {
          return
        }
        if (type === 'hidden') {
          if (name) {
            hidden[name] = attr(node, 'value')
          }
          return
        }
        if (!name) {
          return
        }
        if (type === 'password') {
          throw new Error('Secret OMP forms cannot be displayed')
        }
        const label =
          wrapping || labels.get(attr(node, 'id')) || attr(node, 'ariaLabel') || attr(node, 'title')
        const caption = compact(pending.join(''))
        pending = []
        const title = label || name.replace(/[_-]+/g, ' ')
        const field: OmpRpcFormField = {
          name,
          type,
          question: caption && caption !== title ? `${caption}\n\n${title}` : title,
          required: node.properties.required === true,
          multi: type === 'checkbox' || node.properties.multiple === true,
          other: false,
          value: type === 'textarea' ? text(node).replace(/^\r?\n/, '') : attr(node, 'value'),
          placeholder: attr(node, 'placeholder'),
          min: numberAttr(node, 'min'),
          max: numberAttr(node, 'max'),
          minLength: numberAttr(node, 'minLength'),
          maxLength: numberAttr(node, 'maxLength'),
          ...(attr(node, 'pattern') ? { pattern: attr(node, 'pattern') } : {})
        }
        if (type === 'radio' || type === 'checkbox') {
          const option = {
            value: node.properties.value === undefined ? 'on' : attr(node, 'value'),
            label: label || attr(node, 'value') || name,
            checked: node.properties.checked === true,
            disabled: node.properties.disabled === true
          }
          const key = `${type}\0${name}`
          const group = groups.get(key)
          if (group) {
            group.options!.push(option)
            group.required ||= field.required
            if (caption) {
              group.question += `\n\n${caption}`
            }
            return
          }
          field.question = caption || option.label
          field.options = [option]
          groups.set(key, field)
        } else if (type === 'select') {
          field.options = elements(node)
            .filter((child) => child.tagName === 'option')
            .map((option) => ({
              value:
                option.properties.value === undefined
                  ? compact(text(option))
                  : attr(option, 'value'),
              label: compact(text(option)),
              checked: option.properties.selected === true,
              disabled: option.properties.disabled === true
            }))
        }
        fields.push(field)
        return
      }
      if (blocks.has(node.tagName)) {
        pending.push('\n')
      }
      if (node.tagName === 'img') {
        pending.push(attr(node, 'alt'))
      }
    }
    for (const child of node.children) {
      visit(child, wrapping)
    }
    if (node.type === 'element' && blocks.has(node.tagName)) {
      pending.push('\n')
    }
  }
  visit(root)
  const tail = compact(pending.join(''))
  const last = fields.at(-1)
  if (tail && last) {
    last.question += `\n\n${tail}`
  }
  for (const field of fields) {
    if (!field.options) {
      continue
    }
    field.other =
      ['radio', 'checkbox'].includes(field.type) &&
      field.options.length > 1 &&
      !field.options.some((option) => /^\s*other\b/i.test(option.label))
  }
  if (fields.length > 64) {
    throw new Error('OMP form exceeds the question limit')
  }
  if (new Set(fields.map((field) => field.name)).size !== fields.length) {
    throw new Error('OMP form has conflicting field names')
  }
  return { fields, hidden, context: fields.length ? '' : tail }
}
