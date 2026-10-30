import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Database driver compiled into the Worker (Vite ignores `define` in wrangler.jsonc). Unused drivers are
  // dropped at build time: "d1" | "postgres" | "mysql" | "planetscale" | "all". See docs/DATABASE.md.
  define: { __HELPDESK_DB_DRIVER__: JSON.stringify("d1") },
  plugins: [
    react(),
    // WRANGLER_CONFIG picks a deploy profile, e.g. wrangler.ihms-co.jsonc. Local dev never reaches real
    // Cloudflare services, so Workers AI is off and classification falls back to the rules.
    cloudflare({ configPath: process.env.WRANGLER_CONFIG ?? "wrangler.jsonc", remoteBindings: false }),
  ],
});
