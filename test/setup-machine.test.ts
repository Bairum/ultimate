import { expect, it } from 'vitest'
import { renderUnits, selfUnits } from '../scripts/setup-machine.ts'

const options = {
  clone: '/home/u/ultimate',
  project: '/home/u/work/app',
  home: '/home/u',
  node: '/opt/node/bin/node',
  machine: 'rog',
  path: '/home/u/app/node_modules/.bin:/home/u/.local/share/pnpm/.tools/@pnpm+exe/11.8.0/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin',
  tunnel: true,
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
