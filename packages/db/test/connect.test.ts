import { describe, expect, it } from "vitest";
import { buildDriver, driverOf } from "../src/connect";

describe("driver selection (no build-time define → all drivers available)", () => {
  it("defaults to d1 and honours DB_DRIVER", () => {
    expect(buildDriver()).toBe("all");
    expect(driverOf({})).toBe("d1");
    expect(driverOf({ DB_DRIVER: "Postgres" })).toBe("postgres");
  });
  it("rejects unknown drivers", () => {
    expect(() => driverOf({ DB_DRIVER: "oracle" })).toThrow(/Unsupported DB_DRIVER/);
  });
});
