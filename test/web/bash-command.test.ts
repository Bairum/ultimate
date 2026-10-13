import { expect, it } from 'vitest'
import { formatBashCommand } from '../../extensions/coding-tools/bash-command.tsx'

it('formats the reported rg pipelines and semicolon list', () => {
  const first = 'rg -n "no_model" node_modules/@earendil-works/pi-durable/dist -l | head'
  const second = String.raw`rg -n -B8 "reason: \"no_model\"" node_modules/@earendil-works/pi-durable/dist/harness/compaction.js | head -30`
  expect(formatBashCommand(`cd /home/haza/Projects/ultimate && ${first}; ${second}`)).toEqual({
    directory: '/home/haza/Projects/ultimate',
    commands: [first, second],
    operators: [';'],
  })
})

it('extracts a literal leading directory and ordered commands', () => {
  expect(formatBashCommand('cd /long/worktree/path && git status && git diff')).toEqual({
    directory: '/long/worktree/path',
    commands: ['git status', 'git diff'],
    operators: ['&&'],
  })
  for (const prefix of ["cd '/path with spaces'", 'cd "/path with spaces"']) {
    expect(formatBashCommand(`${prefix} && git status`)).toEqual({
      directory: '/path with spaces',
      commands: ['git status'],
      operators: [],
    })
  }
})

it('retains pipelines and redirections within rows and preserves each list operator', () => {
  expect(
    formatBashCommand('rg foo 2>/dev/null | head; rg bar 2>&1 | head && cat < input >> output'),
  ).toEqual({
    commands: ['rg foo 2>/dev/null | head', 'rg bar 2>&1 | head', 'cat < input >> output'],
    operators: [';', '&&'],
  })
  expect(formatBashCommand('cd /workspace && rg foo 2>&1 | head')).toEqual({
    directory: '/workspace',
    commands: ['rg foo 2>&1 | head'],
    operators: [],
  })
})

it('keeps quoted and escaped operators within their commands', () => {
  expect(formatBashCommand(`echo 'a && b; c' && echo "c && d; e"; echo a\\&\\&b\\;c\\|d`)).toEqual({
    commands: ["echo 'a && b; c'", 'echo "c && d; e"', 'echo a\\&\\&b\\;c\\|d'],
    operators: ['&&', ';'],
  })
  expect(formatBashCommand(`echo '$(literal) # text' && pwd`)).toEqual({
    commands: ["echo '$(literal) # text'", 'pwd'],
    operators: ['&&'],
  })
})

it('preserves escaped whitespace instead of trimming it at chain boundaries', () => {
  for (const whitespace of [' ', '\t']) {
    for (const command of [
      `echo foo\\${whitespace} && pwd`,
      `pwd && echo foo\\${whitespace}`,
      `echo foo\\${whitespace}; pwd`,
      `pwd; echo foo\\${whitespace}`,
      `cd a\\${whitespace}b && pwd`,
    ])
      expect(formatBashCommand(command)).toEqual({ commands: [command], operators: [] })
    const tail = `echo foo\\${whitespace} && pwd`
    expect(formatBashCommand(`cd /workspace && ${tail}`)).toEqual({
      directory: '/workspace',
      commands: [tail],
      operators: [],
    })
  }
})

it('leaves complex tails intact independently of literal leading cd extraction', () => {
  for (const tail of [
    'echo $(pwd); pwd',
    'echo "$HOME" && pwd',
    'echo `pwd`; pwd',
    'cat <<EOF\ntext\nEOF',
    'pwd # comment; echo done',
    'pwd\ngit diff',
    '(pwd); ls',
    '{ pwd; }; ls',
    'if true && pwd; then ls; fi',
    'for i in a b; do pwd; done',
    '! false && pwd',
    'time pwd && ls',
    '[[ -f a && -f b ]]; pwd',
    'echo x | while read x; do echo "$x"; done',
    'pwd || ls; echo done',
    'pwd & ls',
    'pwd &&',
    "echo 'unfinished",
    'echo trailing\\',
  ]) {
    expect(formatBashCommand(tail)).toEqual({ commands: [tail], operators: [] })
    expect(formatBashCommand(`cd /path && ${tail}`)).toEqual({
      directory: '/path',
      commands: [tail],
      operators: [],
    })
  }
})

it('does not hide nonliteral cd arguments or options', () => {
  for (const prefix of [
    'cd -',
    'cd ~',
    'cd -- /path',
    'cd /path/*',
    'cd /path/?',
    'cd "$HOME"',
    'cd /path; pwd',
  ]) {
    const command = `${prefix} && echo $(pwd)`
    expect(formatBashCommand(command)).toEqual({ commands: [command], operators: [] })
  }
  expect(formatBashCommand('git status')).toEqual({ commands: ['git status'], operators: [] })
})
