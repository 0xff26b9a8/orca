// The child loads its own parser, so form semantics stay with the installed OMP version.
const OMP_TUI_PACKAGE = '@oh-my-pi/pi-tui'

export const OMP_RPC_FORM_BRIDGE_SOURCE = String.raw`
export default async function (pi) {
  let parse, data, render
  try {
    parse = await import('${OMP_TUI_PACKAGE}/html-form/parse')
    data = await import('${OMP_TUI_PACKAGE}/html-form/data')
    render = await import('${OMP_TUI_PACKAGE}/render/render-utils')
  } catch {
    return
  }
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI || ctx.ui.formDialog) return
    ctx.ui.formDialog = async function (html, dialogOptions) {
      if (!this.askDialog) throw new Error('Orca grouped form UI is not available')
      const form = parse.parseHtmlForm(html)
      const fields = form.fields.filter(field => field.name)
      const titles = data.fieldQuestions(form)
      if (fields.length === 0 || fields.length > 64) {
        throw new Error('Orca forms require between 1 and 64 named fields')
      }
      const values = data.defaultFormData(form)
      const errors = new Map()
      while (true) {
        dialogOptions?.signal?.throwIfAborted()
        const choices = fields.map(field => {
          if (field.kind !== 'choice') return []
          const enabled = field.options.flatMap((option, index) => option.disabled ? [] : [{option, index}])
          const labels = render.disambiguateDisplayLabels(enabled.map(({option}) =>
            parse.spansText(option.label).replace(/\s+/g, ' ').trim() || option.value), [])
          return enabled.map((entry, index) => ({...entry, label: labels[index]}))
        })
        const questions = fields.map((field, index) => {
          const question = titles.get(field) || field.name
          const error = errors.get(index)
          return {
            id: 'field-' + index,
            question: error ? question + ' (' + error + ')' : question,
            multi: field.kind === 'choice' && field.multi,
            options: choices[index].map(({label}) => ({label})),
            allowCustom: field.kind === 'text' || field.other,
            ...(field.kind === 'text' ? {
              textInput: {
                allowEmpty: true,
                multiline: field.multiline,
                initialValue: String(values[field.name] ?? ''),
                ...(field.placeholder ? {placeholder: field.placeholder} : {})
              },
              encodedText: true
            } : {textInput: {allowEmpty: !field.required}})
          }
        })
        const reply = await this.askDialog(questions, dialogOptions)
        if (!reply || reply.kind !== 'submit') return undefined
        errors.clear()
        if (reply.results.length !== fields.length) throw new Error('Incomplete Orca form response')
        fields.forEach((field, index) => {
          const answer = reply.results[index]
          if (answer.id !== 'field-' + index) throw new Error('Invalid Orca form field identity')
          let value
          if (field.kind === 'text') {
            const text = JSON.parse(answer.customInput ?? '""')
            if (typeof text !== 'string') throw new Error('Invalid Orca form text')
            value = data.textValue(field, text)
          } else {
            const checked = new Set(answer.selectedOptions.map(label => {
              const choice = choices[index].find(choice => choice.label === label)
              if (!choice) throw new Error('Invalid Orca form option')
              return choice.index
            }))
            value = data.choiceValue(field, checked, answer.customInput)
          }
          const error = data.fieldError(field, value)
          if (error) errors.set(index, error)
          if (value === undefined) delete values[field.name]
          else values[field.name] = value
        })
        if (errors.size === 0) return {data: values}
      }
    }
  })
}
`
