declare module 'virtual:ultimate/web-facets' {
  export const loaders: Record<string, import('./sdk/registry.ts').ExtensionLoader>
  export const sources: Record<string, { source: 'builtin' | 'user' | 'project'; path: string }>
}
