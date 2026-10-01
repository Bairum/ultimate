const app = document.querySelector<HTMLElement>('#app')!
let count = 0
app.textContent = 'Ultimate server is running — connecting…'
const events = new EventSource('/api/events')
for (const name of ['system', 'conversations', 'view', 'ops', 'tasks', 'auth', 'notice']) {
  events.addEventListener(name, () => {
    app.textContent = `Ultimate server is running — ${++count} events`
  })
}
import.meta.hot?.dispose(() => events.close())
