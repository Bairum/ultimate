declare module 'virtual:ultimate/web-facets' {
  export const loaders: Record<string, import('./sdk/registry.ts').ExtensionLoader>
}
