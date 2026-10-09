import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { getAgentDir, loadSkills } from '@earendil-works/pi-coding-agent'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'

export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string; settings: SettingsManager },
  cwd = host.projectRoot,
) {
  const layers = [
    { paths: [join(host.ultimateRoot, 'skills')], defaults: false },
    { paths: host.settings.getSkillPaths(), defaults: true },
    { paths: [join(host.userHome, '.ultimate/skills')], defaults: false },
    ...(useProjectSetup(host.projectRoot, host.userHome)
      ? [{ paths: [join(host.projectRoot, '.ultimate/skills')], defaults: false }]
      : []),
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
