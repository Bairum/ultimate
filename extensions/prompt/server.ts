import {
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
} from '@earendil-works/pi-coding-agent'
import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

export default function prompt(host: ExtensionHost) {
  const resources = (cwd: string) => ({
    context: loadProjectContextFiles({ cwd, agentDir: getAgentDir() }),
    skills: loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: host.settings.getSkillPaths(),
      includeDefaults: true,
    }).skills,
  })
  return defineExtension({
    name: 'prompt',
    sections: [
      section(
        'preamble',
        () =>
          'You are Ultimate, a coding agent that can change its own source. Be concise, accurate, and verify your work.',
      ),
      section(
        'tools',
        () =>
          'Use read to inspect files before editing. Use bash for commands and file discovery. Use edit for precise replacements and write for new files or complete rewrites. Prefer existing helpers and platform features; keep changes focused. Run checks before claiming success.',
      ),
      section('project_context', (input) =>
        resources(input.env?.cwd ?? host.repoRoot)
          .context.map((file) => `${file.path}\n${file.content}`)
          .join('\n\n'),
      ),
      section('skills', (input) => {
        const skills = resources(input.env?.cwd ?? host.repoRoot).skills
        return formatSkillsForPrompt(skills)
      }),
      section(
        'self',
        () =>
          `Repository: ${host.repoRoot}\nUI: http://127.0.0.1:${process.env.ULTIMATE_PORT ?? '4747'}\nSee AGENTS.md for reload and durability rules.\n| Path | Reload |\n| web/ | Vite HMR immediately |\n| extensions/ | Reinstalled on save; active calls finish on old code |\n| agents/ | Read at use |\n| server/, shared/ | Core restart |\n| bin/ | Human restart |`,
      ),
      section('cwd', (input) => input.env?.cwd ?? host.repoRoot),
    ],
  })
}
