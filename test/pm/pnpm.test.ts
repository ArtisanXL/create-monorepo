import { expect, it } from "vitest";
import { createPnpmAdapter } from "../../src/pm/pnpm.ts";
import { adapterContract } from "./contract.ts";

adapterContract("pnpm", (v) => createPnpmAdapter(async () => v));

const pnpm = createPnpmAdapter(async () => "9.9.9");

it("pnpm commands and lockfile", () => {
  expect(pnpm.lockfile).toBe("pnpm-lock.yaml");
  expect(pnpm.installCommand()).toEqual(["pnpm", "install"]);
  expect(pnpm.verifyCommand()).toEqual(["pnpm", "verify"]);
  expect(pnpm.execCommand(["biome", "check"])).toEqual(["pnpm", "exec", "biome", "check"]);
  expect(pnpm.filterCommand("@acme/api", "test")).toEqual([
    "pnpm",
    "--filter",
    "@acme/api",
    "test",
  ]);
});
