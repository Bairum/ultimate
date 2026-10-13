export interface BashCommand {
  commands: string[]
  operators: ('&&' | ';')[]
  directory?: string
}

/** Display only: recognize ordinary lists, not general shell grammar. */
export function formatBashCommand(command: string): BashCommand {
  // Extract a literal cd independently: an unsupported tail must not hide the work.
  const cd =
    /^\s*cd[ \t]+(?:([^\s'"\\|&;(){}<>$`#*?[\]]+)|'([^'\r\n]+)'|"([^"\\$`\r\n]+)")[ \t]*&&[ \t]*/.exec(
      command,
    )
  const path = cd && (cd[1] ?? cd[2] ?? cd[3])
  const directory = path && !/^[-~]/.test(path) ? path : undefined
  const tail = directory ? command.slice(cd![0].length) : command
  const context = directory ? { directory } : {}
  const intact: BashCommand = { ...context, commands: [tail], operators: [] }
  if (!tail || /[\r\n]/.test(tail)) return intact
  const commands: string[] = []
  const operators: BashCommand['operators'] = []
  let quote = ''
  let start = 0
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i]
    if (char === '\\' && quote !== "'") {
      if (++i === tail.length || /\s/.test(tail[i])) return intact
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
    if (char === '&' && tail[i + 1] === '&') {
      commands.push(tail.slice(start, i).trim())
      operators.push('&&')
      start = ++i + 1
    } else if (char === ';') {
      commands.push(tail.slice(start, i).trim())
      operators.push(';')
      start = i + 1
    } else if (char === '&') {
      // Descriptor duplication belongs to a redirect, not a command separator.
      if (!(/[<>]/.test(tail[i - 1] ?? '') && /[\d-]/.test(tail[i + 1] ?? ''))) return intact
    } else if (
      /[(){}$`#]/.test(char) ||
      (char === '<' && tail[i + 1] === '<') ||
      (char === '|' && tail[i + 1] === '|')
    )
      return intact
  }
  if (quote) return intact
  commands.push(tail.slice(start).trim())
  if (
    commands.some(
      (part) =>
        !part ||
        /(?:^|\|\s*)(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|!|time|coproc|\[\[)(?:\s|$)/.test(
          part,
        ),
    )
  )
    return intact
  if (commands.length < 2) return intact
  return { ...context, commands, operators }
}
