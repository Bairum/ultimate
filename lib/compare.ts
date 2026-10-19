/** DiffsHub's view of `base...sha` for a `github.com/<owner>/<repo>` key: GitHub's compare path on diffshub.com. */
export function compareUrl(repo: string, base: string, sha: string): string {
  return `https://diffshub.com/${repo.replace(/^github\.com\//, '')}/compare/${base}...${sha}`
}
