import { expect, it } from 'vitest'
import { extensionOptions, requiredExtensions } from '../../extensions/onboarding/choices.tsx'

it('keeps every extension needed by @ultimate checked and locked, even over saved or pending disables', () => {
  const changed = Object.fromEntries(requiredExtensions.map((name) => [name, false]))
  const options = extensionOptions([...requiredExtensions, 'parallel'], { ...changed, info: false })
  expect(options.filter((entry) => entry.required).map((entry) => entry.name)).toEqual([
    'subagents',
    'board',
    'lineage',
    'onboarding',
  ])
  for (const name of requiredExtensions) {
    expect(options.find((entry) => entry.name === name)).toMatchObject({
      checked: true,
      required: true,
      hint: 'needed by @ultimate',
    })
  }
  expect(options.find((entry) => entry.name === 'parallel')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(options.find((entry) => entry.name === 'info')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(
    extensionOptions(['parallel'], { parallel: true }).find((entry) => entry.name === 'parallel'),
  ).toMatchObject({ checked: true, required: false })
})
