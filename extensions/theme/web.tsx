import { defineWebExtension, getState } from '@/sdk'

export default defineWebExtension({
  commands: [
    {
      id: 'theme.toggle',
      title: 'Toggle light and dark theme',
      group: 'Ultimate',
      run: (context) => context.setTheme(getState().ui.theme === 'dark' ? 'light' : 'dark'),
    },
  ],
})
