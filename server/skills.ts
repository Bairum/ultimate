import { join } from 'node:path'
import { getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent'
import type { PreparedHost } from './harness.ts'

export function projectSkills(
  host: Pick<PreparedHost, 'projectRoot' | 'userHome' | 'settings'>,
  cwd = host.projectRoot,
) {
  const layers = [
    { paths: host.settings.getSkillPaths(), defaults: true },
    { paths: [join(host.userHome, '.ultimate/skills')], defaults: false },
    { paths: [join(host.projectRoot, '.ultimate/skills')], defaults: false },
  ]
  const skills = layers.flatMap(
    (layer) =>
      loadSkills({
        cwd,
        agentDir: getAgentDir(),
        skillPaths: layer.paths,
        includeDefaults: layer.defaults,
      }).skills,
  )
  return [...new Map(skills.map((skill) => [skill.name, skill])).values()]
}
