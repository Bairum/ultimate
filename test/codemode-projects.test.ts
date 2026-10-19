import { expect, it } from 'vitest'
import type { Project } from '../cloud/directory.ts'
import { resolveProject } from '../extensions/codemode/projects.ts'

const now = Date.UTC(2026, 9, 19, 12)
const here = { name: 'ultimate', root: '/p/ultimate', current: true }
const project = (writer: Project['writer'], machines: Project['machines'] = []): Project => ({
  key: 'github.com/hazat/poe2-rust',
  name: 'poe2-rust',
  slug: 'poe2-rust',
  writer,
  machines,
})

it("resolves this project, a running local one, and the writer's tailnet address", () => {
  expect(resolveProject('ultimate', [here], undefined)).toEqual({ current: true })
  const local = { name: 'poe2-rust', current: false, running: { url: 'http://127.0.0.1:4748' } }
  expect(resolveProject('poe2-rust', [here, local], undefined)).toEqual({
    url: 'http://127.0.0.1:4748',
    label: 'poe2-rust on this machine',
  })
  const tailnet = 'https://haza-pc.tail.ts.net:4748'
  const listed = [project({ machine: 'haza-pc', online: true, tailnet })]
  // Directory names, keys and slugs match case-insensitively.
  for (const name of ['poe2-rust', 'github.com/HazAT/poe2-rust'])
    expect(resolveProject(name, [here], listed)).toEqual({
      url: tailnet,
      label: 'poe2-rust on haza-pc',
    })
})

it('names the machine when the project cannot be reached, and never offers a copy', () => {
  const offline = project({ machine: 'haza-pc', online: false, lastSeen: now - 3 * 3600_000 })
  expect(() => resolveProject('poe2-rust', [here], [offline], now)).toThrow(
    'poe2-rust runs on haza-pc, which is offline (last seen 3 h ago); start Ultimate there to query it',
  )
  const standby = project({ machine: null, online: false }, [
    { machine: 'haza-pc', role: 'standby', connected: false, lastSeen: now - 20 * 60_000 },
  ])
  expect(() => resolveProject('poe2-rust', [here], [standby], now)).toThrow(
    'poe2-rust is on standby (last on haza-pc, 20 min ago); start it there to query it',
  )
  const hidden = project({ machine: 'haza-pc', online: true })
  expect(() => resolveProject('poe2-rust', [here], [hidden], now)).toThrow(
    'which has published no tailnet address',
  )
  expect(() => resolveProject('blog', [here], [standby], now)).toThrow(
    'Unknown project blog. Known: ultimate, poe2-rust',
  )
  expect(() => resolveProject('blog', [here], undefined, now)).toThrow('cloud sync is off')
  const twice = [
    { name: 'poe2-rust', root: '/a/poe2-rust', current: false },
    { name: 'poe2-rust', root: '/b/poe2-rust', current: false },
  ]
  expect(() => resolveProject('poe2-rust', [here, ...twice], undefined)).toThrow(
    'poe2-rust names 2 projects on this machine: /a/poe2-rust, /b/poe2-rust; use its key',
  )
})
