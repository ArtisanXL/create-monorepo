import { describe, expect, it } from "vitest";
import {
  type FsProbe,
  OptionsError,
  type Prompter,
  resolveOptions,
  SUPPORTED_PMS,
} from "../src/options.ts";

const fsProbe: FsProbe = { exists: async () => false };

function fakePrompter(answers: string[] = []) {
  const asked: string[] = [];
  const prompter: Prompter = {
    async text(message, defaultValue) {
      asked.push(message);
      return answers.shift() ?? defaultValue ?? "";
    },
  };
  return { prompter, asked };
}

async function resolve(
  argv: string[],
  env: Record<string, string> = {},
  tty = false,
  answers?: string[],
) {
  const { prompter, asked } = fakePrompter(answers);
  const options = await resolveOptions(argv, env, tty, prompter, fsProbe);
  return { options, asked };
}

const failure = (argv: string[], env: Record<string, string> = {}, tty = false) =>
  resolve(argv, env, tty).then(
    () => {
      throw new Error("expected failure");
    },
    (e: unknown) => e,
  );

describe("resolveOptions: prompting", () => {
  it("does not prompt when all flags are given on a TTY", async () => {
    const { options, asked } = await resolve(["proj", "--scope", "@acme"], {}, true);
    expect(asked).toEqual([]);
    expect(options.scope).toBe("@acme");
  });

  it("does not prompt when not a TTY", async () => {
    const { asked, options } = await resolve(["proj"], {}, false);
    expect(asked).toEqual([]);
    expect(options.scope).toBe("@app");
  });

  it("does not prompt when CI is set, even on a TTY", async () => {
    const { asked } = await resolve(["proj"], { CI: "1" }, true);
    expect(asked).toEqual([]);
  });

  it("does not prompt with -y and uses defaults", async () => {
    const { asked, options } = await resolve(["proj", "-y"], {}, true);
    expect(asked).toEqual([]);
    expect(options).toMatchObject({ scope: "@app", dbPrefix: "app", install: true, pm: "pnpm" });
  });

  it("prompts for missing values on an interactive TTY", async () => {
    const { asked, options } = await resolve([], {}, true, ["my-dir", "@shop"]);
    expect(asked.length).toBe(2);
    expect(options.target.endsWith("my-dir")).toBe(true);
    expect(options.scope).toBe("@shop");
  });
});

describe("resolveOptions: validation", () => {
  it("errors on a missing target non-interactively", async () => {
    expect(await failure([])).toBeInstanceOf(OptionsError);
  });

  it("errors on a missing target with -y even on a TTY", async () => {
    expect(await failure(["-y"], {}, true)).toBeInstanceOf(OptionsError);
  });

  it("errors on an invalid scope", async () => {
    expect(await failure(["proj", "--scope", "acme"])).toMatchObject({
      message: expect.stringContaining("--scope"),
    });
  });

  it("errors on an invalid db prefix", async () => {
    expect(await failure(["proj", "--db-prefix", "9Bad"])).toMatchObject({
      message: expect.stringContaining("--db-prefix"),
    });
  });

  it("derives the db prefix from the scope", async () => {
    const { options } = await resolve(["proj", "--scope", "@My-Shop"]);
    expect(options.dbPrefix).toBe("my_shop");
  });

  it("errors on unknown flags", async () => {
    expect(await failure(["proj", "--bogus"])).toBeInstanceOf(OptionsError);
  });

  it("--no-install disables install", async () => {
    const { options } = await resolve(["proj", "--no-install"]);
    expect(options.install).toBe(false);
  });
});

describe("resolveOptions: package manager", () => {
  it("detects pnpm from npm_config_user_agent", async () => {
    const { options } = await resolve(["p"], {
      npm_config_user_agent: "pnpm/10.1.0 npm/? node/v24.0.0 linux x64",
    });
    expect(options.pm).toBe("pnpm");
  });

  it("falls back to pnpm without a user agent", async () => {
    expect((await resolve(["p"])).options.pm).toBe("pnpm");
  });

  it("falls back to pnpm for an unsupported detected manager", async () => {
    const { options } = await resolve(["p"], {
      npm_config_user_agent: "yarn/4.0.0 npm/? node/v24",
    });
    expect(options.pm).toBe("pnpm");
  });

  it("--pm overrides detection", async () => {
    const { options } = await resolve(["p", "--pm", "pnpm"], {
      npm_config_user_agent: "npm/10 node/v24",
    });
    expect(options.pm).toBe("pnpm");
  });

  it("rejects an unsupported --pm listing the supported ones", async () => {
    const error = await failure(["p", "--pm", "yarn"]);
    expect(error).toBeInstanceOf(OptionsError);
    for (const pm of SUPPORTED_PMS) expect((error as Error).message).toContain(pm);
  });
});
