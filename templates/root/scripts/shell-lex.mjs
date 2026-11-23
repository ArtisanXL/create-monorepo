// The shell lexer and command segmenter behind the guard: splits a command line into simple commands,
// redirects, heredocs and nested command strings, and works out where each runs. It knows nothing about
// the architecture contract. Imported by guard-rules.mjs.
import path from "node:path";

const WRAPPERS = new Set([
  "sudo", "time", "env", "command", "exec", "nohup", "nice", "corepack", "npx", "bunx", "xargs", "builtin",
]);
export const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
export const ASSIGNMENT = /^[A-Za-z_]\w*=/;
export const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby|php|tsx|ts-node)$/;
export const SHELL_NAME = /^(?:ba|z|da|k|a)?sh$/;
const MAX_CDS = 32;
const MAX_COMMAND_LENGTH = 50_000;
const READ_ONLY = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "man", "which", "whereis", "cat", "less", "more", "head", "tail", "ls", "wc", "stat", "file", "diff"]);
const READ_ONLY_GIT = new Set(["log", "grep", "show", "diff", "status", "blame", "ls-files", "describe", "rev-parse"]);

export const baseName = (w) => w.replace(/^.*[\\/]/, "");

const MAX_LEX_LEVEL = 6;
const MAX_GROUP = 512;
// Words after which a `(` opens a subshell, a case pattern or a function body, not a pattern group.
const NO_GROUP = new Set(["function", "time", "coproc", "case", "select"]);
// Stands in a word's text for each `$(...)` / backtick substitution in it; the inner command strings are in `word.subst`.
export const SUBST = "\uE000";
const ANSI_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

// The `$'...'` string whose body starts at i: escapes are skipped (so `\'` does not end it) and decoded.
// Returns the text and the index of the closing quote (or the string length).
function ansiC(s, i) {
  let text = "";
  for (; i < s.length && s[i] !== "'"; i++) {
    if (s[i] !== "\\") {
      text += s[i];
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (Object.hasOwn(ANSI_SIMPLE, n)) text += ANSI_SIMPLE[n];
    else if (n === "x" || n === "u" || n === "U") {
      const max = n === "x" ? 2 : n === "u" ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(s.slice(i + 1, i + 1 + max));
      const code = m ? Number.parseInt(m[0], 16) : Number.NaN;
      if (m && code <= 0x10ffff) text += code === 0xe000 ? "\uFFFD" : String.fromCodePoint(code);
      else text += `\\${n}${m ? m[0] : ""}`;
      i += m ? m[0].length : 0;
    } else if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i, i + 3));
      text += String.fromCharCode(Number.parseInt(m[0], 8) & 255);
      i += m[0].length - 1;
    } else if (n === "c") text += String.fromCharCode((s.charCodeAt(++i) || 0) & 31);
    else text += `\\${n}`;
  }
  return { text, end: i };
}

// `<<[-]WORD` starting just after the `<<`: the delimiter and where the word ends.
function readHeredocDelimiter(s, i) {
  let j = i;
  const strip = s[j] === "-";
  if (strip) j++;
  while (s[j] === " " || s[j] === "\t") j++;
  let delim = "";
  let quoted = false;
  for (; j < s.length && !/[\s;|&()<>]/.test(s[j]); j++) {
    const c = s[j];
    if (c === "$" && (s[j + 1] === "'" || s[j + 1] === '"')) continue;
    if (c === "'" || c === '"') {
      quoted = true;
      const e = s.indexOf(c, j + 1);
      const stop = e < 0 ? s.length : e;
      delim += s.slice(j + 1, stop);
      j = stop;
    } else if (c === "\\") {
      quoted = true;
      delim += s[++j] ?? "";
    } else delim += c;
  }
  return { delim, quoted, strip, end: j, body: "" };
}

// The body starting at `from` (just after a newline) up to its delimiter line; `next` is the index of
// the newline that ends the delimiter line (or the string length).
function heredocBody(s, from, h) {
  for (let pos = from; pos <= s.length; ) {
    const e = s.indexOf("\n", pos);
    const stop = e < 0 ? s.length : e;
    const line = s.slice(pos, stop).replace(/\r$/, "");
    if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
      h.body = s.slice(from, pos);
      return { next: stop };
    }
    if (e < 0) break;
    pos = e + 1;
  }
  h.body = s.slice(from);
  return { next: s.length };
}

// Index of the first `)` of the `))` that closes an arithmetic expression starting at i.
function closeArith(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      if (depth === 0 && s[i + 1] === ")") return i;
      depth = Math.max(0, depth - 1);
    }
  }
  return s.length;
}

// Index of the `)` closing the `(` at i. This runs the same lexer as shellSegments, so comments,
// quotes, arithmetic and heredocs are recognised by one set of rules.
function closeParen(s, i, state, level) {
  if (level >= MAX_LEX_LEVEL) {
    state.complex = true;
    return s.length;
  }
  return lexShell(s, state, i + 1, true, level + 1).end;
}

// `$(...)` and backtick substitutions in text the shell expands (unquoted heredoc bodies).
function substitutionsIn(text, out, state, level) {
  for (let j = 0; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "$" && text[j + 1] === "(") {
      const e = closeParen(text, j + 1, state, level);
      out.push(text.slice(j + 2, e));
      j = e;
    } else if (text[j] === "`") {
      let e = j + 1;
      while (e < text.length && text[e] !== "`") e += text[e] === "\\" ? 2 : 1;
      out.push(text.slice(j + 1, e));
      j = e;
    }
  }
}

/**
 * The one shell lexer. Splits a command into simple commands: quotes are removed, `;` `&&` `||` `|` `&`
 * newlines, parentheses and backticks separate commands, comments (`#` at a word start) are dropped and
 * redirects (`>`, `>>`, `>|`, `>&file`, `&>`) are collected apart from the words. `$(...)`, backticks and
 * arithmetic inside double quotes or arithmetic are returned in `nested` as command strings of their own.
 * Each segment records the operator that ended it (`sep`) and its heredocs: `<<WORD` is recognised
 * outside quotes, comments and arithmetic, and the body is skipped rather than parsed as commands.
 * With `stopAtClose` it stops at the `)` that closes an enclosing `$(` and returns its index in `end`.
 */
function lexShell(cmd, state, from = 0, stopAtClose = false, level = 0) {
  const segments = [];
  const nested = [];
  let words = [];
  let redirs = [];
  let heredocs = [];
  let inputs = [];
  let procSub = false;
  let waiting = [];
  let cur = null;
  let pending = null;
  let depth = 0;
  const pushWord = () => {
    if (cur === null) return;
    const w = cur;
    cur = null;
    if (pending) {
      const p = pending;
      pending = null;
      // The target of a redirect has no segment of its own: its substitutions are checked as nested strings.
      if (w.loose) nested.push(...w.loose);
      if (p.op === "<" || p.op === "<<<") inputs.push({ op: p.op, target: w.text, dyn: w.dyn });
      else if (!(p.amp && /^(\d+|-)$/.test(w.text))) redirs.push({ op: p.op, target: w.text });
    } else words.push(w);
  };
  const end = (sep) => {
    pushWord();
    pending = null;
    if (words.length || redirs.length || inputs.length || procSub) segments.push({ words, redirs, sep, heredocs, inputs, procSub });
    words = [];
    redirs = [];
    heredocs = [];
    inputs = [];
    procSub = false;
  };
  const grow = () => {
    cur ??= { text: "", quoted: false };
    return cur;
  };
  // A quote or escape right after `$IFS` ends the variable name (`rm$IFS'x'` is `rm x`): spell it `${IFS}`.
  const ifsEnd = () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell spelling, not a template
    if (cur) cur.text = cur.text.replace(/\$IFS$/, "${IFS}");
  };
  // Arithmetic (`$((..))`, `$[..]`) and backticks are scanned for commands; returns the new index.
  const expansion = (i) => {
    grow().dyn = true;
    cur.opaque = true;
    if (cmd[i + 2] === "(") {
      const e = closeArith(cmd, i + 3);
      nested.push(cmd.slice(i + 3, e));
      return e + 1;
    }
    const e = cmd.indexOf("]", i + 2);
    const stop = e < 0 ? cmd.length : e;
    nested.push(cmd.slice(i + 2, stop));
    return stop;
  };
  // After the command name (a word that is not a keyword or assignment); `function f` still defines, not runs.
  const inArgs = () => {
    const lead = words.find((w) => !KEYWORDS.has(w.text) && !ASSIGNMENT.test(w.text));
    return lead !== undefined && !NO_GROUP.has(lead.text);
  };
  // The extent of the `(...)` at `from` (quotes and escapes skipped) and whether it can be a pattern group: it ends,
  // is not empty (`f ()` defines a function) and has no space, `;`, `&` or newline (a subshell does).
  let group = { end: 0, ok: false };
  const groupOk = (from) => {
    let d = 0;
    let bare = "";
    let j = from;
    // A pattern is short: past MAX_GROUP characters it is a subshell, which also keeps an unbalanced run of `(` linear.
    for (; j < cmd.length && j - from < MAX_GROUP; j++) {
      const ch = cmd[j];
      if (ch === "\\") j++;
      else if (ch === "'") j = cmd.indexOf("'", j + 1) < 0 ? cmd.length : cmd.indexOf("'", j + 1);
      else if (ch === '"') for (j++; j < cmd.length && cmd[j] !== '"'; j++) j += cmd[j] === "\\" ? 1 : 0;
      else if (ch === "(") d++;
      else if (ch === ")" && --d === 0) break;
      else if (d > 0 && j > from) bare += ch;
    }
    group = { end: j, ok: j < cmd.length && bare.length > 0 && !/[\s;&]/.test(bare) };
    return group.ok;
  };
  // A command substitution inside the current word: its text becomes SUBST, its command string goes to `subst`
  // (and, outside double quotes, to `loose`, which the segmenter checks with the directories the word is in).
  const substitute = (inner, loose) => {
    grow().dyn = true;
    cur.subst ??= [];
    cur.subst.push(inner);
    if (loose) {
      cur.loose ??= [];
      cur.loose.push(inner);
    }
    cur.text += SUBST;
  };
  let i = from;
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i++;
      else if (i + 1 < cmd.length) {
        ifsEnd();
        grow().text += cmd[++i];
      }
    } else if (c === "$" && cmd[i + 1] === "'") {
      const r = ansiC(cmd, i + 2);
      ifsEnd();
      grow().quoted = true;
      cur.text += r.text;
      i = r.end;
    } else if (c === "$" && cmd[i + 1] === '"') {
      // $"..." quotes like "...": drop the $.
    } else if (c === "$" && ((cmd[i + 1] === "(" && cmd[i + 2] === "(") || cmd[i + 1] === "[")) {
      i = expansion(i);
      grow().text += "0";
    } else if (c === "$" && cmd[i + 1] === "(") {
      const e = closeParen(cmd, i + 1, state, level);
      substitute(cmd.slice(i + 2, e), true);
      i = e;
    } else if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      const stop = e < 0 ? cmd.length : e;
      ifsEnd();
      grow().quoted = true;
      cur.text += cmd.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      ifsEnd();
      grow().quoted = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "\\" && '"\\$`'.includes(cmd[i + 1] ?? "")) i++;
        else if (cmd[i] === "$" && ((cmd[i + 1] === "(" && cmd[i + 2] === "(") || cmd[i + 1] === "[")) {
          i = expansion(i);
          continue;
        } else if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const e = closeParen(cmd, i + 1, state, level);
          nested.push(cmd.slice(i + 2, e));
          substitute(cmd.slice(i + 2, e), false);
          i = e;
          continue;
        } else if (cmd[i] === "`") {
          let e = i + 1;
          while (e < cmd.length && cmd[e] !== "`") e += cmd[e] === "\\" ? 2 : 1;
          nested.push(cmd.slice(i + 1, e));
          substitute(cmd.slice(i + 1, e), false);
          i = e;
          continue;
        }
        cur.text += cmd[i];
      }
      ifsEnd();
    } else if (c === " " || c === "\t" || c === "\r") pushWord();
    else if (c === "#" && cur === null) {
      const e = cmd.indexOf("\n", i);
      i = e < 0 ? cmd.length : e - 1;
    } else if (c === "|") {
      const sep = cmd[i + 1] === "|" ? "||" : "|";
      end(sep);
      if (sep === "||") i++;
    } else if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      if (cur !== null && !cur.quoted && /^\d+$/.test(cur.text)) cur = null;
      else pushWord();
      const h = readHeredocDelimiter(cmd, i + 2);
      if (h.delim) {
        heredocs.push(h);
        waiting.push(h);
      }
      i = h.end - 1;
    } else if (c === "\n" && waiting.length) {
      for (const h of waiting) {
        i = heredocBody(cmd, i + 1, h).next;
        // An unquoted delimiter lets the shell expand substitutions inside the body.
        if (!h.quoted) substitutionsIn(h.body, nested, state, level);
      }
      waiting = [];
      end(";");
    } else if (c === "(" && cmd[i + 1] === "(" && cur === null && words.every((w) => KEYWORDS.has(w.text))) {
      // `(( expr ))` as a command: arithmetic, not two subshells.
      const e = closeArith(cmd, i + 2);
      nested.push(cmd.slice(i + 2, e));
      i = e + 1;
    } else if (c === "(" && !pending && cmd[i - 1] !== "<" && cmd[i - 1] !== ">" && !cur?.text.endsWith("$") && inArgs() && !(cur && /^[A-Za-z_]\w*\+?=$/.test(cur.text)) && groupOk(i)) {
      // A `(` after the command name is a pattern group (`d@(ocs)`, `!(src)`, `+(d)ocs`, zsh `(d|x)ocs`, `*(/)`), not a subshell.
      // It stands for `*` in the word, so `d@(ocs)` is the glob `d@*`; a zsh `(#i)` flag makes the rest of the word `*`.
      const flags = cmd[i + 1] === "#";
      const w = grow();
      // The extglob operator (`@(`, `!(`, `+(`, `*(`, `?(`) is syntax, not part of the name.
      w.text = `${w.text.replace(/[@!+*?]$/, "")}*`;
      w.glob = true;
      if (flags) w.swallow = true;
      i = group.end;
    } else if (c === "(") {
      if (cur?.text.endsWith("$")) cur.dyn = true;
      depth++;
      end(";");
    } else if (c === ")") {
      if (stopAtClose && depth === 0) break;
      depth = Math.max(0, depth - 1);
      end(";");
    } else if (c === "`") {
      // An unquoted backtick is a substitution like `$(...)`: part of the word, its value left to run time (`X=`cmd``).
      let e = i + 1;
      while (e < cmd.length && cmd[e] !== "`") e += cmd[e] === "\\" ? 2 : 1;
      substitute(cmd.slice(i + 1, e), true);
      i = e;
    } else if (c === "\n" || c === ";") end(";");
    else if (c === "&" && cmd[i + 1] !== ">") {
      const sep = cmd[i + 1] === "&" ? "&&" : "&";
      end(sep);
      if (sep === "&&") i++;
    } else if (c === "<" && cmd[i + 1] === "(") {
      // `<(...)`: process substitution, a command's output read as a file.
      pushWord();
      procSub = true;
    } else if (c === ">" || c === "<" || c === "&") {
      if (cur !== null && !cur.quoted && /^\d+$/.test(cur.text)) cur = null;
      else pushWord();
      if (c === "&") i++;
      let op = c === "<" ? "<" : ">";
      let amp = false;
      if (c === "<") {
        let n = 1;
        while (cmd[i + 1] === "<") {
          i++;
          n++;
        }
        if (n >= 3) op = "<<<";
      } else if (cmd[i + 1] === ">") {
        op = ">>";
        i++;
      } else if (cmd[i + 1] === "|") i++;
      else if (cmd[i + 1] === "&") {
        amp = true;
        i++;
      }
      pending = { op, amp };
    } else {
      grow();
      if (cur.swallow) continue;
      cur.text += c;
      if (c === "^" && cur.text.length === 1 && inArgs()) cur.glob = true;
      if (c === "{") cur.brace = true;
      if (c === "*" || c === "?" || c === "[") cur.glob = true;
    }
  }
  end("");
  return { segments, nested, end: i };
}

const shellSegments = (cmd) => {
  const state = { complex: false };
  // A literal placeholder character in the input must not be mistaken for a substitution.
  const { segments, nested } = lexShell(cmd.replaceAll(SUBST, "\uFFFD"), state);
  return { segments, nested, complex: state.complex };
};

/** `$PWD`, `${PWD}` and `~+` at the start of a path are the working directory: `.`. */
export const pwdWord = (t) => t.replace(/^(?:\$PWD|\$\{PWD\}|~\+)(?=\/|$)/, ".");

/** A folder name the guard can resolve: no variable, substitution, glob, `-`, `~-` or `~user`. */
export const literalDir = (t) => t !== "" && t !== "-" && !/[$`*?[\]{}]/.test(t) && !t.includes(SUBST) && !/^~[^/]/.test(t);

/** Drops assignments, keywords and wrapper prefixes (and their flags); `find -exec` yields its inner command too. */
function commandsOf(words, fold) {
  let i = 0;
  while (i < words.length) {
    const w = words[i].text;
    if (ASSIGNMENT.test(w) || KEYWORDS.has(w)) i++;
    else if (WRAPPERS.has(fold(baseName(w)))) {
      i++;
      while (i < words.length && words[i].text.startsWith("-")) i++;
    } else break;
  }
  if (i >= words.length) return [];
  const name = fold(baseName(words[i].text));
  const args = words.slice(i + 1);
  const out = [{ name, args }];
  if (name === "find") {
    const k = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
    if (k >= 0) out.push(...commandsOf(args.slice(k + 1), fold));
  }
  return out;
}

/** Splits arguments into flags and operands; everything after `--` is an operand. */
export function splitArgs(args) {
  const flags = [];
  const operands = [];
  let rest = false;
  for (const a of args) {
    if (!rest && a.text === "--") rest = true;
    else if (!rest && a.text.length > 1 && a.text.startsWith("-")) flags.push(a.text);
    else operands.push(a);
  }
  return { flags, operands };
}

// git global options and the position of the subcommand.
export function gitOptions(args) {
  let i = 0;
  const dirs = [];
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === "-C" || t === "-c" || /^--(?:git-dir|work-tree|namespace|config-env)$/.test(t)) {
      if (t === "-C" && args[i + 1]) dirs.push(args[i + 1].text);
      i++;
    } else if (!t.startsWith("-")) break;
  }
  return { i, dirs };
}

// Files a segment writes: its `>` / `>>` redirect targets and the operands of tee.
function writtenTargets(seg, fold) {
  const out = seg.redirs.filter((r) => r.op === ">" || r.op === ">>").map((r) => path.normalize(r.target));
  const at = seg.words.findIndex((w) => !w.quoted && fold(baseName(w.text)) === "tee");
  if (at >= 0) for (const w of seg.words.slice(at + 1)) if (!w.text.startsWith("-")) out.push(path.normalize(w.text));
  return out;
}

// Whether a segment executes one of the files: `bash f`, `. f`, `node f`, or `./f` itself.
function runs(seg, targets, fold) {
  const is = (w) => targets.includes(path.normalize(w.text));
  if (seg.words[0] && is(seg.words[0])) return true;
  return seg.words.some(
    (w, k) =>
      !w.quoted &&
      (SHELL_NAME.test(fold(baseName(w.text))) || w.text === "." || w.text === "source" || INTERPRETERS.test(fold(baseName(w.text)))) &&
      seg.words.slice(k + 1).some(is),
  );
}

/** `git commit -F -` and `gh ... --body-file -` read their input as data. */
function readsStdinAsData(seg) {
  if (seg.name !== "git" && seg.name !== "gh") return false;
  const w = seg.words.map((x) => x.text);
  return w.some((t, k) => (/^(?:-F|--file|--body-file|--notes-file)$/.test(t) && w[k + 1] === "-") || /^--(?:file|body-file|notes-file)=-$/.test(t));
}

/**
 * A read-only tool run plainly: no variable assignment (`PAGER=rm`), no git `-c`, and none of the
 * options that make a reader run or write something (`rg --pre`, `man -P`, `--ext-diff`, `--output`, `-o`).
 */
export function knownSafe(seg, fold) {
  const name = seg.name ?? "";
  if (seg.words.some((w) => ASSIGNMENT.test(w.text))) return false;
  if (seg.words.some((w) => /^--(?:pre|pre-glob|pager|ext-diff|output|exec-path|upload-pack)(?:=|$)/.test(w.text))) return false;
  if (name === "man" && seg.words.some((w) => /^-[A-Za-z]*P/.test(w.text))) return false;
  if ((name === "less" || name === "more") && seg.words.some((w) => /^-[A-Za-z]*[oO]/.test(w.text))) return false;
  if (name === "git") {
    const at = seg.words.findIndex((w) => !w.quoted && fold(baseName(w.text)) === "git");
    const args = seg.words.slice(at + 1);
    const { i } = gitOptions(args);
    return !args.slice(0, i).some((a) => a.text === "-c") && READ_ONLY_GIT.has(fold(args[i]?.text ?? ""));
  }
  return READ_ONLY.has(name);
}

const VAR_REF = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
const IFS_REF = /\$(?:\{IFS\}|IFS(?!\w))(?:\$[0-9])?/g;
const MAX_VAR_LENGTH = 1024;
// Total characters variable substitution may produce in one decision, shared by nested strings.
const MAX_EXPANSION = 65_536;
const ASSIGNING = new Set(["export", "declare", "typeset", "readonly", "local"]);
const ASSIGN_WORD = /^([A-Za-z_]\w*)(\+?)=/;
// Commands that set the variables named by their bare arguments.
const SETTERS = new Set(["read", "getopts", "mapfile", "readarray", "unset", "printf", "select", "for"]);

// Escapes printf and echo -e decode the same way in bash and zsh. Anything else (`\c`, `\u`, `\0NNN`, an unknown letter) is
// not modelled, so the output counts as unknown.
const SIMPLE_ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\" };
const QUOTE_ESC = { "'": "'", '"': '"', "?": "?" };

/** The escape at t[i] (a backslash): its text and length, or undefined. `kind`: "fmt" (printf format), "b" (`%b` argument) or "echo". */
function escapeAt(t, i, kind) {
  const n = t[i + 1];
  if (n === undefined) return undefined;
  if (Object.hasOwn(SIMPLE_ESC, n)) return { s: SIMPLE_ESC[n], len: 2 };
  if (kind === "fmt" && Object.hasOwn(QUOTE_ESC, n)) return { s: QUOTE_ESC[n], len: 2 };
  let m;
  let code;
  let len;
  if (n === "x") {
    m = /^[0-9a-fA-F]{1,2}/.exec(t.slice(i + 2, i + 4));
    code = m ? Number.parseInt(m[0], 16) : -1;
    len = m ? 2 + m[0].length : 0;
  } else if (kind === "fmt" && /[0-7]/.test(n)) {
    m = /^[0-7]{1,3}/.exec(t.slice(i + 1, i + 4));
    code = Number.parseInt(m[0], 8);
    len = 1 + m[0].length;
  }
  // A byte above 127 is part of a multi-byte character.
  return code >= 0 && code < 128 ? { s: String.fromCharCode(code), len } : undefined;
}

function decodeEscapes(t, kind) {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "\\") {
      out += t[i];
      continue;
    }
    const e = escapeAt(t, i, kind);
    if (!e) return undefined;
    out += e.s;
    i += e.len - 1;
  }
  return out;
}

/** `printf FORMAT ARGS...` with %s %b %d %%; undefined for anything else (width, %q, unmodelled escapes). The format is reused while arguments remain. */
function printfValue(fmt, args) {
  let out = "";
  let used = 0;
  do {
    let took = false;
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] === "\\") {
        const e = escapeAt(fmt, i, "fmt");
        if (!e) return undefined;
        out += e.s;
        i += e.len - 1;
      } else if (fmt[i] !== "%") out += fmt[i];
      else {
        const conv = fmt[++i];
        if (conv === "%") out += "%";
        else if (conv === "s") out += args[used++] ?? "";
        else if (conv === "b") {
          const d = decodeEscapes(args[used++] ?? "", "b");
          if (d === undefined) return undefined;
          out += d;
        } else if (conv === "d") {
          const a = args[used++] ?? "0";
          if (!/^-?(?:0|[1-9]\d{0,14})$/.test(a)) return undefined;
          out += String(Number.parseInt(a, 10));
        } else return undefined;
        took = true;
      }
    }
    if (!took) break;
  } while (used < args.length);
  return out;
}

// printf / echo / pwd as the shell's own command: bare, or from the standard folders.
const trusted = (text, name) => text === name || text === `/usr/bin/${name}` || text === `/bin/${name}`;
// A function or alias named like a builtin the guard evaluates, or `enable`, on the line.
export const SHADOWS = /(?:^|[\s;&|(])(?:function\s+(?:printf|echo|pwd|command|builtin)\b|(?:printf|echo|pwd|command|builtin)\s*\(\s*\))|\balias\s+(?:printf|echo|pwd)\b|(?:^|[\s;&|(])enable\s+-[A-Za-z]*n/;

/**
 * What `printf` or `echo` prints when its format and arguments are all literal (no `$`, no substitution, no glob) and every
 * escape is one the guard models exactly; undefined otherwise. Behind `command` / `builtin`.
 */
export function staticOutput(words, shadowed = false) {
  if (shadowed) return undefined;
  let k = 0;
  while (words[k] && (words[k].text === "command" || words[k].text === "builtin") && !words[k].quoted) k++;
  const head = words[k]?.text ?? "";
  const name = trusted(head, "printf") ? "printf" : trusted(head, "echo") ? "echo" : "";
  if (!name || words.slice(k).some((w) => w.dyn || w.glob || w.subst || /[$`]/.test(w.text))) return undefined;
  const args = words.slice(k + 1).map((w) => w.text);
  if (name === "echo") {
    let e = false;
    let upper = false;
    while (/^-[neE]+$/.test(args[0] ?? "")) {
      const f = args.shift();
      e ||= f.includes("e");
      upper ||= f.includes("E");
    }
    const text = args.join(" ");
    if (upper && e) return undefined;
    // Without -e bash prints a backslash as it is and zsh decodes it: unknown.
    if (!e) return text.includes("\\") ? undefined : text;
    return decodeEscapes(text, "echo");
  }
  if (args[0] === "--") args.shift();
  if (!args.length || args[0].startsWith("-")) return undefined;
  return printfValue(args[0], args.slice(1));
}

/** The value of a command substitution that the guard can know, or undefined: printf / echo of literals, `pwd`, the repository root. */
function substValue(inner, ctx) {
  const state = { complex: false };
  const { segments, nested } = lexShell(inner, state);
  if (state.complex || nested.length || segments.length !== 1 || segments[0].redirs.length || segments[0].inputs.length) return undefined;
  const words = segments[0].words;
  let k = 0;
  while (words[k] && (words[k].text === "command" || words[k].text === "builtin") && !words[k].quoted) k++;
  const rest = words.slice(k + 1).map((w) => w.text);
  const plain = words.slice(k).every((w) => !w.dyn && !w.subst && !w.glob && !/[$`]/.test(w.text));
  if (!ctx.shadowed && plain && trusted(words[k]?.text ?? "", "pwd") && rest.every((a) => a === "-P" || a === "-L")) return ".";
  if (!ctx.shadowed && plain && k === 0 && words[0]?.text === "git" && rest.join(" ") === "rev-parse --show-toplevel") return ctx.root;
  const v = staticOutput(words, ctx.shadowed);
  // NUL bytes vanish from a substitution's output.
  return v === undefined || v.includes("\0") ? undefined : v.replace(/\n+$/, "");
}

/**
 * Replaces the substitutions of a word whose output is known by their value. The rest stay as SUBST;
 * `printf` is set when one of them is a printf or echo whose output is not known.
 */
function inlineSubst(w, ctx) {
  if (!w.subst || w.opaque) return w;
  const left = [];
  let printf = false;
  let k = 0;
  const text = w.text.replace(new RegExp(SUBST, "g"), () => {
    const inner = w.subst[k++];
    const v = inner === undefined ? undefined : substValue(inner, ctx);
    if (v !== undefined) {
      // A command that only prints a known value writes nothing, so it needs no check of its own.
      if (w.loose) w.loose = w.loose.filter((x) => x !== inner);
      return v;
    }
    left.push(inner);
    if (/^\s*(?:(?:command|builtin)\s+)?(?:[^\s/(`]*\/)*(?:printf|echo)(?![\w-])/.test(inner ?? "")) printf = true;
    return SUBST;
  });
  const out = { ...w, text, subst: left.length ? left : undefined, printf: w.printf || printf };
  if (!left.length) {
    out.dyn = false;
    if (/[*?[]/.test(text) && !w.quoted) out.glob = true;
  }
  return out;
}

/** `$NAME` / `${NAME}` replaced by the value assigned earlier in the line; `$IFS` / `${IFS}` become a space. */
function expandVars(text, vars, budget) {
  const spend = (v) => {
    budget.left -= v.length;
    return budget.left < 0 ? "" : v;
  };
  return text.replace(IFS_REF, () => spend(" ")).replace(VAR_REF, (m, a, b) => {
    const v = vars.get(a ?? b);
    return v === undefined ? m : spend(v);
  });
}

// Keywords after which a command runs only on some paths.
const BRANCH_KEYWORDS = new Set(["then", "else", "elif", "do"]);
const BRACE_GROUP = /(?<![$\\])\{([^{}]*)\}/g;
const MAX_BRACE_WORDS = 64;

// The first `{a,b}` group of a word, found without backtracking: `[^{}]*` cannot cross another brace.
function commaGroup(t) {
  for (const m of t.matchAll(BRACE_GROUP)) if (m[1].includes(",")) return m;
  return undefined;
}

/**
 * Brace expansion of a word with an unquoted `{` (`{r,}m` is `rm` and `m`). A `{x..y}` range stands for
 * anything, so it becomes a `*` glob (and the word is a glob). A word that would expand past the cap spends
 * the whole budget.
 */
function braceWords(w, budget) {
  if (!w.brace || ASSIGN_WORD.test(w.text)) return [w];
  const text = w.text.replace(BRACE_GROUP, (m, g) => (g.includes("..") ? "*" : m));
  const ranged = text !== w.text;
  let calls = 0;
  const expand = (t) => {
    const m = commaGroup(t);
    if (!m || ++calls > MAX_BRACE_WORDS) return [t];
    return m[1].split(",").flatMap((alt) => expand(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length)));
  };
  const out = expand(text);
  if (calls > MAX_BRACE_WORDS) {
    budget.left = -1;
    return [w];
  }
  if (out.length === 1 && !ranged) return [w];
  return out.map((t) => (ranged ? { ...w, text: t, glob: true } : { ...w, text: t }));
}

// A value that no longer fits is not cut (the dropped part would go unchecked): the whole line counts as too complex.
// Only text that grew through `$` expansion is capped: literal text is bounded by the command itself.
const fits = (value, budget, expanded) => {
  if (expanded && value.length > MAX_VAR_LENGTH) budget.left = -1;
  return value;
};

/**
 * Records `NAME=value` segments (also behind `export`) in `vars` and substitutes known variables into the
 * words and redirect targets of every other segment, splitting a word that expanded to several. A value
 * built at run time (`$(...)`, backticks), appended to (`+=`) or set by `getopts`, `mapfile`... is forgotten,
 * so `$NAME` stays unexpanded and the rules for variables of unknown value apply. `for NAME in a b` and
 * `read NAME <<< text` (also `while read NAME; do ...; done <<< text`, passed as `loopInput`) set NAME to
 * every value it can take; an assignment that runs only on some paths (`a && X=1 || X=2`, `then X=1`) adds
 * its value to the earlier ones instead of replacing them. A value that grew through `$` expansion past
 * MAX_VAR_LENGTH spends the budget; literal text is kept whole.
 * Words with an unquoted `{` are brace-expanded first. Returns false once the expansion budget is spent.
 */
function applyVars(seg, vars, budget, conditional = false, loopInput = undefined, ctx = { root: "/", shadowed: false }) {
  let from = 0;
  while (from < seg.words.length && KEYWORDS.has(seg.words[from].text)) from++;
  if (seg.words.slice(0, from).some((w) => BRANCH_KEYWORDS.has(w.text))) conditional = true;
  const lead = seg.words.slice(from);
  const rest = lead.length && ASSIGNING.has(lead[0].text) ? lead.slice(1) : lead;
  if (rest.length && rest.every((w) => ASSIGN_WORD.test(w.text))) {
    for (let w of rest) {
      // `X=$(printf ...)` with literal arguments is a known value.
      if (w.subst) w = inlineSubst(w, ctx);
      const m = ASSIGN_WORD.exec(w.text);
      const raw = w.text.slice(m[0].length);
      const value = expandVars(raw, vars, budget);
      const grew = raw.includes("$");
      const old = vars.get(m[1]);
      if (w.dyn || (m[2] && old === undefined)) vars.delete(m[1]);
      else if (m[2]) vars.set(m[1], fits(old + value, budget, grew));
      else if (conditional && old !== undefined && old !== value) vars.set(m[1], fits(`${old} ${value}`, budget, grew));
      else vars.set(m[1], fits(value, budget, grew));
    }
    return budget.left >= 0;
  }
  seg.words = seg.words.flatMap((w) => braceWords(w, budget));
  if (budget.left < 0) return false;
  const at = seg.words.findIndex((w) => !ASSIGN_WORD.test(w.text) && !KEYWORDS.has(w.text));
  const setter = at >= 0 && SETTERS.has(seg.words[at].text) ? seg.words[at].text : undefined;
  if (setter)
    for (const w of seg.words.slice(at + 1)) if (/^[A-Za-z_]\w*$/.test(w.text)) vars.delete(w.text);
  seg.words = seg.words.flatMap((w) => {
    if (w.subst) {
      w = inlineSubst(w, ctx);
      // An unquoted word that now has a known value splits on whitespace like an expanded variable.
      if (!w.subst && !w.quoted && /\s/.test(w.text)) return w.text.split(/\s+/).filter(Boolean).map((t) => ({ ...w, text: t, fromVar: true, glob: w.glob || /[*?[]/.test(t) }));
    }
    if (!w.text.includes("$")) return [w];
    const text = expandVars(w.text, vars, budget);
    if (text === w.text || budget.left < 0) return [w];
    const parts = text.split(/\s+/).filter(Boolean);
    return (parts.length ? parts : [""]).map((t) => ({ ...w, text: t, fromVar: true, glob: w.glob || /[*?[]/.test(t) }));
  });
  for (const r of seg.redirs) r.target = expandVars(r.target, vars, budget);
  for (const r of seg.inputs) r.target = expandVars(r.target, vars, budget);
  const names = seg.words.slice(at + 1).filter((w) => /^[A-Za-z_]\w*$/.test(w.text));
  if (setter === "for" && seg.words[at + 2]?.text === "in") {
    const items = seg.words.slice(at + 3);
    if (!items.some((w) => w.dyn || w.text.includes("$"))) vars.set(seg.words[at + 1].text, fits(items.map((w) => w.text).join(" "), budget, items.some((w) => w.fromVar)));
  } else if (setter === "read") {
    const here = seg.inputs.find((x) => x.op === "<<<") ?? (loopInput ? { target: expandVars(loopInput.target, vars, budget), dyn: loopInput.dyn } : undefined);
    if (here && !here.dyn && !here.target.includes("$")) for (const n of names) vars.set(n.text, fits(here.target, budget, false));
  }
  return budget.left >= 0;
}

/** For each `while` / `until` segment, the here-string on the `done` that closes it (`while read X; do ...; done <<< text`). */
function loopInputs(segments) {
  const out = new Map();
  const open = [];
  segments.forEach((seg, idx) => {
    const first = seg.words.find((w) => w.text !== "do" && w.text !== "then")?.text;
    if (first === "while" || first === "until" || first === "for" || first === "select") open.push(idx);
    else if (seg.words[0]?.text === "done") {
      const head = open.pop();
      const here = seg.inputs.find((x) => x.op === "<<<");
      if (head !== undefined && here) out.set(head, here);
    }
  });
  return out;
}

/**
 * The commands and redirects of a shell command line, each with the directories it may run in.
 * `bases` are absolute and grow linearly: the project root, the chain of every `cd` / `pushd` target
 * assuming each succeeds, and every target resolved against the root alone (a `cd` can fail).
 * `tight` is the directory after the latest `cd` chained with `&&` or `;` (a `cd x || cmd` keeps it).
 * `tooComplex` is set past MAX_CDS directory changes or MAX_COMMAND_LENGTH characters.
 * @param {string} cmd
 * @param {string} root
 * @param {(t: string) => string} [expand] applied to every path word (home, case folding)
 * @param {(t: string) => string} [fold] applied to command names
 * @param {{ vars: Map<string, string>, budget: { left: number }, bases?: string[], tight?: string[], chain?: string }} [outer]
 *   variables assigned before this string runs (`X=a; bash -c 'rm $X'`), the substitution budget shared with the strings
 *   around it, and, for a `$(...)` in the middle of a line, the directories it runs in
 */
export function targetsOf(cmd, root, expand = (t) => t, fold = (t) => t, outer = { vars: new Map(), budget: { left: MAX_EXPANSION } }) {
  const vars = new Map(outer.vars);
  const { budget } = outer;
  const commands = [];
  const redirects = [];
  const segments = [];
  if (cmd.length > MAX_COMMAND_LENGTH || budget.left < 0) return { commands, redirects, segments, nested: [], vars, budget, tooComplex: true };
  const parsed = shellSegments(cmd);
  if (parsed.complex) return { commands, redirects, segments, nested: [], vars, budget, tooComplex: true };
  let chain = outer.chain ?? root;
  let bases = outer.bases ? [...outer.bases] : [root];
  // `tight` is where a command really runs, and it is conservative: a `cd` narrows it only for the commands joined to it by `&&`
  // (a `;` after it runs even when the `cd` failed), and only to a literal folder. A `cd` that is skipped, in a subshell, in a
  // pipe, or followed by `popd`, a CDPATH assignment or `ln -s` leaves it at the folder the line started in.
  const baseTight = outer.tight ? [...outer.tight] : [root];
  let tight = baseTight;
  const noNarrow = parsed.segments.some((seg) =>
    seg.words.some((w, k) => {
      const name = fold(baseName(w.text));
      return /^CDPATH=/.test(w.text) || w.text === "CDPATH" || name === "popd" || (name === "ln" && seg.words.slice(k + 1).some((x) => /^-[A-Za-z]*s|^--symbolic/.test(x.text)));
    }),
  );
  const pwdSet = parsed.segments.some((seg) => seg.words.some((w) => /^PWD\+?=/.test(w.text)));
  const pwd = (t) => (pwdSet ? t : pwdWord(t));
  const shadowed = SHADOWS.test(cmd);
  // Substitutions outside double quotes, each with the directories it runs in.
  const loose = [];
  let cds = 0;
  let pipeStart = 0;
  let prevSep = "";
  const loops = loopInputs(parsed.segments);
  for (const [n, seg] of parsed.segments.entries()) {
    const conditional = prevSep === "&&" || prevSep === "||";
    if (prevSep !== "&&") tight = baseTight;
    prevSep = seg.sep;
    if (!applyVars(seg, vars, budget, conditional, loops.get(n), { root, shadowed })) return { commands, redirects, segments, nested: [...parsed.nested, ...loose], vars, budget, tooComplex: true };
    for (const r of seg.redirs) redirects.push({ op: r.op, target: r.target, bases });
    for (const w of seg.words) if (w.loose) for (const text of w.loose) loose.push({ text, bases, tight, chain });
    const found = commandsOf(seg.words, fold);
    const bodies = seg.heredocs.map((h) => h.body);
    segments.push({ words: seg.words, redirs: seg.redirs, inputs: seg.inputs, procSub: seg.procSub, pipeStart, bases, tight, name: found[0]?.name, sep: seg.sep, bodies });
    if (seg.sep !== "|") pipeStart = segments.length;
    for (const c of found) {
      commands.push({ ...c, bases, tight });
      if (c.name !== "cd" && c.name !== "pushd") continue;
      const dir = splitArgs(c.args).operands[0];
      const text = dir && pwd(dir.text);
      if (seg.sep === "&&") tight = !noNarrow && text !== undefined && literalDir(text) ? tight.map((t) => path.resolve(t, expand(text))) : baseTight;
      if (!dir || dir.text === "-") continue;
      if (++cds > MAX_CDS) return { commands, redirects, segments, nested: [...parsed.nested, ...loose], vars, budget, tooComplex: true };
      chain = path.resolve(chain, expand(text));
      bases = [...new Set([...bases, chain, path.resolve(root, expand(text))])];
    }
  }
  const checked = new Set();
  for (const [idx, seg] of segments.entries()) {
    seg.scriptBodies = [];
    seg.codeBodies = [];
    if (!seg.bodies.length) continue;
    // A heredoc body is data only for a known sink: cat/tee/read-only tools (piped only into read-only
    // tools or tee), `git commit -F -`, `gh ... --body-file -`. Any other consumer runs it as a script.
    const pipe = [];
    for (let j = idx; segments[j]?.sep === "|" && segments[j + 1]; j++) pipe.push(segments[j + 1]);
    const sink =
      (knownSafe(seg, fold) || seg.name === "tee" || readsStdinAsData(seg)) &&
      pipe.every((x) => knownSafe(x, fold) || x.name === "tee");
    if (sink) {
      // A sink that writes a file which a later command in the same line runs: the body is that script.
      const targets = writtenTargets(seg, fold);
      const runner = targets.length ? segments.slice(idx + 1).find((x) => runs(x, targets, fold)) : undefined;
      if (!runner) continue;
      for (const t of targets) checked.add(t);
      seg.scriptBodies = seg.bodies;
      if (runner.words.some((w) => !w.quoted && INTERPRETERS.test(fold(baseName(w.text))))) seg.codeBodies = seg.bodies;
      continue;
    }
    seg.scriptBodies = seg.bodies;
    const interp = [seg, ...pipe].some((x) => x.words.some((w) => !w.quoted && INTERPRETERS.test(fold(baseName(w.text)))));
    if (interp) seg.codeBodies = seg.bodies;
  }
  return { commands, redirects, segments, nested: [...parsed.nested, ...loose], checked, vars, budget, shadowed, tooComplex: false };
}
