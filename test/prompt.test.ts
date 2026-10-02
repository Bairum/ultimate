import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxServer, temp, until } from './helpers.ts'

it('renders only enabled guidance, lists off building blocks, and adds self guidance live', async () => {
  const home = await temp()
  vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'pi'))
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    async function render() {
      const agent = await server.root.agent(context)
      const sections: Record<string, string> = {}
      for (const extension of server.host.registry.snapshot().installed()) {
        for (const section of extension.sections ?? []) {
          const value = await section.render(
            { conversationId: server.root.id, agent, env: { cwd: projectRoot } } as Parameters<
              typeof section.render
            >[0],
            context,
          )
          if (value) sections[section.key] = value
        }
      }
      return sections
    }
    const sections = await render()
    const { building_blocks, ...enabled } = sections
    expect(
      Object.values(enabled)
        .join('\n')
        .match(/\brestart\b|subagent|\bplan\b/gi),
    ).toBeNull()
    for (const name of ['self', 'subagents', 'plan']) {
      const extension = server.extensions.info().find((entry) => entry.name === name)!
      expect(building_blocks).toContain(`- ${name}:`)
      expect(building_blocks).toContain(
        extension
          .readme!.trim()
          .split(/(?<=[.!?])\s/)[0]
          .replace(/\s+/g, ' '),
      )
    }
    expect(building_blocks).toContain(
      `${server.extensions
        .info()
        .find((entry) => entry.name === 'prompt')!
        .path.replace(/\/prompt$/, '')}/`,
    )
    expect(building_blocks).toContain('~/.ultimate/settings.json')
    expect(building_blocks).toContain('<project>/.ultimate/settings.json')
    expect(building_blocks).toContain('live with no restart')
    expect(sections.self).toBeUndefined()
    expect(sections.identity).not.toContain('change your own source')

    await mkdir(join(projectRoot, '.ultimate'))
    const settings = join(projectRoot, '.ultimate/settings.json')
    await writeFile(settings, JSON.stringify({ extensions: { enable: ['self'] } }))
    server.vite.watcher.emit('change', settings)
    await until(() => !!server.host.registry.snapshot().extension('self'))
    const withSelf = await render()
    expect(withSelf.self).toContain(`Project (your work): ${projectRoot}`)
    expect(withSelf.self).toContain('Ultimate (yourself):')
    expect(withSelf.self).toContain('/AGENTS.md')
    expect(withSelf.self).toContain('/extensions/README.md')
    expect(withSelf.self).toContain('new UI is a new extension folder')
    expect(withSelf.self).toContain('Call restart only after editing server/ or shared/')
    expect(withSelf.codemode).toContain('Call restart only at top level.')
    expect(withSelf.building_blocks).not.toContain('- self:')

    await writeFile(
      settings,
      JSON.stringify({
        extensions: { enable: server.extensions.info().map((entry) => entry.name) },
      }),
    )
    server.vite.watcher.emit('change', settings)
    await until(() => server.extensions.info().every((entry) => entry.enabled))
    const agent = await server.root.agent(context)
    const blocks = agent.sections.find((section) => section.key === 'building_blocks')!
    expect(
      await blocks.render({ agent } as Parameters<typeof blocks.render>[0], context),
    ).toBeUndefined()
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
})
