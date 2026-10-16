import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import { secretMetadata, validateName, validateValue, writeSecret } from './store.ts'

export default defineExtension({
  name: 'secrets',
  sections: [
    section(
      'secrets',
      () =>
        'Secrets are managed by the user in the Secrets panel (⌘K → Secrets). Never read, print, or copy ~/.ultimate/secrets.json. When a tool reports a missing secret, tell the user its name and where to add it.',
    ),
  ],
})
export const userActions = ['set', 'delete']

export const actions: Record<string, ExtensionAction> = {
  async list(_args, { host }) {
    const items = new Map<
      string,
      {
        name: string
        description?: string
        url?: string
        declaredBy: string[]
        set: boolean
        updatedAt?: string
      }
    >()
    for (const extension of host.extensions()) {
      if (!extension.enabled || !extension.server || extension.server.error) continue
      for (const declaration of extension.server.secrets ?? []) {
        const item = items.get(declaration.name) ?? { ...declaration, declaredBy: [], set: false }
        item.declaredBy.push(extension.name)
        items.set(declaration.name, item)
      }
    }
    for (const metadata of await secretMetadata(host.userHome)) {
      items.set(metadata.name, {
        ...items.get(metadata.name),
        ...metadata,
        declaredBy: items.get(metadata.name)?.declaredBy ?? [],
      })
    }
    return [...items.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  },
  async set(args, { host }) {
    const input = args as { name?: unknown; value?: unknown } | null
    validateName(input?.name)
    validateValue(input?.value)
    return writeSecret(host.userHome, input.name, input.value)
  },
  async delete(args, { host }) {
    const input = args as { name?: unknown } | null
    validateName(input?.name)
    return writeSecret(host.userHome, input.name)
  },
}
