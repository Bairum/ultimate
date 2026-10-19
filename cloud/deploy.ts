// Deploys the Worker on the user's own domain, read from ~/.ultimate/settings.json.
// It is personal, so it never enters this repository: the generated config is gitignored.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const settings = JSON.parse(
  readFileSync(
    process.env.ULTIMATE_CLOUD_SETTINGS ?? join(homedir(), '.ultimate/settings.json'),
    'utf8',
  ),
) as { cloud?: { url?: string } }
const url = settings.cloud?.url
if (!url) {
  console.error('Set cloud.url in ~/.ultimate/settings.json first; see cloud/README.md.')
  process.exit(1)
}
const base = JSON.parse(readFileSync(new URL('./wrangler.json', import.meta.url), 'utf8')) as object
// Wrangler resolves main and assets relative to the config, so the generated file sits beside the base one.
const config = fileURLToPath(new URL('./wrangler.deploy.json', import.meta.url))
writeFileSync(
  config,
  JSON.stringify({ ...base, routes: [{ pattern: new URL(url).hostname, custom_domain: true }] }),
)
// Tag the version with the commit it was built from, so `wrangler versions view` tells whether cloud/ changed since.
const git = (...args: string[]) =>
  spawnSync('git', args, {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    encoding: 'utf8',
  }).stdout.trim()
const dirty = git('status', '--porcelain', '--', '.') ? '-dirty' : ''
const tag = `${git('rev-parse', '--short', 'HEAD')}${dirty}`
const message = git('log', '-1', '--format=%s')
process.exit(
  spawnSync(
    'wrangler',
    ['deploy', '--config', config, '--tag', tag, '--message', message, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  ).status ?? 1,
)
