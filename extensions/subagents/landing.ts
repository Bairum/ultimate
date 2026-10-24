/**
 * Where a page opens when no conversation is chosen (a first load, a new chapter, a remembered one that is gone):
 * @ultimate's conversation, once the shared state and the standing agents are known. The root is only its history.
 */
export const landing = (loaded: boolean, chosen: unknown, ultimate: number | undefined) =>
  loaded && chosen === undefined ? ultimate : undefined
