// Deploys the Worker with the user's own domain and machine binding, read from ~/.ultimate/settings.json.
// They are personal, so they never enter this repository: the generated config is gitignored.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const settings = JSON.parse(readFileSync(join(homedir(), '.ultimate/settings.json'), 'utf8')) as {
  cloud?: { url?: string; vpcService?: string }
}
const { url, vpcService } = settings.cloud ?? {}
if (!url || !vpcService) {
  console.error(
    'Set cloud.url and cloud.vpcService in ~/.ultimate/settings.json first; see cloud/README.md.',
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
    vpc_services: [{ binding: 'MACHINE', service_id: vpcService }],
  }),
)
process.exit(
  spawnSync('wrangler', ['deploy', '--config', config], { stdio: 'inherit' }).status ?? 1,
)
