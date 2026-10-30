import { defineConfig } from "vitest/config";

// Plain Node: the Worker's own logic is tested in packages/worker; only the app's glue is tested here.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
