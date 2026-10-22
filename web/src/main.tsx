import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { loadExtensions } from './extensions.ts'
import { store } from './sdk/client.ts'

store.start()
// oxlint-disable-next-line typescript/no-floating-promises -- setLoaders settles loaders and records each facet's error in the registry.
void loadExtensions()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
