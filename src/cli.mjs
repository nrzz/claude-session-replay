// claude-replay: find anything in your past Claude Code sessions, and turn a session into a
// self-contained HTML replay or Markdown. Commands: list, search, export, open.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { findById, findSessions, projectsDir, scanSession } from "./claude.mjs";
import { markWords, parseWords, searchSessions } from "./search.mjs";
import { replayFile } from "./replay.mjs";
import { describeCounts, findSecrets } from "./redact.mjs";
import { DEFAULT_MAX_OUTPUT } from "./session.mjs";
import { UserError, baseName, cmp, fail, isDir, kb, localStamp, makeColors, oneLine, plural } from "./util.mjs";
import { REPO_URL, VERSION } from "./version.mjs";

const THEMES = ["auto", "light", "dark"];
const LARGE_EXPORT = 15 * 1048576; // an export bigger than this gets a hint about making it smaller
const AMBIGUOUS_RATIO = 1.5; // the best match must score this many times the next one to be taken without asking

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

const EXPORT_FLAGS = ["redact", "no-tools", "no-thinking", "no-images", "all"];
const COMMANDS = {
  list: { run: cmdList, bool: ["all"], value: ["project", "limit"] },
  search: { run: cmdSearch, bool: ["all", "deep"], value: ["project", "limit"] },
  export: { run: cmdExport, bool: [...EXPORT_FLAGS, "html", "md"], value: ["out", "theme", "max-output", "project"] },
  open: { run: cmdOpen, bool: [...EXPORT_FLAGS, "dry-run"], value: ["theme", "max-output", "project"] },
};
COMMANDS.ls = COMMANDS.list;

export function parseArgs(argv, spec) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    if (a === "-h" || a === "--help") { args.help = true; continue; }
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (spec.bool.includes(key)) {
      if (eq > 0) fail(`--${key} does not take a value.`);
      args[key] = true;
    } else if (spec.value.includes(key)) {
      if (eq > 0) args[key] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else fail(`--${key} needs a value.`);
    } else fail(`Unknown option --${key}. Run claude-replay --help for the options.`);
  }
  return args;
}

function intOption(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} needs a whole number, 1 or more.`);
  return n;
}

// --max-output: kilobytes (20), or with a unit (64k, 1m); 0 keeps everything. Returns characters.
export function parseMaxOutput(value) {
  if (value === undefined) return DEFAULT_MAX_OUTPUT;
  const m = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb)?$/i.exec(String(value).trim());
  if (!m) fail("--max-output needs a size in KB, like 20, 64k or 1m (0 keeps all output).");
  return Math.round(Number(m[1]) * (/^m/i.test(m[2] || "") ? 1024 : 1) * 1024);
}

function scopeOf(args, ctx) {
  if (args.all) return { all: true, root: "", label: "all projects" };
  const root = args.project ? path.resolve(ctx.cwd, args.project) : ctx.cwd;
  return { all: false, root, label: root };
}

const dateOf = (iso) => (Number.isFinite(Date.parse(iso)) ? localStamp(new Date(Date.parse(iso))).slice(0, 10) : "          ");
const id8 = (id) => id.slice(0, 8);

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

function cmdList(args, ctx) {
  const { c } = ctx;
  const limit = intOption(args.limit, 20, "--limit");
  const scope = scopeOf(args, ctx);
  const found = findSessions({ env: ctx.env, root: scope.root, all: scope.all });
  const rows = [];
  let examined = 0;
  for (const e of found) {
    if (rows.length >= limit) break;
    examined++;
    const info = scanSession(e.file);
    if (!info.prompts && !info.hasAssistant) continue; // nothing was said in it
    rows.push({ e, info });
  }
  if (!rows.length) {
    ctx.say(`No Claude Code sessions found for ${scope.label} (looked in ${projectsDir(ctx.env)}).`);
    if (!scope.all) ctx.say(c.dim("Use --all to list every project's sessions."));
    return 0;
  }
  const total = rows.length + (found.length - examined); // the files left unread are counted as sessions
  ctx.say(c.bold(scope.all ? "Sessions in all projects" : `Sessions in ${scope.label}`) + c.dim(`  (${rows.length}${total > rows.length ? ` of ${total}` : ""}, newest first)`));
  const projects = rows.map(({ e, info }) => baseName(info.cwd || e.cwd));
  const projectWidth = scope.all ? Math.min(24, Math.max(...projects.map((p) => p.length))) : 0;
  const room = Math.max(24, ctx.columns - 2 - 8 - 2 - 16 - 2 - 7 - 2 - 8 - 2 - (scope.all ? projectWidth + 2 : 0));
  const titles = rows.map(({ info }) => oneLine(info.title, room));
  const titleWidth = Math.max(...titles.map((t) => t.length));
  ctx.say(c.dim(`  ${"ID".padEnd(8)}  ${"LAST ACTIVITY".padEnd(16)}  ${"PROMPTS".padStart(7)}  ${"SIZE".padStart(8)}  TITLE`));
  rows.forEach(({ e, info }, i) => {
    const when = Number.isFinite(Date.parse(e.updated)) ? localStamp(new Date(Date.parse(e.updated))) : "";
    const project = scope.all ? `  ${c.dim(projects[i])}` : "";
    ctx.say(`  ${c.cyan(id8(e.id))}  ${when.padEnd(16)}  ${String(info.prompts).padStart(7)}  ${kb(e.size).padStart(8)}  ${scope.all ? titles[i].padEnd(titleWidth) : titles[i]}${project}`);
  });
  return 0;
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

const KIND_LABEL = { title: "title", you: "you", claude: "claude", tool: "tool", output: "output" };

function printHit(hit, words, ctx, scope) {
  const { c } = ctx;
  const info = scanSession(hit.entry.file);
  const title = hit.title || info.title;
  const project = scope.all ? `  ${c.dim(baseName(info.cwd))}` : "";
  const date = dateOf(hit.snippet?.ts || hit.entry.updated);
  ctx.say(`${c.cyan(id8(hit.entry.id))}  ${date}  ${markWords(oneLine(title, 100), words, c.hit)}${project}`);
  if (hit.snippet) ctx.say(`    ${c.dim(KIND_LABEL[hit.snippet.kind].padEnd(6))} ${markWords(hit.snippet.text, words, c.hit)}`);
}

function cmdSearch(args, ctx) {
  const words = parseWords(args._);
  if (!words.length) fail("Give one or more words to search for, for example: claude-replay search stripe webhook");
  const limit = intOption(args.limit, 10, "--limit");
  const scope = scopeOf(args, ctx);
  const entries = findSessions({ env: ctx.env, root: scope.root, all: scope.all });
  const hits = searchSessions(entries, words, { deep: !!args.deep });
  const where = scope.all ? "any project" : "this project";
  if (!hits.length) {
    ctx.say(`No session in ${where} has all of: ${words.join(" ")}${args.deep ? "" : " (--deep also searches tool output)"}.`);
    if (!scope.all) ctx.say(ctx.c.dim("Use --all to search every project."));
    return 1;
  }
  ctx.say(ctx.c.bold(`${plural(hits.length, "session")} in ${where} with all of: ${words.join(" ")}`) + ctx.c.dim(hits.length > limit ? `  (best ${limit})` : ""));
  for (const hit of hits.slice(0, limit)) printHit(hit, words, ctx, scope);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Finding the session an id or some words stand for
// ---------------------------------------------------------------------------------------------

function listCandidates(entries, ctx, scope) {
  for (const e of entries.slice(0, 8)) {
    const info = scanSession(e.file);
    ctx.warn(`  ${ctx.c.cyan(id8(e.id))}  ${dateOf(info.updated || e.updated)}  ${oneLine(info.title, 70)}${scope.all ? `  ${ctx.c.dim(baseName(info.cwd))}` : ""}`);
  }
}

// An id (full, or a unique prefix of 6 or more characters) finds its session in any project.
// Anything else is words: the best search hit wins when it clearly beats the others, otherwise the
// candidates are listed and the command stops.
export function resolveSession(ref, args, ctx) {
  const scope = scopeOf(args, ctx);
  if (/^[0-9a-f][0-9a-f-]{5,35}$/i.test(ref)) {
    const byId = findById(ref, ctx.env);
    if (byId.length === 1) return byId[0];
    // The same session id in two places (a project folder that was moved): the newer file is the one.
    if (byId.length > 1 && byId.every((e) => e.id === byId[0].id)) return byId.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (byId.length > 1) {
      ctx.warn(`${plural(byId.length, "session")} start with ${ref}:`);
      listCandidates(byId, ctx, { all: true });
      fail("That id is ambiguous. Use more of it.");
    }
  }
  const words = parseWords(ref);
  if (!words.length) fail("Which session? Give its id (claude-replay list shows them) or some words from it.");
  const hits = searchSessions(findSessions({ env: ctx.env, root: scope.root, all: scope.all }), words);
  if (!hits.length) fail(`No session ${scope.all ? "in any project" : "in this project"} has all of: ${words.join(" ")}.${scope.all ? "" : " Use --all to look in every project."}`);
  const [first, second] = hits;
  if (!second || first.score >= second.score * AMBIGUOUS_RATIO) return first.entry;
  ctx.warn(`${plural(hits.length, "session")} match "${ref}" about equally well. The best ones:`);
  listCandidates(hits.slice(0, 8).map((h) => h.entry), ctx, scope);
  return fail("Name one by its id (the first column).");
}

// ---------------------------------------------------------------------------------------------
// export and open
// ---------------------------------------------------------------------------------------------

function replayOptions(args, ctx) {
  const theme = args.theme === undefined ? "auto" : String(args.theme).toLowerCase();
  if (!THEMES.includes(theme)) fail(`--theme must be one of ${THEMES.join(", ")}.`);
  return {
    redact: !!args.redact,
    tools: !args["no-tools"],
    thinking: !args["no-thinking"],
    images: !args["no-images"],
    maxOutput: parseMaxOutput(args["max-output"]),
    theme,
    env: ctx.env,
  };
}

function pickFormat(args) {
  if (args.html && args.md) fail("Choose --html or --md, not both.");
  if (args.md) return "md";
  if (args.html) return "html";
  return /\.(md|markdown)$/i.test(String(args.out || "")) ? "md" : "html";
}

function buildReplay(args, ctx, format) {
  const ref = args._.join(" ").trim();
  if (!ref) fail("Which session? Give its id (claude-replay list shows them) or some words from it.");
  const entry = resolveSession(ref, args, ctx);
  const result = replayFile(entry.file, { ...replayOptions(args, ctx), format });
  return { entry, ...result };
}

// With --redact: what was replaced or dropped. Without it: a warning when the export still holds
// anything that looks like a secret.
function reportRedaction(args, result, ctx) {
  if (args.redact) { ctx.warn(`claude-replay: redaction: ${describeCounts(result.display.counts)}`); return; }
  const found = Object.entries(findSecrets(result.text)).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  if (!found.length) return;
  const total = found.reduce((n, [, count]) => n + count, 0);
  ctx.warn(`claude-replay: warning: this export contains ${total} likely secret${total === 1 ? "" : "s"} (${found.map(([k, n]) => `${k} ${n}`).join(", ")}). Export again with --redact before sharing it.`);
}

// A very large page is slow to open and awkward to share: say what shrinks it.
function noteSize(bytes, ctx) {
  if (bytes > LARGE_EXPORT) ctx.warn(`claude-replay: note: the file is ${kb(bytes)}. --max-output 4 or --no-tools makes it much smaller.`);
}

function cmdExport(args, ctx) {
  const format = pickFormat(args);
  const built = buildReplay(args, ctx, format);
  const bytes = Buffer.byteLength(built.text);
  const summary = `${kb(bytes)}, ${plural(built.session.counts.turns, "turn")}, ${plural(built.session.counts.toolCalls, "tool call")}`;
  if (args.out === "-") {
    ctx.out(built.text);
    ctx.warn(`claude-replay: wrote ${format === "md" ? "Markdown" : "HTML"} to standard output (${summary})`);
  } else {
    const name = `claude-session-${id8(built.entry.id)}.${format}`;
    let file = path.resolve(ctx.cwd, args.out || name);
    // --out docs/ (or a folder that exists) means: put the default file name in it.
    if (args.out && (/[\\/]$/.test(args.out) || isDir(file))) file = path.join(file, name);
    if (path.resolve(file).toLowerCase() === path.resolve(built.entry.file).toLowerCase()) fail("--out is the session's own transcript; choose another file.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, built.text);
    ctx.say(`Wrote ${file} (${summary})`);
  }
  reportRedaction(args, built, ctx);
  noteSize(bytes, ctx);
  return 0;
}

// The command that opens a file in the default browser.
export function openCommand(platform, file) {
  if (platform === "win32") return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${file}"`], options: { windowsVerbatimArguments: true } };
  if (platform === "darwin") return { cmd: "open", args: [file], options: {} };
  return { cmd: "xdg-open", args: [file], options: {} };
}

function launch({ cmd, args, options }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, ...options }); } catch (e) { reject(e); return; }
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function cmdOpen(args, ctx) {
  const built = buildReplay(args, ctx, "html");
  // A fresh folder with a name nobody can guess, so another user of a shared temp folder cannot
  // plant a link there for the file to be written through.
  const file = path.join(fs.mkdtempSync(path.join(ctx.tmpdir, "claude-replay-")), `claude-session-${id8(built.entry.id)}.html`);
  fs.writeFileSync(file, built.text);
  reportRedaction(args, built, ctx);
  noteSize(Buffer.byteLength(built.text), ctx);
  const command = openCommand(ctx.platform, file);
  if (args["dry-run"]) {
    ctx.say(`Wrote ${file} (${kb(Buffer.byteLength(built.text))})`);
    ctx.say(`Would run: ${command.cmd} ${command.args.join(" ")}`);
    return 0;
  }
  try {
    await launch(command);
  } catch (e) {
    ctx.warn(`${ctx.c.red("✗")} Could not start ${command.cmd} (${e.code || e.message}). The replay is at ${file}; open it in a browser yourself.`);
    return 1;
  }
  ctx.say(`Opened ${file} in your browser (${kb(Buffer.byteLength(built.text))}).`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const helpText = (c) => `${c.bold("claude-replay")} ${VERSION}: find anything in your past Claude Code sessions, and turn a session into a replay.

${c.bold("Find")}
  claude-replay list [--project <dir> | --all] [--limit 20]
  claude-replay search <words> [--all] [--deep] [--limit 10]     every word must match

${c.bold("Share")}
  claude-replay export <id|words> [--html | --md] [--out <file>] [--redact]
                       [--no-tools] [--no-thinking] [--no-images]
                       [--theme dark|light|auto] [--max-output <KB>]
  claude-replay open <id|words>                                  export, then open in the browser

<id> is a session id or the first 6 or more characters of one; <words> picks the best matching session.
Sessions are the ones whose folder is the current project; --all (or --project <dir>) changes that.
Export writes ./claude-session-<id8>.html (or .md); --out - prints to standard output.
--redact replaces secrets, shortens paths to the project, and leaves out thinking and images.
Tool output is cut at 20 KB each (--max-output 64 keeps more, 0 keeps everything).
Sessions are read from $CLAUDE_CONFIG_DIR/projects, or ~/.claude/projects. Nothing is sent anywhere.
${REPO_URL}`;

export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const tty = io.tty ?? !!process.stdout.isTTY;
  const ctx = {
    cwd: io.cwd || process.cwd(),
    env,
    tty,
    columns: io.columns ?? process.stdout.columns ?? 100,
    platform: io.platform || process.platform,
    tmpdir: io.tmpdir || os.tmpdir(),
    c: makeColors(env, tty),
    out: io.out || ((s) => process.stdout.write(s)),
    err: io.err || ((s) => process.stderr.write(s)),
  };
  ctx.say = (s = "") => ctx.out(`${s}\n`);
  ctx.warn = (s = "") => ctx.err(`${s}\n`);
  try {
    const [name, ...rest] = argv;
    if (!name || name === "help" || name === "--help" || name === "-h") { ctx.say(helpText(ctx.c)); return 0; }
    if (name === "--version" || name === "-v" || name === "version") { ctx.say(VERSION); return 0; }
    const command = COMMANDS[name];
    if (!command) { ctx.warn(`${ctx.c.red("✗")} Unknown command "${name}".`); ctx.warn(helpText(ctx.c)); return 1; }
    const args = parseArgs(rest, command);
    if (args.help) { ctx.say(helpText(ctx.c)); return 0; }
    return (await command.run(args, ctx)) ?? 0;
  } catch (err) {
    if (err instanceof UserError) { ctx.warn(`${ctx.c.red("✗")} ${err.message}`); return 1; }
    ctx.warn(`${ctx.c.red("✗")} claude-replay hit an unexpected error: ${err?.stack || err}`);
    return 2;
  }
}
