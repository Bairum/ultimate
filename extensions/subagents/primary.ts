/**
 * The machine home: an Ultimate host whose project is `~/.ultimate/machine`, a plain folder that never syncs. Its only
 * standing agent is @sync (`resident: machine`); a project home's primary standing agent is @ultimate.
 * Plain strings, no `node:path`, so the browser shares it.
 */
export const machineRoot = (userHome: string) => `${userHome.replace(/\/+$/, '')}/.ultimate/machine`

export const isMachineHome = (projectRoot: string, userHome: string) =>
  projectRoot === machineRoot(userHome)

/** The standing agent the top bar, the first sidebar row and messages to the user belong to. */
export const primaryAgent = (projectRoot: string, userHome: string) =>
  isMachineHome(projectRoot, userHome) ? 'sync' : 'ultimate'

/** Whether a definition stands in this home: `resident: machine` only in the machine home, `true` only elsewhere. */
export const residentHere = (
  resident: boolean | 'machine' | undefined,
  projectRoot: string,
  userHome: string,
) => (isMachineHome(projectRoot, userHome) ? resident === 'machine' : resident === true)
