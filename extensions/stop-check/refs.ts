/** Stop check card data: the judged probability of an unexpected stop and the end of the answer that was continued. */

/** `stop-check.continued` entry data: probability `p` (0–1) and the quoted end of the final answer. */
export type ContinuedEntry = { p: number; excerpt: string }
