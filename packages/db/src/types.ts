export type SqlDialect = "sqlite" | "postgres" | "mysql";

/** Runtime drivers. `d1` and `sqlite` speak the sqlite dialect; `planetscale` speaks mysql. */
export type DbDriver = "d1" | "postgres" | "mysql" | "planetscale";

export const dialectOf = (driver: DbDriver): SqlDialect =>
  driver === "d1" ? "sqlite" : driver === "planetscale" ? "mysql" : driver;
