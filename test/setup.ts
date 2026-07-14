import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import schema from "./schema";

beforeAll(async () => {
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
});
