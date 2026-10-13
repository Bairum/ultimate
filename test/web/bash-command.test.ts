import { expect, it } from 'vitest'
import { formatBashCommand } from '../../extensions/coding-tools/bash-command.tsx'

it('extracts a literal leading directory and ordered commands without changing the input', () => {
  const command = 'cd /long/worktree/path && git status && git diff'
  expect(formatBashCommand(command)).toEqual({
    directory: '/long/worktree/path',
    commands: ['git status', 'git diff'],
  })
  expect(command).toBe('cd /long/worktree/path && git status && git diff')
  expect(formatBashCommand("cd '/path with spaces' && git status")).toEqual({
    directory: '/path with spaces',
    commands: ['git status'],
  })
  expect(formatBashCommand('cd "./path with spaces" && git status')).toEqual({
    directory: './path with spaces',
    commands: ['git status'],
  })
})

it('keeps quoted and escaped operators within their commands', () => {
  expect(formatBashCommand(`echo 'a && b' && echo "c && d" && echo a\\&\\&b`)).toEqual({
    commands: ["echo 'a && b'", 'echo "c && d"', 'echo a\\&\\&b'],
  })
  expect(formatBashCommand(`echo '$(literal) # text' && pwd`)).toEqual({
    commands: ["echo '$(literal) # text'", 'pwd'],
  })
})

it('preserves escaped whitespace instead of trimming it at chain boundaries', () => {
  for (const whitespace of [' ', '\t']) {
    for (const command of [
      `echo foo\\${whitespace} && pwd`,
      `pwd && echo foo\\${whitespace}`,
      `cd a\\${whitespace}b && pwd`,
    ]) {
      expect(formatBashCommand(command)).toEqual({ commands: [command] })
    }
  }
})

it('leaves unsupported or ambiguous shell syntax completely intact', () => {
  for (const command of [
    'cd /path && echo $(pwd)',
    'cd /path && echo "$HOME"',
    'cd /path && echo `pwd`',
    'cd /path && cat <<EOF',
    'cd /path && pwd # comment',
    'cd /path && pwd\ngit diff',
    'cd /path && (pwd)',
    'cd /path && { pwd; }',
    'if true && pwd; then ls; fi',
    'for i in a b && pwd',
    'cd /path && ! false',
    'cd /path && time pwd',
    'cd /path && [[ -f a && -f b ]]',
    'cd /path && pwd | cat',
    'cd /path && pwd > out',
    'pwd &&',
    "cd /path && echo 'unfinished",
    'cd /path && echo trailing\\',
    'echo one; cd /path && pwd',
  ])
    expect(formatBashCommand(command)).toEqual({ commands: [command] })
})

it('does not hide nonliteral cd arguments, options or a standalone command', () => {
  for (const command of [
    'cd - && pwd',
    'cd ~ && pwd',
    'cd -- /path && pwd',
    'cd /path/* && pwd',
    'cd /path/? && pwd',
  ]) {
    expect(formatBashCommand(command).directory).toBeUndefined()
    expect(formatBashCommand(command).commands[0]).toBe(command.split(' &&')[0])
  }
  expect(formatBashCommand('git status')).toEqual({ commands: ['git status'] })
})
