// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them. Declare optional ones here.
interface Env {
  GITHUB_TOKEN?: string;
  WEBHOOK_SECRET?: string;
}
