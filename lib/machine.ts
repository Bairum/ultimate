/**
 * The machine home: an Ultimate host whose project is `~/.ultimate/machine`, a plain folder that never syncs. It has
 * no standing agent; a project home's primary standing agent is @ultimate.
 * Plain strings, no `node:*`, so the browser shares it.
 */
export const machineRoot = (userHome: string) => `${userHome.replace(/\/+$/, '')}/.ultimate/machine`

export const isMachineHome = (projectRoot: string, userHome: string) =>
  projectRoot === machineRoot(userHome)

/**
 * The standing agent the top bar, the first sidebar row and messages to the user belong to: @ultimate in a project
 * home, none in the machine home.
 */
export const primaryAgent = (projectRoot: string, userHome: string) =>
  isMachineHome(projectRoot, userHome) ? undefined : 'ultimate'

/** Whether a definition stands in this home: `resident: true` stands in project homes only. */
export const residentHere = (
  resident: boolean | undefined,
  projectRoot: string,
  userHome: string,
) => resident === true && !isMachineHome(projectRoot, userHome)
