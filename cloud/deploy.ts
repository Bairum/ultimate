// Deploys the Worker with the user's own domain and machine binding, read from ~/.ultimate/settings.json.
// They are personal, so they never enter this repository: the generated config is gitignored.
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
) as {
  cloud?: { url?: string; tunnels?: Record<string, string> }
}
const { url, tunnels } = settings.cloud ?? {}
if (!url || !tunnels || !Object.keys(tunnels).length) {
  console.error(
    'Set cloud.url and cloud.tunnels in ~/.ultimate/settings.json first; see cloud/README.md.',
  )
  process.exit(1)
}
const base = JSON.parse(readFileSync(new URL('./wrangler.json', import.meta.url), 'utf8')) as object
// Wrangler resolves main and assets relative to the config, so the generated file sits beside the base one.
const config = fileURLToPath(new URL('./wrangler.deploy.json', import.meta.url))
writeFileSync(
  config,
  JSON.stringify({
    ...base,
    routes: [{ pattern: new URL(url).hostname, custom_domain: true }],
    vpc_networks: Object.entries(tunnels).map(([, tunnel_id], index) => ({
      binding: `TUNNEL_${index}`,
      tunnel_id,
    })),
    vars: {
      TUNNELS: JSON.stringify(
        Object.fromEntries(
          Object.keys(tunnels).map((machine, index) => [machine, `TUNNEL_${index}`]),
        ),
      ),
    },
  }),
)
process.exit(
  spawnSync('wrangler', ['deploy', '--config', config, ...process.argv.slice(2)], {
    stdio: 'inherit',
  }).status ?? 1,
)
