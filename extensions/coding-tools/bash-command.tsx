export interface BashCommand {
  commands: string[]
  directory?: string
}

/** Display only: recognize simple chains, not general shell grammar. */
export function formatBashCommand(command: string): BashCommand {
  const intact = { commands: [command] }
  if (/[\r\n]/.test(command)) return intact
  const commands: string[] = []
  let quote = ''
  let start = 0
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && quote !== "'") {
      if (++i === command.length) return intact
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      else if (quote === '"' && /[$`]/.test(char)) return intact
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '&' && command[i + 1] === '&') {
      commands.push(command.slice(start, i).trim())
      start = ++i + 1
    } else if (/[|&;(){}<>$`#]/.test(char)) return intact
  }
  if (quote) return intact
  commands.push(command.slice(start).trim())
  if (
    commands.some(
      (part) =>
        !part ||
        /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|!|time|coproc|\[\[)(?:\s|$)/.test(
          part,
        ),
    )
  )
    return intact
  if (commands.length < 2) return intact

  // Only strip cd with one literal path; options, expansions and escapes stay visible.
  const cd = /^cd\s+(?:([^\s'"\\]+)|'([^']+)'|"([^"\\]+)")$/.exec(commands[0])
  const directory = cd && (cd[1] ?? cd[2] ?? cd[3])
  if (directory && !/^[-~]/.test(directory) && !(cd[1] && /[*?[\]]/.test(cd[1]))) {
    return { directory, commands: commands.slice(1) }
  }
  return { commands }
}
