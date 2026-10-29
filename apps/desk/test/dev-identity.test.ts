import { describe, expect, it } from "vitest";
import { withDevIdentity } from "../src/dev-identity";

const env = { DEV_AGENT_EMAIL: "Dev@Example.com", TRUSTED_PRINCIPAL: "on", HELPDESK_SERVICE_KEY: "k" };

describe("withDevIdentity", () => {
  it("signs a localhost request in as the dev admin", () => {
    const r = withDevIdentity(new Request("http://localhost:5173/api/me"), env);
    expect(r.headers.get("x-helpdesk-service-key")).toBe("k");
    expect(JSON.parse(r.headers.get("x-helpdesk-principal")!)).toEqual({
      externalId: "dev:dev@example.com",
      email: "dev@example.com",
      role: "admin",
      partition: null,
    });
  });

  it("leaves any other hostname alone", () => {
    for (const url of ["https://support.ihms.co/api/me", "https://desk.example.workers.dev/api/me", "http://localhost.evil.test/api/me"]) {
      const r = withDevIdentity(new Request(url), env);
      expect(r.headers.has("x-helpdesk-service-key"), url).toBe(false);
    }
  });

  it("is off unless every dev variable is set", () => {
    for (const partial of [
      { ...env, DEV_AGENT_EMAIL: "" },
      { ...env, TRUSTED_PRINCIPAL: "off" },
      { ...env, HELPDESK_SERVICE_KEY: undefined },
      {},
    ]) {
      const r = withDevIdentity(new Request("http://localhost/api/me"), partial);
      expect(r.headers.has("x-helpdesk-principal")).toBe(false);
    }
  });
});
