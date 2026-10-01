import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { loadExtensions } from './extensions.ts'
import { store } from './sdk/client.ts'

store.start()
void loadExtensions()
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
