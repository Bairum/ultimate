import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxServer, temp, removeTemp, until } from './helpers.ts'

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
    async function render(cwd = projectRoot, useEnv = true) {
      const agent = await server.root.agent(context)
      const sections: Record<string, string> = {}
      for (const extension of server.host.registry.snapshot().installed()) {
        for (const section of extension.sections ?? []) {
          const value = await section.render(
            {
              conversationId: server.root.id,
              agent: { ...agent, cwd },
              env: useEnv ? { cwd } : undefined,
            } as Parameters<typeof section.render>[0],
            context,
          )
          if (value) sections[section.key] = value
        }
      }
      return sections
    }
    expect((await render()).self).toBeUndefined()

    await mkdir(join(projectRoot, '.ultimate'))
    const settings = join(projectRoot, '.ultimate/settings.json')
    await writeFile(settings, JSON.stringify({ extensions: { enable: ['self'] } }))
    server.vite.watcher.emit('change', settings)
    await until(() => !!server.host.registry.snapshot().extension('self'))
    const withSelf = await render()
    expect(withSelf.self).toBeDefined()
    expect(withSelf.building_blocks).not.toContain('- self:')

    const checkout = join(home, 'isolated-work')
    await mkdir(checkout)
    await writeFile(join(checkout, 'AGENTS.md'), 'Isolated project instructions.')
    const skills = vi.spyOn(server.host, 'skills')
    for (const useEnv of [true, false]) {
      const isolated = await render(checkout, useEnv)
      expect(isolated.cwd).toBe(checkout)
      expect(isolated.project_context).toContain('Isolated project instructions.')
      expect(skills).toHaveBeenLastCalledWith(checkout)
    }
    skills.mockRestore()

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
    await removeTemp(home)
  }
})
