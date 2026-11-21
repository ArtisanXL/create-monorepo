import { describe, expect, it } from "vitest";
import {
  CANCEL,
  CancelledError,
  type FsProbe,
  OptionsError,
  type Prompter,
  parseCli,
  resolveOptions,
  SUPPORTED_PMS,
} from "../src/options.ts";

const fsProbe: FsProbe = { exists: async () => false, isNonEmptyDir: async () => false };

type Answer = string | boolean | typeof CANCEL;

/** Scripted prompter: pops answers in order; falls back to the default. */
function fakePrompter(answers: Answer[] = []) {
  const asked: string[] = [];
  const next = (message: string, fallback: Answer): Answer => {
    asked.push(message);
    return answers.length > 0 ? (answers.shift() as Answer) : fallback;
  };
  const prompter: Prompter = {
    async text(message, opts) {
      return next(message, opts?.defaultValue ?? "") as string | typeof CANCEL;
    },
    async select(message, _choices, defaultValue) {
      return next(message, defaultValue) as string | typeof CANCEL;
    },
    async confirm(message, defaultValue) {
      return next(message, defaultValue) as boolean | typeof CANCEL;
    },
  };
  return { prompter, asked };
}

async function resolve(
  argv: string[],
  env: Record<string, string> = {},
  tty = false,
  answers?: Answer[],
  probe: FsProbe = fsProbe,
) {
  const { prompter, asked } = fakePrompter(answers);
  const options = await resolveOptions(parseCli(argv), env, tty, prompter, probe);
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
    const { options, asked } = await resolve(
      ["proj", "--scope", "@acme", "--db-prefix", "acme", "--pm", "pnpm", "--no-install"],
      {},
      true,
    );
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

  it("prompts for every value on an interactive TTY with no flags", async () => {
    const { asked, options } = await resolve([], {}, true, [
      "my-dir",
      "@shop",
      "shop_db",
      "pnpm",
      false,
    ]);
    expect(asked).toHaveLength(5);
    expect(options).toMatchObject({
      scope: "@shop",
      dbPrefix: "shop_db",
      pm: "pnpm",
      install: false,
    });
    expect(options.target.endsWith("my-dir")).toBe(true);
  });

  it("prompts only for values the flags did not provide", async () => {
    const { asked, options } = await resolve(["proj", "--pm", "pnpm", "--no-install"], {}, true, [
      "@x",
      "my_db",
    ]);
    expect(asked).toHaveLength(2);
    expect(options).toMatchObject({ scope: "@x", dbPrefix: "my_db", install: false });
  });

  it("defaults the scope to @<dir-name> and derives the db prefix from the answer", async () => {
    const { options } = await resolve(["some/My-App"], {}, true, []);
    expect(options.scope).toBe("@my-app");
    expect(options.dbPrefix).toBe("my_app");
    expect(options.install).toBe(true);
  });

  it("re-asks the target until it is non-empty", async () => {
    const { options, asked } = await resolve([], {}, true, ["  ", "dir"]);
    expect(options.target.endsWith("dir")).toBe(true);
    expect(asked.filter((m) => m === "Target directory")).toHaveLength(2);
  });

  it("re-asks the scope on invalid input", async () => {
    const { options, asked } = await resolve(["proj"], {}, true, ["nope", "@ok"]);
    expect(options.scope).toBe("@ok");
    expect(asked.filter((m) => m === "Package scope")).toHaveLength(2);
  });

  it("re-asks the db prefix on invalid input", async () => {
    const { options, asked } = await resolve(["proj", "--scope", "@a"], {}, true, ["9Bad", "good"]);
    expect(options.dbPrefix).toBe("good");
    expect(asked.filter((m) => m === "Database prefix")).toHaveLength(2);
  });
});

describe("resolveOptions: existing target directory", () => {
  const nonEmpty: FsProbe = { exists: async () => true, isNonEmptyDir: async () => true };

  it("asks for confirmation when the directory is non-empty and proceeds on yes", async () => {
    const { options, asked } = await resolve(["proj", "--scope", "@a"], {}, true, [true], nonEmpty);
    expect(asked).toHaveLength(4); // confirm, db prefix, pm, install
    expect(asked[0]).toMatch(/only missing files/i);
    expect(options.scope).toBe("@a");
  });

  it("throws CancelledError when the confirmation is declined", async () => {
    const error = await resolve(["proj"], {}, true, [false], nonEmpty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
  });

  it("does not ask with -y", async () => {
    const { asked } = await resolve(["proj", "-y"], {}, true, [], nonEmpty);
    expect(asked).toEqual([]);
  });

  it("does not ask without a TTY", async () => {
    const { asked } = await resolve(["proj"], {}, false, [], nonEmpty);
    expect(asked).toEqual([]);
  });

  it("does not ask for an empty or missing directory", async () => {
    const { asked } = await resolve(["proj", "--scope", "@a"], {}, true, []);
    expect(asked.some((m) => /only missing files/i.test(m))).toBe(false);
  });
});

describe("resolveOptions: cancel", () => {
  it.each([0, 1, 2, 3, 4])("cancel at prompt #%i throws CancelledError", async (index) => {
    const answers: Answer[] = ["dir", "@s", "s_db", "pnpm", true];
    answers[index] = CANCEL;
    const error = await resolve([], {}, true, answers).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
  });

  it("cancel at the existing-directory confirmation throws CancelledError", async () => {
    const nonEmpty: FsProbe = { exists: async () => true, isNonEmptyDir: async () => true };
    const error = await resolve(["proj"], {}, true, [CANCEL], nonEmpty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
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
    const { options } = await resolve(["proj", "--scope", "@my-shop"]);
    expect(options.dbPrefix).toBe("my_shop");
  });

  it("repairs a derived db prefix so the CLI never rejects a flag the user did not pass", async () => {
    for (const [scope, expected] of [
      ["@1app", "db_1app"],
      ["@-", "db__"],
      [`@${"a".repeat(40)}`, "a".repeat(30)],
    ] as const) {
      const { options } = await resolve(["proj", "--scope", scope]);
      expect(options.dbPrefix, scope).toBe(expected);
    }
  });

  it("rejects scopes that are not valid npm scopes", async () => {
    for (const scope of [
      "@",
      "@A",
      '@a"b',
      "@a b",
      "@a/b",
      "@a$&",
      "@.a",
      "@_a",
      "@a\\b",
      "@a\nb",
    ]) {
      expect(await failure(["proj", "--scope", scope]), scope).toMatchObject({
        message: expect.stringContaining("--scope"),
      });
    }
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
