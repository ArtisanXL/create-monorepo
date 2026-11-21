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
      if (m && code <= 0x10ffff) text += String.fromCodePoint(code);
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
      if (p.op === "<" || p.op === "<<<") inputs.push({ op: p.op, target: w.text });
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
  // Arithmetic (`$((..))`, `$[..]`) and backticks are scanned for commands; returns the new index.
  const expansion = (i) => {
    grow().dyn = true;
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
  let i = from;
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i++;
      else if (i + 1 < cmd.length) grow().text += cmd[++i];
    } else if (c === "$" && cmd[i + 1] === "'") {
      const r = ansiC(cmd, i + 2);
      grow().quoted = true;
      cur.text += r.text;
      i = r.end;
    } else if (c === "$" && cmd[i + 1] === '"') {
      // $"..." quotes like "...": drop the $.
    } else if (c === "$" && ((cmd[i + 1] === "(" && cmd[i + 2] === "(") || cmd[i + 1] === "[")) {
      i = expansion(i);
      grow().text += "0";
    } else if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      const stop = e < 0 ? cmd.length : e;
      grow().quoted = true;
      cur.text += cmd.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      grow().quoted = true;
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "\\" && '"\\$`'.includes(cmd[i + 1] ?? "")) i++;
        else if (cmd[i] === "$" && ((cmd[i + 1] === "(" && cmd[i + 2] === "(") || cmd[i + 1] === "[")) {
          i = expansion(i);
          continue;
        } else if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const e = closeParen(cmd, i + 1, state, level);
          nested.push(cmd.slice(i + 2, e));
          cur.dyn = true;
          i = e;
          continue;
        } else if (cmd[i] === "`") {
          let e = i + 1;
          while (e < cmd.length && cmd[e] !== "`") e += cmd[e] === "\\" ? 2 : 1;
          nested.push(cmd.slice(i + 1, e));
          cur.dyn = true;
          i = e;
          continue;
        }
        cur.text += cmd[i];
      }
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
    } else if (c === "(") {
      if (cur?.text.endsWith("$")) cur.dyn = true;
      depth++;
      end(";");
    } else if (c === ")") {
      if (stopAtClose && depth === 0) break;
      depth = Math.max(0, depth - 1);
      end(";");
    } else if (c === "`") {
      // An unquoted backtick ends the word but leaves its value to run time (`X=`cmd``).
      if (cur !== null) cur.dyn = true;
      end(";");
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
    } else grow().text += c;
  }
  end("");
  return { segments, nested, end: i };
}

const shellSegments = (cmd) => {
  const state = { complex: false };
  const { segments, nested } = lexShell(cmd, state);
  return { segments, nested, complex: state.complex };
};

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

/**
 * Records `NAME=value` segments (also behind `export`) in `vars` and substitutes known variables into the
 * words and redirect targets of every other segment, splitting a word that expanded to several. A value
 * built at run time (`$(...)`, backticks), appended to (`+=`) or set by `read`, `getopts`, `for`... is
 * forgotten, so `$NAME` stays unexpanded and the rules for variables of unknown value apply.
 * Returns false once the expansion budget is spent.
 */
function applyVars(seg, vars, budget) {
  const first = seg.words[0]?.text;
  const rest = first !== undefined && ASSIGNING.has(first) ? seg.words.slice(1) : seg.words;
  if (rest.length && rest.every((w) => ASSIGN_WORD.test(w.text))) {
    for (const w of rest) {
      const m = ASSIGN_WORD.exec(w.text);
      const value = expandVars(w.text.slice(m[0].length), vars, budget);
      if (w.dyn || (m[2] && !vars.has(m[1]))) vars.delete(m[1]);
      else vars.set(m[1], ((m[2] ? vars.get(m[1]) : "") + value).slice(0, MAX_VAR_LENGTH));
    }
    return budget.left >= 0;
  }
  const at = seg.words.findIndex((w) => !ASSIGN_WORD.test(w.text) && !KEYWORDS.has(w.text));
  if (at >= 0 && SETTERS.has(seg.words[at].text))
    for (const w of seg.words.slice(at + 1)) if (/^[A-Za-z_]\w*$/.test(w.text)) vars.delete(w.text);
  seg.words = seg.words.flatMap((w) => {
    if (!w.text.includes("$")) return [w];
    const text = expandVars(w.text, vars, budget);
    if (text === w.text || budget.left < 0) return [w];
    const parts = text.split(/\s+/).filter(Boolean);
    return (parts.length ? parts : [""]).map((t) => ({ ...w, text: t, fromVar: true }));
  });
  for (const r of seg.redirs) r.target = expandVars(r.target, vars, budget);
  for (const r of seg.inputs) r.target = expandVars(r.target, vars, budget);
  return budget.left >= 0;
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
 * @param {{ vars: Map<string, string>, budget: { left: number } }} [outer] variables assigned before this string
 *   runs (`X=a; bash -c 'rm $X'`) and the substitution budget shared with the strings around it
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
  let chain = root;
  let bases = [root];
  let tight = [root];
  let cds = 0;
  let pipeStart = 0;
  for (const seg of parsed.segments) {
    if (!applyVars(seg, vars, budget)) return { commands, redirects, segments, nested: parsed.nested, vars, budget, tooComplex: true };
    for (const r of seg.redirs) redirects.push({ op: r.op, target: r.target, bases });
    const found = commandsOf(seg.words, fold);
    const bodies = seg.heredocs.map((h) => h.body);
    segments.push({ words: seg.words, redirs: seg.redirs, inputs: seg.inputs, procSub: seg.procSub, pipeStart, bases, tight, name: found[0]?.name, sep: seg.sep, bodies });
    if (seg.sep !== "|") pipeStart = segments.length;
    for (const c of found) {
      commands.push({ ...c, bases, tight });
      if (c.name !== "cd" && c.name !== "pushd") continue;
      const dir = splitArgs(c.args).operands[0];
      if (!dir || dir.text === "-") continue;
      if (++cds > MAX_CDS) return { commands, redirects, segments, nested: parsed.nested, vars, budget, tooComplex: true };
      chain = path.resolve(chain, expand(dir.text));
      bases = [...new Set([...bases, chain, path.resolve(root, expand(dir.text))])];
      if (seg.sep === "&&" || seg.sep === ";") tight = [chain];
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
  return { commands, redirects, segments, nested: parsed.nested, checked, vars, budget, tooComplex: false };
}
