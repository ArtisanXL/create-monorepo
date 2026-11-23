import { access, readdir, readFile } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { CANCEL, type FsProbe, type Prompter } from "./options.ts";

/** `@clack/prompts`-backed prompter; maps clack's cancel symbol to CANCEL. */
export const clackPrompter: Prompter = {
  async text(message, opts) {
    const answer = await clack.text({
      message: opts?.error ? `${message} (${opts.error})` : message,
      ...(opts?.defaultValue !== undefined && {
        placeholder: opts.defaultValue,
        defaultValue: opts.defaultValue,
      }),
    });
    return clack.isCancel(answer) ? CANCEL : answer;
  },
  async select(message, choices, defaultValue) {
    const answer = await clack.select({
      message,
      options: choices.map((value) => ({ value })),
      initialValue: defaultValue,
    });
    return clack.isCancel(answer) ? CANCEL : answer;
  },
  async multiselect(message, choices, initial) {
    const answer = await clack.multiselect({
      message,
      options: choices.map((value) => ({ value })),
      initialValues: [...initial],
      required: false,
    });
    return clack.isCancel(answer) ? CANCEL : answer;
  },
  async confirm(message, defaultValue) {
    const answer = await clack.confirm({ message, initialValue: defaultValue });
    return clack.isCancel(answer) ? CANCEL : answer;
  },
};

export const nodeFsProbe: FsProbe = {
  readText: (path) =>
    readFile(path, "utf8").then(
      (text) => text,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      },
    ),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  isNonEmptyDir: (path) =>
    readdir(path).then(
      (entries) => entries.length > 0,
      () => false,
    ),
};
