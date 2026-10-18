import { expect, it } from 'vitest'
import { loginPath, renderUnits, selfUnits } from '../scripts/setup-machine.ts'

const options = {
  clone: '/home/u/ultimate',
  project: '/home/u/work/app',
  home: '/home/u',
  node: '/opt/node/bin/node',
  machine: 'rog',
  path: '/home/u/app/node_modules/.bin:/home/u/.local/share/pnpm/.tools/@pnpm+exe/11.8.0/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin',
  tunnel: true,
}

function brokenShell(): never {
  throw new Error('rc failed')
}

function line(content: string, key: string) {
  return content.split('\n').filter((entry) => entry.startsWith(`${key}=`))
}

it('renders ultimate, the machine home and the tunnel with absolute paths', () => {
  const units = Object.fromEntries(renderUnits(options).map((unit) => [unit.name, unit.content]))
  expect(Object.keys(units)).toEqual([
    'ultimate.service',
    'ultimate-machine.service',
    'ultimate-tunnel.service',
  ])
  const ultimate = units['ultimate.service']
  expect(line(ultimate, 'WorkingDirectory')).toEqual(['WorkingDirectory=/home/u/work/app'])
  expect(line(ultimate, 'ExecStart')).toEqual([
    'ExecStart=/opt/node/bin/node /home/u/ultimate/bin/ultimate.ts',
  ])
  expect(line(ultimate, 'Environment')).toContain('Environment=ULTIMATE_NO_OPEN=1')

  const machine = units['ultimate-machine.service']
  expect(line(machine, 'WorkingDirectory')).toEqual(['WorkingDirectory=/home/u/ultimate'])
  expect(line(machine, 'ExecStart')).toEqual([
    'ExecStart=/opt/node/bin/node /home/u/ultimate/bin/ultimate.ts --port 4700 --no-open /home/u/.ultimate/machine',
  ])

  const tunnel = units['ultimate-tunnel.service']
  expect(line(tunnel, 'WorkingDirectory')).toEqual(['WorkingDirectory=/home/u/ultimate'])
  expect(line(tunnel, 'ExecStart')).toEqual([
    'ExecStart=/opt/node/bin/node /home/u/ultimate/node_modules/wrangler/bin/wrangler.js tunnel run ultimate-rog',
  ])

  for (const content of Object.values(units)) {
    expect(line(content, 'Environment').filter((entry) => entry.includes('PATH='))).toEqual([
      'Environment=PATH=/opt/node/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
    ])
    expect(line(content, 'WantedBy')).toEqual(['WantedBy=default.target'])
  }
})

it("puts the login shell's PATH first, so a bare service PATH still finds claude, gh and pnpm", () => {
  const calls: [string, string[]][] = []
  const login =
    '/home/u/.local/share/pnpm:/home/u/.local/share/mise/shims:/home/u/.local/bin:/usr/bin'
  // An rc file that prints a greeting must not leak into PATH.
  const path = loginPath('/usr/bin:/usr/local/bin:/bin', '/bin/bash', (shell, args) => {
    calls.push([shell, args])
    return `Welcome!\n__ULTIMATE_PATH__${login}\n`
  })
  expect(calls[0][0]).toBe('/bin/bash')
  expect(calls[0][1][0]).toBe('-lic')
  const [unit] = renderUnits({ ...options, path })
  expect(line(unit.content, 'Environment').find((entry) => entry.includes('PATH='))).toBe(
    'Environment=PATH=/opt/node/bin:/home/u/.local/share/pnpm:/home/u/.local/share/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
  )
  // A failing shell keeps the script's own PATH.
  expect(loginPath('/usr/bin:/bin', '/bin/zsh', brokenShell)).toBe('/usr/bin:/bin')
})

it('drops PATH entries that are relative or that systemd would misread', () => {
  const [unit] = renderUnits({
    ...options,
    path: '/home/u/My Tools/bin:relative/bin:/home/u/$X/bin::/home/u/.local/bin',
  })
  expect(line(unit.content, 'Environment').find((entry) => entry.includes('PATH='))).toBe(
    'Environment=PATH=/opt/node/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin',
  )
})

it('leaves the tunnel out when the machine has none', () => {
  const names = renderUnits({ ...options, tunnel: false }).map((unit) => unit.name)
  expect(names).toEqual(['ultimate.service', 'ultimate-machine.service'])
})

it('refuses paths systemd would read differently, naming the path', () => {
  for (const [field, path] of [
    ['clone', '/home/u/my ultimate'],
    ['project', '/home/u/work/a"pp'],
    ['project', "/home/u/work/it's"],
    ['home', '/home/u\\x'],
    ['node', '/opt/node%i/bin/node'],
    ['project', '/home/u/$HOME/app'],
    ['project', '/home/u/tab\there'],
  ] as const)
    expect(() => renderUnits({ ...options, [field]: path })).toThrow(
      `${field} path ${JSON.stringify(path)} contains whitespace`,
    )
  // Ordinary punctuation in paths stays allowed.
  expect(() => renderUnits({ ...options, project: '/home/u/work/my-app_2.0+x@y' })).not.toThrow()
})

it('never restarts the unit it runs inside: by InvocationID, and both Ultimate units when supervised', () => {
  const changed = ['ultimate.service', 'ultimate-machine.service', 'ultimate-tunnel.service']
  const ids: Record<string, string> = {
    'ultimate.service': 'aaa',
    'ultimate-machine.service': 'bbb',
    'ultimate-tunnel.service': 'ccc',
  }
  const invocation = (name: string) => ids[name] ?? ''
  // Run by hand outside any unit: everything restarts.
  expect(selfUnits(changed, {}, invocation)).toEqual([])
  // Inside the machine home's unit, found by its InvocationID.
  expect(selfUnits(changed, { INVOCATION_ID: 'bbb' }, invocation)).toEqual([
    'ultimate-machine.service',
  ])
  // Inside the tunnel's unit.
  expect(selfUnits(changed, { INVOCATION_ID: 'ccc' }, invocation)).toEqual([
    'ultimate-tunnel.service',
  ])
  // Under Ultimate's supervisor, either Ultimate unit may be the one: both are left alone.
  expect(selfUnits(changed, { ULTIMATE_SUPERVISED: '1' }, invocation)).toEqual([
    'ultimate.service',
    'ultimate-machine.service',
  ])
  // An unknown INVOCATION_ID matches nothing; an empty one never matches a unit without an id.
  expect(selfUnits(changed, { INVOCATION_ID: 'zzz' }, invocation)).toEqual([])
  expect(selfUnits(['other.service'], { INVOCATION_ID: '' }, () => '')).toEqual([])
  // Only changed units are considered.
  expect(selfUnits(['ultimate-tunnel.service'], { ULTIMATE_SUPERVISED: '1' }, invocation)).toEqual(
    [],
  )
})
