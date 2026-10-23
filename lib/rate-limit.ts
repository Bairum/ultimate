/**
 * Whether a model error says the provider limits this account: HTTP 429, a rate limit, or a usage limit or quota.
 * Retrying sooner only hits the limit again, so Ultimate pauses until the user presses Play. Overloaded servers (529,
 * "overloaded") are the provider's capacity, not the account's limit, and stay ordinary retryable errors.
 */
export const rateLimited = (error: string) =>
  /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests|usage.?limit|quota/i.test(error)
