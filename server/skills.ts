import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { loadSkills } from '@earendil-works/pi-coding-agent'

export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string },
  cwd = host.projectRoot,
) {
  const layers = [
    join(host.ultimateRoot, 'skills'),
    join(cwd, '.pi/skills'),
    join(host.userHome, '.ultimate/skills'),
    ...(useProjectSetup(host.projectRoot, host.userHome)
      ? [join(host.projectRoot, '.ultimate/skills')]
      : []),
  ]
  const agentDir = join(host.userHome, '.ultimate')
  const skills = layers.flatMap(
    (path) => loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false }).skills,
  )
  return [...new Map(skills.map((skill) => [skill.name, skill])).values()]
}
