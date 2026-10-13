import { expect, it } from 'vitest'
import { formatBashCommand, pythonHeredoc } from '../../extensions/coding-tools/bash-command.tsx'

it('recognizes a complete leading Python heredoc while retaining its shell wrapper', () => {
  const body = 'from pathlib import Path\nif True:\n    print(Path("web"))\n'
  for (const opening of ["python3 - <<'EOF'", 'python <<EOF', 'python3 - <<"EOF"']) {
    const ending = 'EOF\nrg -n "Path" web | head; npx tsc --noEmit'
    const command = `${opening}\n${body}${ending}`
    expect(pythonHeredoc(command)).toEqual({ opening, body, ending })
    const display = formatBashCommand(`cd /workspace && ${command}`)
    expect(display.directory).toBe('/workspace')
    expect(pythonHeredoc(display.commands[0])).toEqual({ opening, body, ending })
  }
})

it('leaves incomplete and unsupported Python heredocs plain', () => {
  for (const command of [
    "python3 - <<'EOF'\nprint(1)",
    "python3 - <<'EOF'\nprint(1)\n EOF",
    "python3 - <<'EOF' <<'OTHER'\nprint(1)\nEOF\nOTHER",
    "python3 -u - <<'EOF'\nprint(1)\nEOF",
    "cat <<'EOF'\nprint(1)\nEOF",
  ])
    expect(pythonHeredoc(command)).toBeUndefined()
})

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

it('trims only shell blanks at row boundaries, preserving literal NBSP', () => {
  for (const operator of [';', '&&'] as const) {
    expect(formatBashCommand(`rg needle\u00a0${operator} pwd`)).toEqual({
      commands: ['rg needle\u00a0', 'pwd'],
      operators: [operator],
    })
    expect(formatBashCommand(`pwd${operator} rg needle\u00a0`)).toEqual({
      commands: ['pwd', 'rg needle\u00a0'],
      operators: [operator],
    })
    expect(formatBashCommand(`pwd${operator} \u00a0rg needle`)).toEqual({
      commands: ['pwd', '\u00a0rg needle'],
      operators: [operator],
    })
    expect(formatBashCommand(` \trg needle \t${operator} \tpwd \t`)).toEqual({
      commands: ['rg needle', 'pwd'],
      operators: [operator],
    })
  }
})

it('does not consume literal NBSP when recognizing a leading cd', () => {
  expect(formatBashCommand('\u00a0cd /workspace && pwd')).toEqual({
    commands: ['\u00a0cd /workspace', 'pwd'],
    operators: ['&&'],
  })
  expect(formatBashCommand(' \tcd /workspace\u00a0 && pwd')).toEqual({
    directory: '/workspace\u00a0',
    commands: ['pwd'],
    operators: [],
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
