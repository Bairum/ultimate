type Progress = { key: string; status: string; tasks: Record<string, { status: string }> }

/** Done and canceled tasks are finished. */
export const finished = (tasks: Record<string, { status: string }>) =>
  Object.values(tasks).filter((task) => task.status === 'done' || task.status === 'canceled').length

/** The pill's epic: the newest open one, its progress, and how many other epics are open; none once all are done. */
export function pillOf<E extends Progress>(epics: Record<string, E>) {
  const open = Object.values(epics)
    .filter((epic) => epic.status !== 'done')
    .toSorted((a, b) => number(b.key) - number(a.key))
  const epic = open[0]
  if (!epic) return undefined
  return {
    epic,
    finished: finished(epic.tasks),
    total: Object.keys(epic.tasks).length,
    more: open.length - 1,
  }
}

export const number = (key: string) => Number(key.slice(1).split('.')[0]) || 0
