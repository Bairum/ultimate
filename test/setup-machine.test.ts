import { expect, it } from 'vitest'
import {
  type AgentState,
  loadAgents,
  loginPath,
  renderAgents,
  renderUnits,
  selfUnits,
} from '../scripts/setup-machine.ts'

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

/** The text of each top-level <key> in a rendered plist, keyed by name; the value is the raw XML after it. */
function plist(content: string) {
  const body = content.slice(content.indexOf('<dict>') + 6, content.lastIndexOf('</dict>'))
  const entries: Record<string, string> = {}
  for (const part of body.split(/\n  <key>/).slice(1)) {
    const [key, ...rest] = part.split('\n')
    entries[key.replace('</key>', '')] = rest.join('\n').trim()
  }
  return entries
}

const strings = (xml: string) =>
  [...xml.matchAll(/<string>(.*?)<\/string>/g)].map(([, value]) => value)

it('renders the darwin agents with the systemd arguments, PATH, logs and on-failure restarts', () => {
  const agents = renderAgents({ ...options, home: '/Users/u' })
  expect(agents.map(({ name }) => name)).toEqual([
    'com.ultimate.app.plist',
    'com.ultimate.machine.plist',
    'com.ultimate.tunnel.plist',
  ])
  const [app, machine, tunnel] = agents.map(({ content }) => plist(content))
  expect(strings(app.ProgramArguments)).toEqual([
    '/opt/node/bin/node',
    '/home/u/ultimate/bin/ultimate.ts',
  ])
  expect(strings(app.WorkingDirectory)).toEqual(['/home/u/work/app'])
  expect(app.EnvironmentVariables).toContain('<key>ULTIMATE_NO_OPEN</key>\n    <string>1</string>')
  expect(strings(machine.ProgramArguments)).toEqual([
    '/opt/node/bin/node',
    '/home/u/ultimate/bin/ultimate.ts',
    '--port',
    '4700',
    '--no-open',
    '/Users/u/.ultimate/machine',
  ])
  expect(strings(tunnel.ProgramArguments)).toEqual([
    '/opt/node/bin/node',
    '/home/u/ultimate/node_modules/wrangler/bin/wrangler.js',
    'tunnel',
    'run',
    'ultimate-rog',
  ])
  expect(tunnel.EnvironmentVariables).not.toContain('ULTIMATE_NO_OPEN')
  for (const [index, agent] of [app, machine, tunnel].entries()) {
    const label = agents[index].label
    expect(strings(agent.Label)).toEqual([label])
    expect(strings(agent.EnvironmentVariables)[0]).toBe(
      '/opt/node/bin:/opt/mise/shims:/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin',
    )
    expect(agent.RunAtLoad).toBe('<true/>')
    expect(agent.KeepAlive).toContain('<key>SuccessfulExit</key>\n    <false/>')
    expect(strings(agent.StandardOutPath)).toEqual([`/Users/u/Library/Logs/ultimate/${label}.log`])
    expect(agent.StandardErrorPath).toBe(agent.StandardOutPath)
  }
})

it('escapes plist values instead of refusing paths, and leaves the tunnel out when unknown', () => {
  const agents = renderAgents({
    ...options,
    project: `/Users/u/R&D <"x"> it's`,
    path: '/Users/u/My Tools/bin:/opt/a&b',
    tunnel: false,
  })
  expect(agents.map(({ label }) => label)).toEqual(['com.ultimate.app', 'com.ultimate.machine'])
  const app = plist(agents[0].content)
  expect(app.WorkingDirectory).toBe(
    '<string>/Users/u/R&amp;D &lt;&quot;x&quot;&gt; it&apos;s</string>',
  )
  // Whitespace is fine in a plist, so PATH keeps that entry.
  expect(strings(app.EnvironmentVariables)[0]).toBe(
    '/opt/node/bin:/Users/u/My Tools/bin:/opt/a&amp;b:/usr/local/bin:/usr/bin:/bin',
  )
})

it('reloads new and changed agents, loads unloaded unchanged ones and never restarts itself', () => {
  const agents: AgentState[] = [
    { label: 'com.ultimate.app', file: '/L/app.plist', state: 'replaced' },
    { label: 'com.ultimate.machine', file: '/L/machine.plist', state: 'unchanged' },
    { label: 'com.ultimate.tunnel', file: '/L/tunnel.plist', state: 'new' },
  ]
  const plan = (env: Record<string, string>, loaded: string[] = []) => {
    const calls: string[] = []
    const log: string[] = []
    loadAgents(
      agents,
      501,
      env,
      (args) => {
        calls.push(args.join(' '))
        if (args[0] === 'print') return loaded.includes(args[1]) ? 0 : 113
        // bootout of an agent that is not loaded fails, and must not stop the plan.
        return args[0] === 'bootout' ? 3 : 0
      },
      (message) => log.push(message),
    )
    return { calls, log }
  }
  expect(plan({}).calls).toEqual([
    'bootout gui/501/com.ultimate.app',
    'bootstrap gui/501 /L/app.plist',
    'print gui/501/com.ultimate.machine',
    'bootstrap gui/501 /L/machine.plist',
    'bootout gui/501/com.ultimate.tunnel',
    'bootstrap gui/501 /L/tunnel.plist',
  ])
  // A loaded unchanged agent is left running.
  expect(plan({}, ['gui/501/com.ultimate.machine']).calls).not.toContain(
    'bootstrap gui/501 /L/machine.plist',
  )
  // Inside the changed app agent, found by the label launchd puts in XPC_SERVICE_NAME.
  const self = plan({ XPC_SERVICE_NAME: 'com.ultimate.app' }, ['gui/501/com.ultimate.machine'])
  expect(self.calls).toEqual([
    'print gui/501/com.ultimate.machine',
    'bootout gui/501/com.ultimate.tunnel',
    'bootstrap gui/501 /L/tunnel.plist',
  ])
  expect(self.log).toEqual(['com.ultimate.app changed: restart it yourself.'])
  // Under Ultimate's supervisor both Ultimate agents are left alone; the tunnel still reloads.
  const supervised = plan({ ULTIMATE_SUPERVISED: '1' }, ['gui/501/com.ultimate.machine'])
  expect(supervised.calls).toEqual(self.calls)
  // A failing bootstrap stops the setup.
  expect(() =>
    loadAgents(
      agents,
      501,
      {},
      () => 1,
      () => {},
    ),
  ).toThrow('launchctl bootstrap gui/501 /L/app.plist failed.')
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
