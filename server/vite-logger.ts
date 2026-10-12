import { createLogger } from 'vite-plus'
import { reportCore } from './supervisor-protocol.ts'

export function viteLogger() {
  const logger = createLogger('info', { allowClearScreen: false })
  if (process.env.ULTIMATE_SUPERVISED !== '1') return logger
  const warned = new Set<string>()
  logger.info = (text) => reportCore({ type: 'log', level: 'info', source: 'web', text })
  logger.warn = (text) => {
    logger.hasWarned = true
    reportCore({ type: 'log', level: 'warn', source: 'web', text })
  }
  logger.warnOnce = (text) => {
    if (warned.has(text)) return
    warned.add(text)
    logger.warn(text)
  }
  logger.error = (text) => {
    logger.hasWarned = true
    reportCore({ type: 'log', level: 'error', source: 'web', text })
  }
  return logger
}
