/**
 * The machine home: an Ultimate host whose project is `~/.ultimate/machine`, a plain folder that never syncs. Its only
 * primary standing agent is @sync (`resident: everywhere`, so it stands in project homes too); a project home's is
 * @ultimate.
 * Plain strings, no `node:*`, so the browser shares it.
 */
export const machineRoot = (userHome: string) => `${userHome.replace(/\/+$/, '')}/.ultimate/machine`

export const isMachineHome = (projectRoot: string, userHome: string) =>
  projectRoot === machineRoot(userHome)

/** The standing agent the top bar, the first sidebar row and messages to the user belong to. */
export const primaryAgent = (projectRoot: string, userHome: string) =>
  isMachineHome(projectRoot, userHome) ? 'sync' : 'ultimate'

/**
 * Whether a definition stands in this home: `everywhere` in every home, `machine` only in the machine home, `true`
 * only in project homes.
 */
export const residentHere = (
  resident: boolean | 'machine' | 'everywhere' | undefined,
  projectRoot: string,
  userHome: string,
) =>
  resident === 'everywhere' ||
  (isMachineHome(projectRoot, userHome) ? resident === 'machine' : resident === true)
