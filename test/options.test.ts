import { describe, expect, it } from "vitest";
import {
  CANCEL,
  CancelledError,
  type FsProbe,
  OptionsError,
  type Prompter,
  parseCli,
  resolveOptions,
} from "../src/options.ts";
import { PM_NAMES } from "../src/pm/index.ts";

const fsProbe: FsProbe = {
  exists: async () => false,
  isNonEmptyDir: async () => false,
  readText: async () => undefined,
};

type Answer = string | boolean | string[] | typeof CANCEL;

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
    async multiselect(message, _choices, initial) {
      return next(message, [...initial]) as string[] | typeof CANCEL;
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
      [
        "proj",
        "--apps",
        "api,web,worker",
        "--scope",
        "@acme",
        "--db-prefix",
        "acme",
        "--pm",
        "pnpm",
        "--no-install",
      ],
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
      ["api", "web", "worker"],
      "@shop",
      "shop_db",
      "pnpm",
      false,
    ]);
    expect(asked).toHaveLength(6);
    expect(options).toMatchObject({
      scope: "@shop",
      dbPrefix: "shop_db",
      pm: "pnpm",
      install: false,
    });
    expect(options.target.endsWith("my-dir")).toBe(true);
  });

  it("prompts only for values the flags did not provide", async () => {
    const { asked, options } = await resolve(
      ["proj", "--apps", "api,web,worker", "--pm", "pnpm", "--no-install"],
      {},
      true,
      ["@x", "my_db"],
    );
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
    const { options, asked } = await resolve(["proj", "--apps", "api,web,worker"], {}, true, [
      "nope",
      "@ok",
    ]);
    expect(options.scope).toBe("@ok");
    expect(asked.filter((m) => m === "Package scope")).toHaveLength(2);
  });

  it("re-asks the db prefix on invalid input", async () => {
    const { options, asked } = await resolve(
      ["proj", "--scope", "@a", "--apps", "api,web,worker"],
      {},
      true,
      ["9Bad", "good"],
    );
    expect(options.dbPrefix).toBe("good");
    expect(asked.filter((m) => m === "Database prefix")).toHaveLength(2);
  });
});

describe("resolveOptions: existing target directory", () => {
  const nonEmpty: FsProbe = {
    ...fsProbe,
    exists: async () => true,
    isNonEmptyDir: async () => true,
  };

  it("asks for confirmation when the directory is non-empty and proceeds on yes", async () => {
    const { options, asked } = await resolve(["proj", "--scope", "@a"], {}, true, [true], nonEmpty);
    expect(asked).toHaveLength(5); // confirm, apps, db prefix, pm, install
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
  it.each([0, 1, 2, 3, 4, 5])("cancel at prompt #%i throws CancelledError", async (index) => {
    const answers: Answer[] = ["dir", ["api", "web", "worker"], "@s", "s_db", "pnpm", true];
    answers[index] = CANCEL;
    const error = await resolve([], {}, true, answers).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
  });

  it("cancel at the existing-directory confirmation throws CancelledError", async () => {
    const nonEmpty: FsProbe = {
      ...fsProbe,
      exists: async () => true,
      isNonEmptyDir: async () => true,
    };
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

  it("rejects db prefixes containing the worktree separator", async () => {
    for (const prefix of ["app_wt", "app_wt_foo", "a_wt"]) {
      expect(await failure(["proj", "--db-prefix", prefix]), prefix).toMatchObject({
        message: expect.stringContaining("_wt"),
      });
    }
  });

  it("derives the db prefix from the scope", async () => {
    const { options } = await resolve(["proj", "--scope", "@my-shop"]);
    expect(options.dbPrefix).toBe("my_shop");
  });

  it("repairs a derived db prefix so the CLI never rejects a flag the user did not pass", async () => {
    for (const [scope, expected] of [
      ["@1app", "db_1app"],
      ["@-", "db__"],
      ["@app-wt", "app_w_t"],
      ["@app-wt-x", "app_w_t_x"],
      ["@wt-x", "wt_x"],
      ["@1wt", "db_1wt"],
      ["@-wt", "db__w_t"],
      ["@app-wt-wt", "app_w_t_w_t"],
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
    for (const pm of PM_NAMES) expect((error as Error).message).toContain(pm);
  });
});

describe("resolveOptions: selection (Decisions 1, 3, 6, 9, 10)", () => {
  const withArch = (packages: string[]): FsProbe => ({
    ...fsProbe,
    readText: async (path) =>
      path.endsWith("architecture.json")
        ? JSON.stringify({ packages: Object.fromEntries(packages.map((p) => [p, {}])) })
        : undefined,
  });
  const ALL = ["api", "web", "worker"];

  it("selects everything by default", async () => {
    const { options } = await resolve(["proj"]);
    expect(options.selection).toEqual({
      apps: ALL,
      packages: ["domain", "contracts", "db", "core"],
    });
  });

  it("takes --apps and --packages, with the Closure filling in dependencies", async () => {
    const { options } = await resolve(["proj", "--apps", "api"]);
    expect(options.selection.apps).toEqual(["api"]);
    expect(options.selection.packages).toEqual(["domain", "contracts", "db", "core"]);
    const lib = await resolve(["proj", "--apps", "none", "--packages", "contracts,domain"]);
    expect(lib.options.selection).toEqual({ apps: [], packages: ["domain", "contracts"] });
    const web = await resolve(["proj", "--apps", "web"]);
    expect(web.options.selection).toEqual({ apps: ["web"], packages: [] });
  });

  it("rejects unknown names, names for the wrong flag, and an empty Selection", async () => {
    expect(await failure(["proj", "--apps", "nope"])).toMatchObject({
      message: expect.stringContaining("Unknown --apps value 'nope'"),
    });
    expect(await failure(["proj", "--apps", "db"])).toMatchObject({
      message: expect.stringContaining("belongs to the other flag"),
    });
    expect(await failure(["proj", "--packages", "api"])).toBeInstanceOf(OptionsError);
    expect(await failure(["proj", "--apps", "none"])).toMatchObject({
      message: expect.stringContaining("Nothing selected"),
    });
  });

  it("errors on --db-prefix without db in the Closure, and skips the prompt", async () => {
    expect(await failure(["proj", "--apps", "web", "--db-prefix", "x"])).toMatchObject({
      message: expect.stringContaining("--db-prefix"),
    });
    const { asked } = await resolve(["proj", "--apps", "web"], {}, true, [[], "@s", "pnpm", false]);
    expect(asked).toEqual([
      "Extra packages (not already required by the apps)",
      "Package scope",
      "Package manager",
      "Install dependencies?",
    ]);
    const ok = await resolve(["proj", "--apps", "none", "--packages", "db", "--db-prefix", "x"]);
    expect(ok.options.dbPrefix).toBe("x");
  });

  it("reads the Selection from an existing architecture.json", async () => {
    const probe = withArch(["apps/web"]);
    const { options, asked } = await resolve(["proj"], {}, true, ["@s", "pnpm", false], probe);
    expect(options.selection).toEqual({ apps: ["web"], packages: [] });
    expect(asked).not.toContain("Apps");
  });

  it("accepts flags that restate the recorded Selection", async () => {
    const probe = withArch([
      "packages/domain",
      "packages/db",
      "packages/contracts",
      "packages/core",
      "apps/api",
    ]);
    const { options } = await resolve(["proj", "--apps", "api"], {}, false, undefined, probe);
    expect(options.selection.apps).toEqual(["api"]);
  });

  it("errors on flags that conflict with it, pointing at the ADR-0002 process", async () => {
    const error = await resolve(
      ["proj", "--apps", "api"],
      {},
      false,
      undefined,
      withArch(["apps/web"]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OptionsError);
    expect((error as Error).message).toMatch(/conflict with the existing architecture\.json.*ADR/s);
  });

  it("errors when architecture.json cannot be read", async () => {
    const probe: FsProbe = { ...fsProbe, readText: async () => "{" };
    expect(
      await resolve(["proj"], {}, false, undefined, probe).catch((e: unknown) => e),
    ).toBeInstanceOf(OptionsError);
  });

  it("asks an app multiselect (all checked), then extra packages outside the Closure", async () => {
    const calls: { message: string; choices: readonly string[]; initial: readonly string[] }[] = [];
    const prompter: Prompter = {
      ...fakePrompter().prompter,
      multiselect: async (message, choices, initial) => {
        calls.push({ message, choices, initial });
        return message === "Apps" ? ["web"] : ["domain"];
      },
    };
    const options = await resolveOptions(
      parseCli(["proj", "--scope", "@s", "--pm", "pnpm", "--no-install"]),
      {},
      true,
      prompter,
      fsProbe,
    );
    expect(calls[0]).toEqual({
      message: "Apps",
      choices: ["api", "web", "worker"],
      initial: ["api", "web", "worker"],
    });
    expect(calls[1]?.choices).toEqual(["domain", "contracts", "db", "core"]);
    expect(calls[1]?.initial).toEqual([]);
    expect(options.selection).toEqual({ apps: ["web"], packages: ["domain"] });
  });

  it("skips the package multiselect when the apps already require every package", async () => {
    const { asked } = await resolve(
      ["proj", "--scope", "@s", "--pm", "pnpm", "--no-install"],
      {},
      true,
      [],
    );
    expect(asked).toEqual(["Apps", "Database prefix"]);
  });
});

describe("nodeFsProbe.readText", () => {
  it("returns the text, or undefined for a missing file", async () => {
    const { nodeFsProbe } = await import("../src/wizard.ts");
    expect(
      await nodeFsProbe.readText(new URL("../package.json", import.meta.url).pathname),
    ).toContain("create-monorepo");
    expect(await nodeFsProbe.readText("/nonexistent/architecture.json")).toBeUndefined();
  });
});
