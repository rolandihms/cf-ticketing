// Run the shared HelpdeskRepo contract (packages/db/test) against real D1 in workerd.
import { D1Dialect, D1Repo } from "@cf-helpdesk/db";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { repoContract, TABLES } from "../../../packages/db/test/repo-contract";

repoContract(
  "d1",
  async () => new D1Repo(env.DB, new Kysely({ dialect: new D1Dialect(env.DB) })),
  async () => {
    for (const t of TABLES) await env.DB.exec(`DELETE FROM ${t}`);
  },
);
