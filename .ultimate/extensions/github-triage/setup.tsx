import { MessageSquarePlusIcon, RotateCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, useSystem } from '@/sdk'
import type { Status } from './types.tsx'

/** What to type to install gh on this machine; the link covers the rest. */
function installCommand(platform: string | undefined): string {
  if (platform === 'darwin') return 'brew install gh'
  if (platform === 'win32') return 'winget install --id GitHub.cli'
  return 'sudo pacman -S github-cli   # or apt / dnf install gh'
}

/** Shown instead of the triage view while gh is missing or logged out: what to run, and a way to ask for help. */
export function Setup({ status, retry }: { status: Status; retry: () => void }) {
  const system = useSystem()
  const missing = status.status === 'missing'
  const steps = missing
    ? [installCommand(system?.machine.platform), 'gh auth login']
    : ['gh auth login']
  const problem = missing
    ? 'the GitHub CLI (gh) is not installed'
    : `gh is not logged in (${status.status === 'auth' ? status.message : ''})`
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-6 py-5">
      <div className="w-full max-w-md">
        <h1 className="text-[15px] font-medium">
          {missing ? 'Install the GitHub CLI' : 'Log in to GitHub'}
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Triage reads issues and pull requests through <code className="font-mono">gh</code>.{' '}
          {missing ? (
            <>
              It is not on this machine yet; see{' '}
              <a
                className="text-foreground underline underline-offset-2"
                href="https://cli.github.com"
                rel="noreferrer"
                target="_blank"
              >
                cli.github.com
              </a>{' '}
              for other systems.
            </>
          ) : (
            'It is installed but not logged in.'
          )}{' '}
          Run this in a terminal:
        </p>
        <pre className="mt-3 rounded-md border border-border/70 bg-terminal px-3 py-2.5 font-mono text-[12px] leading-relaxed">
          {steps.map((step) => `$ ${step}`).join('\n')}
        </pre>
        <div className="mt-4 flex gap-2">
          <Button onClick={retry} size="sm" variant="outline">
            <RotateCwIcon />
            Check again
          </Button>
          <Button
            onClick={() =>
              void api.submit(
                `The Triage surface cannot reach GitHub: ${problem}. Check \`gh --version\` and \`gh auth status\` and walk me through getting gh installed and logged in on this machine. Anything that needs my input (sudo, the browser login) I will run myself.`,
                'followUp',
              )
            }
            size="sm"
            variant="ghost"
          >
            <MessageSquarePlusIcon />
            Ask the agent for help
          </Button>
        </div>
      </div>
    </main>
  )
}
