import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { fauxServer, skipWithoutChromium, temp, untilInput } from './helpers.ts'

const timeout = { timeout: 15000 }

/** A fake `tailscale` on PATH, as in tailscale.test.ts: a running node, and Serve changes kept in `config.json`. */
async function fakeCli(userHome: string) {
  const bin = join(userHome, 'bin')
  const config = join(userHome, 'config.json')
  await mkdir(bin)
  await writeFile(
    config,
    JSON.stringify({
      node: {
        BackendState: 'Running',
        Self: { DNSName: 'rog.example.ts.net.', UserID: 7 },
        User: { '7': { LoginName: 'owner@example.com' } },
        CertDomains: ['rog.example.ts.net'],
      },
      serve: {},
    }),
  )
  await writeFile(
    join(bin, 'tailscale'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
if (args[0] === 'status') console.log(JSON.stringify(config.node));
else if (args.join(' ') === 'serve status --json') console.log(JSON.stringify(config.serve));
else if (config.deny && args.includes('--bg')) { console.error('Access denied: serve config denied'); process.exit(1); }
else {
  const port = args.find(arg => arg.startsWith('--https=')).split('=')[1];
  const authority = 'rog.example.ts.net:' + port;
  config.serve.Web ??= {}; config.serve.TCP ??= {};
  if (args.includes('off')) { delete config.serve.Web[authority]; delete config.serve.TCP[port]; }
  else { config.serve.Web[authority] = { Handlers: { '/': { Proxy: args.at(-1) } } }; config.serve.TCP[port] = { HTTPS: true }; }
  fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify(config));
}
`,
  )
  await chmod(join(bin, 'tailscale'), 0o755)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return config
}

it('turns exposure on from the panel, shows the URL to copy, a problem with its command, and checks again', async (test) => {
  const executablePath = await skipWithoutChromium(test)
  if (!executablePath) return
  const userHome = await temp('ultimate-tailscale-browser-')
  const config = await fakeCli(userHome)
  // Only the project enables it, which loads the facet but exposes nothing.
  const project = join(userHome, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(
    join(project, '.ultimate/settings.json'),
    '{"extensions":{"enable":["tailscale"]}}',
  )
  const settings = join(userHome, '.ultimate/settings.json')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome,
    home: join(userHome, 'state'),
  })
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url)
    await page.locator('#composer-input').waitFor(timeout)
    await untilInput(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('Tailscale…')
    await page.keyboard.press('Enter')
    const panel = page.locator('aside').filter({ hasText: 'Tailnet' })
    const indicator = page.locator('footer').getByRole('button', { name: 'tailnet', exact: true })

    // Disabled: the switch writes only the user's settings.
    const toggle = panel.getByRole('switch', { name: 'Reach this Ultimate from your devices' })
    await expect.poll(() => toggle.count(), timeout).toBe(1)
    expect(await panel.getByText('projects cannot turn it on').count()).toBe(1)
    expect(await panel.getByRole('button', { name: 'Check again' }).count()).toBe(1)
    expect(await indicator.count()).toBe(0)
    await toggle.click()

    // Ready: the URL with copy, who may open it, and the status-line indicator.
    await expect.poll(() => panel.getByText('reachable').count(), timeout).toBe(1)
    expect(JSON.parse(await readFile(settings, 'utf8')).extensions.enable).toEqual(['tailscale'])
    const url = (await panel.getByText(/^https:\/\/rog\.example\.ts\.net:\d+$/).textContent())!
    expect(url).toBe(`https://rog.example.ts.net:${new URL(server.url).port}`)
    expect(await panel.getByText('owner@example.com').count()).toBe(1)
    expect(await panel.getByText('Tailnet only, never on the public internet.').count()).toBe(1)
    expect(await panel.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(url)
    await panel.getByRole('button', { name: 'Copy' }).click()
    await expect.poll(() => panel.getByRole('button', { name: 'Copied' }).count(), timeout).toBe(1)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
    await expect.poll(() => indicator.count(), timeout).toBe(1)

    // A problem state after a live settings reload: its title, the hint, and the command as a chip to copy.
    const value = JSON.parse(await readFile(config, 'utf8'))
    await writeFile(config, JSON.stringify({ ...value, deny: true }))
    await writeFile(
      settings,
      '{"extensions":{"enable":["tailscale"]},"tailscale":{"allow":["owner@example.com"]}}',
    )
    await expect.poll(() => panel.getByText('Not a Tailscale operator').count(), timeout).toBe(1)
    expect(await panel.getByText('needs a fix').count()).toBe(1)
    expect(await panel.getByText('Grant operator rights:', { exact: true }).count()).toBe(1)
    const command = 'sudo tailscale set --operator=$USER'
    await panel.getByRole('button', { name: `Copy ${command}` }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), timeout)
      .toBe(command)
    await expect.poll(() => indicator.count(), timeout).toBe(0)

    // Once fixed, Check again reaches ready in place: no page reload, settings write, or reinstall.
    await writeFile(config, JSON.stringify({ ...value, deny: false }))
    const written = await readFile(settings, 'utf8')
    const loadedAt = () =>
      server.system.current().extensions.find((extension) => extension.name === 'tailscale')?.server
        ?.loadedAt
    const installed = loadedAt()
    await page.evaluate(() => Reflect.set(window, 'samePage', true))
    await panel.getByRole('button', { name: 'Check again' }).click()
    await expect.poll(() => panel.getByText('reachable').count(), timeout).toBe(1)
    expect(await panel.getByText(url, { exact: true }).count()).toBe(1)
    await expect.poll(() => indicator.count(), timeout).toBe(1)
    expect(await page.evaluate(() => Reflect.get(window, 'samePage'))).toBe(true)
    expect(await readFile(settings, 'utf8')).toBe(written)
    expect(loadedAt()).toBe(installed)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
}, 120000)
