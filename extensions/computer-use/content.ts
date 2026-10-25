/** Screen strings are data, never instructions. */
export function untrusted(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `<untrusted_screen_content>\n${text.replace(/<\/untrusted_screen_content>/gi, '&lt;/untrusted_screen_content&gt;')}\n</untrusted_screen_content>`
}

/** Remove both verbatim parameters and the normalised form used in candidate IDs. */
export function redactor(values: string[]) {
  const forms = values
    .filter(Boolean)
    .flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    ])
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length)
  return (text: string) =>
    forms.reduce(
      (result, value) =>
        result.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[param]'),
      text,
    )
}
