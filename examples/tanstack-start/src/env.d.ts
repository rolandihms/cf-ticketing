// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    HELPDESK_SERVICE_KEY: string;
  }
}
