// Where Claude Code keeps sessions, what is in a transcript record, and how to list sessions.
//
// <configDir>/projects/<slug>/<sessionId>.jsonl         one session, one JSON object per line
// <configDir>/projects/<slug>/<sessionId>/subagents/    transcripts of the subagents it started
// <configDir>/projects/<slug>/<sessionId>/tool-results/ big tool outputs, stored next to the session
// configDir is $CLAUDE_CONFIG_DIR, or ~/.claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmp, forEachLine, listDir, oneLine, readTailText, tryParse } from "./util.mjs";

const IS_WIN = process.platform === "win32";

export function homeDir(env = process.env) {
  const fromEnv = IS_WIN ? env.USERPROFILE || env.HOME : env.HOME;
  return fromEnv || os.homedir();
}
export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir(env), ".claude");
}
export const projectsDir = (env = process.env) => path.join(claudeDir(env), "projects");

// The folder name Claude Code uses under projects/ for a working directory: every character that
// is not a letter or digit becomes "-", and names over 200 characters are cut and suffixed with a
// hash of the full path (same algorithm as Claude Code 2.1.x).
export function projectSlug(p) {
  const s = String(p).replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

// Is p the folder `root` or somewhere below it? Windows spellings compare without regard to case
// and with either slash, whatever OS this runs on.
const looksWindows = (s) => /^[a-zA-Z]:[\\/]|^\\\\/.test(s);
export function isInside(root, p) {
  if (!root || !p) return false;
  const win = looksWindows(root) || looksWindows(p);
  const api = win ? path.win32 : path.posix;
  let a = api.normalize(root);
  let b = api.normalize(p);
  if (win) { a = a.toLowerCase(); b = b.toLowerCase(); }
  const rel = api.relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

// ---------------------------------------------------------------------------------------------
// User records: what the person typed, and what Claude Code wrote in their name
// ---------------------------------------------------------------------------------------------

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// A block that is one injected element such as <ide_opened_file>...</ide_opened_file> or
// <task-notification>...: lowercase name with a "-" or "_", opened and closed around the whole block.
const WRAPPER = /^<([a-z][a-z0-9]*[-_][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;

export function classifyText(raw) {
  const t = String(raw).replace(REMINDER, "").trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*([^<]*?)\s*<\/command-name>/))) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return { kind: "command", name: m[1], args: args ? args[1].trim() : "" };
  }
  if ((m = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/))) return { kind: "bash", command: m[1].trim() };
  if (/^<bash-(?:stdout|stderr)>/.test(t)) {
    const out = t.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
    const err = t.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
    return { kind: "bash-output", stdout: out ? out[1] : "", stderr: err ? err[1] : "" };
  }
  if (/^<local-command-(?:stdout|stderr)>/.test(t)) {
    const parts = [...t.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)];
    return { kind: "command-output", text: parts.map((x) => x[1].trim()).filter(Boolean).join("\n") };
  }
  if (WRAPPER.test(t) || /^Caveat:/.test(t)) return { kind: "skip" };
  if (/^\[Request interrupted/.test(t)) return { kind: "interrupt", text: t };
  return { kind: "prompt", text: t };
}

// What a user record is. kind is one of:
//   prompt (text, images)   something the person typed or pasted
//   command (name, args)    a slash command
//   bash (command)          a "!" shell command typed at the prompt
//   bash-output, command-output, interrupt   what Claude Code wrote in reply to those
//   summary (text)          the summary a compaction carried over
//   meta, skip, tool-results, none   nothing to show as a turn
export function classifyUser(rec) {
  if (!rec || rec.type !== "user") return { kind: "none" };
  const content = rec.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  if (rec.isCompactSummary) {
    const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    return { kind: "summary", text };
  }
  if (rec.isMeta) return { kind: "meta" };
  const texts = [];
  const images = [];
  let special = null;
  let results = false;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "image" || b.type === "document") images.push(b);
    else if (b.type === "tool_result") results = true;
    else if (b.type === "text" && typeof b.text === "string") {
      const c = classifyText(b.text);
      if (!c || c.kind === "skip") continue;
      if (c.kind === "prompt") texts.push(c.text);
      else if (!special) special = c;
    }
  }
  if (special) return special;
  if (texts.length || images.length) return { kind: "prompt", text: texts.join("\n\n"), images };
  return { kind: results ? "tool-results" : "skip" };
}

export const isPromptKind = (c) => c.kind === "prompt" || c.kind === "command" || c.kind === "bash";

// What the person typed, as text: "/cmd args" for slash commands and "! cmd" for shell commands,
// or "" for everything that is not a prompt.
export function promptOf(c) {
  if (c.kind === "prompt") return c.text;
  if (c.kind === "command") return `${c.name}${c.args ? ` ${c.args}` : ""}`;
  if (c.kind === "bash") return `! ${c.command}`;
  return "";
}
export const promptText = (rec) => promptOf(classifyUser(rec));

// A title stored in the transcript, or "". custom-title (set with /rename) beats ai-title.
export function titleRecord(rec) {
  if (rec.type === "custom-title" && rec.customTitle) return { custom: String(rec.customTitle) };
  if (rec.type === "ai-title" && rec.aiTitle) return { ai: String(rec.aiTitle) };
  // Older versions stored a short summary line as the title. A long one is a compaction summary.
  if (rec.type === "summary" && typeof rec.summary === "string" && rec.summary.length <= 160) return { summary: rec.summary };
  return null;
}
export const pickTitle = (t, firstPrompt = "") => t.custom || t.ai || t.summary || oneLine(firstPrompt, 70) || "(untitled session)";

// ---------------------------------------------------------------------------------------------
// Looking at a session file without reading all of it
// ---------------------------------------------------------------------------------------------

const TIMESTAMP = /"timestamp":"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/g;
// The newest timestamp near the end of the file ("" when there is none).
export function lastTimestamp(file) {
  for (const bytes of [64 * 1024, 1024 * 1024]) {
    const tail = readTailText(file, bytes);
    let last = "";
    TIMESTAMP.lastIndex = 0;
    for (let m = TIMESTAMP.exec(tail); m; m = TIMESTAMP.exec(tail)) last = m[1];
    if (last) return last;
    if (tail.length < bytes) break; // that was the whole file
  }
  return "";
}

// Working directory, branch and start time, from the first records.
export function quickMeta(file) {
  const meta = { cwd: "", branch: "", started: "" };
  let seen = 0;
  forEachLine(file, (line) => {
    const rec = tryParse(line);
    if (rec) {
      if (!meta.cwd && typeof rec.cwd === "string") meta.cwd = rec.cwd;
      if (!meta.branch && typeof rec.gitBranch === "string") meta.branch = rec.gitBranch;
      if (!meta.started && rec.cwd && rec.timestamp) meta.started = rec.timestamp;
    }
    return !(meta.cwd && meta.started) && ++seen < 200;
  });
  return meta;
}

// Everything `list` shows, by reading the whole file once. Lines that cannot matter (tool results,
// the bulk of a session) are skipped by a cheap text test before any JSON is parsed.
export function scanSession(file) {
  const info = { title: "", firstPrompt: "", prompts: 0, hasAssistant: false, cwd: "", branch: "", started: "", updated: "" };
  const titles = {};
  let parsedHead = 0;
  forEachLine(file, (line) => {
    if (line.includes('"isSidechain":true')) return;
    const needHead = parsedHead < 60 && !(info.cwd && info.started);
    const isTitle = line.includes('-title"') || line.includes('"type":"summary"');
    const isUser = line.includes('"type":"user"') && !line.includes('"type":"tool_result"');
    if (!(needHead || isTitle || isUser)) {
      if (line.includes('"type":"assistant"')) info.hasAssistant = true;
      return;
    }
    if (needHead) parsedHead++;
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    if (!info.cwd && typeof rec.cwd === "string") info.cwd = rec.cwd;
    if (!info.branch && typeof rec.gitBranch === "string") info.branch = rec.gitBranch;
    if (!info.started && rec.cwd && rec.timestamp) info.started = rec.timestamp;
    const t = titleRecord(rec);
    if (t) Object.assign(titles, t);
    if (rec.type === "assistant") info.hasAssistant = true;
    if (rec.type === "user") {
      const c = classifyUser(rec);
      if (isPromptKind(c)) {
        info.prompts++;
        if (!info.firstPrompt) info.firstPrompt = promptOf(c);
      }
    }
  });
  info.updated = lastTimestamp(file);
  info.title = pickTitle(titles, info.firstPrompt);
  return info;
}

// ---------------------------------------------------------------------------------------------
// Finding sessions
// ---------------------------------------------------------------------------------------------

// Session files, as { id, file, project (folder name), size, mtimeMs, updated, cwd }.
// With `all`, every project; otherwise only sessions whose working directory is `root` or inside
// it (the folder name is a quick filter, the recorded cwd the final word).
export function findSessions({ env = process.env, root = "", all = false } = {}) {
  const base = projectsDir(env);
  const rootSlug = root ? projectSlug(root).toLowerCase() : "";
  const out = [];
  for (const d of listDir(base)) {
    if (!d.isDirectory()) continue;
    const name = d.name.toLowerCase();
    if (!all && name !== rootSlug && !name.startsWith(`${rootSlug}-`)) continue;
    const dir = path.join(base, d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = path.join(dir, f.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const entry = { id: f.name.slice(0, -6), file, project: d.name, size: st.size, mtimeMs: st.mtimeMs, cwd: "" };
      if (!all) {
        entry.cwd = quickMeta(file).cwd;
        if (entry.cwd ? !isInside(root, entry.cwd) : name !== rootSlug) continue;
      }
      entry.updated = lastTimestamp(file) || new Date(st.mtimeMs).toISOString();
      out.push(entry);
    }
  }
  return out.sort((a, b) => cmp(b.updated, a.updated) || b.mtimeMs - a.mtimeMs);
}

// Every session (in any project) whose id is `ref` or starts with it.
export function findById(ref, env = process.env) {
  const want = String(ref).toLowerCase();
  const out = [];
  const base = projectsDir(env);
  for (const d of listDir(base)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const id = f.name.slice(0, -6);
      if (!id.toLowerCase().startsWith(want)) continue;
      const file = path.join(dir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* listed a moment ago, gone now */ }
      out.push({ id, file, project: d.name, mtimeMs });
    }
  }
  return out;
}
