import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  databaseName,
  ensureSecrets,
  isWorktreeDatabase,
  likePatternFor,
  mayDropDatabase,
  protectedDatabases,
  sourceEnvCandidates,
  rewriteIsolatedKeys,
  withDatabase,
  worktreeKey,
} from "./worktree-lib.mjs";

describe("worktree-lib", () => {
  it("derives a stable, sanitized key from the worktree path", () => {
    const key = worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu");
    expect(key).toMatch(/^icky_emu_[0-9a-f]{6}$/);
    expect(worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu")).toBe(key);
    expect(worktreeKey("/other/Icky-Emu")).not.toBe(key);
  });

  it("names the main and worktree databases", () => {
    expect(databaseName("app", null)).toBe("app");
    expect(databaseName("app", "icky_emu_3f9a1c")).toBe("app_wt_icky_emu_3f9a1c");
  });

  it("recognises only this prefix's worktree databases", () => {
    expect(isWorktreeDatabase("my_app", "my_app_wt_abc_123456")).toBe(true);
    expect(isWorktreeDatabase("my_app", "myxapp_wt_abc_123456")).toBe(false);
    expect(isWorktreeDatabase("my_app", "my_app")).toBe(false);
    expect(isWorktreeDatabase("my_app", "my_app_wt_")).toBe(false);
    expect(isWorktreeDatabase("app", databaseName("app", "k_123456"))).toBe(true);
  });

  it("escapes LIKE wildcards in the prefix", () => {
    expect(likePatternFor("my_app")).toBe("my\\_app\\_wt\\_%");
    expect(likePatternFor("a%b")).toBe("a\\%b\\_wt\\_%");
    expect(likePatternFor("a\\b")).toBe("a\\\\b\\_wt\\_%");
  });

  it("lists .env source candidates in order, skipping an unset Paseo source", () => {
    const dirs = { mainCheckout: "/main", toplevel: "/wt" };
    expect(sourceEnvCandidates({ ...dirs, paseoSource: "/src" })).toEqual([
      "/src/.env",
      "/main/.env",
      "/wt/.env.example",
    ]);
    expect(sourceEnvCandidates({ ...dirs, paseoSource: undefined })).toEqual([
      "/main/.env",
      "/wt/.env.example",
    ]);
  });

  describe("drop safety", () => {
    const prefix = "my_app";
    const env = (db) => `DATABASE_URL=postgres://u:p@localhost:5432/${db}\n`;
    const envsOf = (texts) => texts.map((text, i) => ({ source: `/env${i}`, text }));
    const protect = (texts) => protectedDatabases({ prefix, envs: envsOf(texts) });
    const may = (database, envTexts) =>
      mayDropDatabase({ prefix, database, protected: protect(envTexts) });

    it("refuses the main database", () => {
      expect(may("my_app", [env("my_app")])).toBe(false);
      expect(may("my_app", [])).toBe(false);
    });

    it("refuses the source checkout's database", () => {
      expect(may("my_app_wt_x_123456", [env("my_app_wt_x_123456")])).toBe(false);
    });

    it("refuses a foreign-prefix name", () => {
      expect(may("myxapp_wt_x_123456", [env("my_app")])).toBe(false);
      expect(may("other", [])).toBe(false);
    });

    it("allows this project's own worktree database", () => {
      expect(may("my_app_wt_x_123456", [env("my_app")])).toBe(true);
    });

    it("protects every given env, so a missing Paseo source still leaves the main .env protected", () => {
      const texts = [env("paseo_db"), env("main_db")];
      expect(protect(texts)).toEqual(
        new Set(["my_app", "paseo_db", "main_db"]),
      );
      expect(protect([env("main_db")]).has("main_db")).toBe(true);
    });

    it("ignores a missing DATABASE_URL", () => {
      expect(protect(["FOO=1\n"])).toEqual(new Set(["my_app"]));
    });

    it("fails closed on a malformed source URL, naming the file", () => {
      const bad = "DATABASE_URL=postgres://u:pa/ss@localhost/my_app_wt_feat_abc123\n";
      const decide = () => may("my_app_wt_feat_abc123", [bad]);
      expect(decide).toThrow(/\/env0/);
    });
  });

  it("replaces only the database in a URL", () => {
    expect(withDatabase("postgres://u:p@localhost:5432/app", "app_wt_k")).toBe(
      "postgres://u:p@localhost:5432/app_wt_k",
    );
  });

  it("rewrites isolated keys but keeps deliberate edits", () => {
    const source = "DATABASE_URL=postgres://u:p@h:5432/app\nAPI_KEY=secret\n";
    const fresh = parseEnv(rewriteIsolatedKeys(source, source, "app_wt_k", "k"));
    expect(fresh.DATABASE_URL).toBe("postgres://u:p@h:5432/app_wt_k");
    expect(fresh.WORKTREE_KEY).toBe("k");
    expect(fresh.API_KEY).toBe("secret");

    const edited = "DATABASE_URL=postgres://u:p@h:5432/custom\n";
    expect(parseEnv(rewriteIsolatedKeys(edited, source, "app_wt_k", "k")).DATABASE_URL).toBe(
      "postgres://u:p@h:5432/custom",
    );
  });

  it("fills empty and placeholder secrets only", () => {
    const text = "A=\nB=change-me-please\nC=keep\n";
    const env = parseEnv(ensureSecrets(text, ["A", "B", "C", "D"]));
    expect(env.A).toMatch(/^[0-9a-f]{64}$/);
    expect(env.B).toMatch(/^[0-9a-f]{64}$/);
    expect(env.C).toBe("keep");
    expect(env.D).toMatch(/^[0-9a-f]{64}$/);
  });
});
