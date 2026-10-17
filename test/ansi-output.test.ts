import { describe, expect, it } from 'vitest'
import { OutputBuffer, sanitizeOutput } from '@earendil-works/chord/output'

describe('chord ANSI output sanitizer', () => {
  it('preserves numeric SGR, tabs, newlines and ordinary brackets', () => {
    const output = '\x1b[1m\x1b[94mHeading\x1b[22;39m\n\t[brackets] \x1b[mreset'
    expect(sanitizeOutput(output)).toBe(output)
    const extended = '\x1b[38;5;196mred\x1b[48;2;1;2;3mbackground\x1b[0m'
    expect(sanitizeOutput(extended)).toBe(extended)
    const mixed = '\x1b[1;31mred\x1b[2K\x1b]0;title\x07\x1b[0mplain'
    const clean = '\x1b[1;31mred\x1b[0mplain'
    expect(sanitizeOutput(mixed)).toBe(clean)
    expect(sanitizeOutput(clean)).toBe(clean)
  })

  it.each([
    ['cursor / erase', '\x1b[2K\x1b[1G\x1b[?25ltext\x1b[?25h'],
    ['OSC title (BEL)', '\x1b]0;secret title\x07text'],
    ['OSC clipboard (ST)', '\x1b]52;c;secret\x1b\\text'],
    ['OSC hyperlink', '\x1b]8;;https://example.com\x07text\x1b]8;;\x07'],
    [
      'DCS, SOS, PM, APC',
      '\x1bPsecret\x1b\\\x1bXsecret\x1b\\\x1b^secret\x1b\\\x1b_secret\x1b\\text',
    ],
    ['C1 CSI / OSC / DCS', '\x9b31m\x9d0;secret\x9c\x90secret\x9ctext'],
    ['charset / cursor save', '\x1b(B\x1b7text\x1b8'],
    ['individual controls', '\x00\x07\x08\r\x7f\x85\ufff9text'],
    ['unfinished sequences', 'text\x1b[31;'],
    ['unfinished OSC', 'text\x1b]0;secret'],
    ['unfinished DCS', 'text\x1bPsecret'],
  ])('removes %s without leaking control payload', (_name, output) => {
    expect(sanitizeOutput(output)).toBe('text')
  })

  it('keeps bounded output and accepts an SGR split across stream chunks', () => {
    const buffer = new OutputBuffer({ maxBytes: 100, maxLines: 2, retain: 'tail' })
    buffer.push('dropped\n\x1b[')
    expect(buffer.snapshot().text).toBe('dropped\n')
    buffer.push('1m\x1b[94mHeading\x1b[0m\nlast\n')
    buffer.end()
    expect(buffer.snapshot()).toEqual({
      text: '\x1b[1m\x1b[94mHeading\x1b[0m\nlast\n',
      droppedBytes: 8,
      droppedLines: 1,
    })
    expect(buffer.storedBytes).toBeLessThanOrEqual(100)
  })
})
