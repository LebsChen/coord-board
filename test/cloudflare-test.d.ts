import type { Env } from "../src";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
