// Turns a transcript into a model of the conversation that the HTML and Markdown exporters share.
//
// The model is a list of turns, in the order things happened:
//   you      what the person typed (text, images), or a slash command / "!" shell command
//   claude   everything Claude did until the next prompt: text, thinking, tool calls with results
//   compact  a compaction boundary,  summary  the summary carried across it,  note  an interruption
// Every string in it has already been through `display` (control codes removed, secrets and paths
// dealt with), and every tool output already cut to the size limit, so the exporters only format.
import fs from "node:fs";
import path from "node:path";
import { classifyText, classifyUser, homeDir, pickTitle, promptOf, quickMeta, titleRecord } from "./claude.mjs";
import { makeDisplay, relPath } from "./redact.mjs";
import { baseName, capText, forEachLine, listDir, oneLine, tryParse, UserError } from "./util.mjs";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const WRITE_LINES = 200;   // a written file is shown up to this many lines
const MAX_EDITS = 50;      // a MultiEdit is shown up to this many edits
const MAX_SUB_ITEMS = 300; // a subagent's steps are shown up to this many
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IMAGE = 1024 * 1024; // an image bigger than this (as base64) is left out, unless output limits are off

export const DEFAULT_MAX_OUTPUT = 20 * 1024;

const countLines = (text) => (text ? text.replace(/\n$/, "").split("\n").length : 0);
const validIso = (s) => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? s : "");

export class SessionBuilder {
  // opts: display (from makeDisplay), root (the project folder, for relative paths), tools,
  // thinking, images (false drops them), maxOutput (characters per tool output, 0 = no limit),
  // sidechain (true when reading a subagent's own transcript).
  constructor(opts) {
    this.o = { tools: true, thinking: true, images: true, maxOutput: DEFAULT_MAX_OUTPUT, root: "", sidechain: false, ...opts };
    this.d = this.o.display;
    this.turns = [];
    this.cur = null;               // the Claude turn being filled
    this.lastYou = null;           // the last "you" turn, which command and shell output attach to
    this.pending = new Map();      // tool_use id -> tool item waiting for its result
    this.promptKeys = new WeakMap(); // Task call -> the prompt it was given, to find its subagent
    this.toolIds = new Set();
    this.seen = new Set();         // uuids handled already: a resumed session can repeat records
    this.usage = new Map();        // assistant message id -> highest counters seen
    this.models = new Set();
    this.titles = {};
    this.firstPrompt = "";
    this.info = { cwd: "", branch: "", version: "", started: "", ended: "" };
    this.counts = { prompts: 0, toolCalls: 0 };
  }

  add(rec) {
    if (!rec || typeof rec !== "object") return;
    if (rec.isSidechain && !this.o.sidechain) return;
    if (rec.uuid) {
      if (this.seen.has(rec.uuid)) return;
      this.seen.add(rec.uuid);
    }
    const title = titleRecord(rec);
    if (title) { Object.assign(this.titles, title); return; }
    if (rec.type !== "user" && rec.type !== "assistant" && rec.type !== "system") return;
    this.noteMeta(rec);
    if (rec.type === "system") this.system(rec);
    else if (rec.type === "user") this.user(rec);
    else this.assistant(rec);
  }

  noteMeta(rec) {
    const i = this.info;
    if (!i.cwd && typeof rec.cwd === "string") i.cwd = rec.cwd;
    if (typeof rec.gitBranch === "string" && rec.gitBranch) i.branch = rec.gitBranch;
    if (typeof rec.version === "string" && rec.version) i.version = rec.version;
    const ts = validIso(rec.timestamp);
    if (ts) { i.started ||= ts; i.ended = ts; }
  }

  // --- system records: only compaction boundaries matter -----------------------------------
  system(rec) {
    if (rec.subtype === "compact_boundary" || rec.compactMetadata) {
      const meta = rec.compactMetadata || {};
      this.turns.push({ type: "compact", ts: validIso(rec.timestamp), trigger: String(meta.trigger || ""), preTokens: Number(meta.preTokens) || 0 });
      this.cur = null;
      return;
    }
    // Some versions record a slash command's output as a system record instead of a user record.
    const out = typeof rec.content === "string" ? classifyText(rec.content) : null;
    if (out?.kind === "command-output") this.commandOutput(out.text, validIso(rec.timestamp));
  }

  commandOutput(raw, ts) {
    const text = this.output(raw);
    if (this.lastYou?.command && !this.lastYou.output) this.lastYou.output = text;
    else if (String(raw).trim()) this.turns.push({ type: "note", ts, text: "", output: text });
  }

  // --- user records ------------------------------------------------------------------------
  user(rec) {
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_result") this.toolResult(b, rec);
    }
    const c = classifyUser(rec);
    const ts = validIso(rec.timestamp);
    switch (c.kind) {
      case "prompt": {
        this.firstPrompt ||= promptOf(c);
        return this.you({ type: "you", ts, text: this.d.text(c.text), images: this.images(c.images) });
      }
      case "command": {
        this.firstPrompt ||= promptOf(c);
        return this.you({ type: "you", ts, text: "", images: [], command: { name: this.d.text(c.name), args: this.d.text(c.args) } });
      }
      case "bash": {
        this.firstPrompt ||= promptOf(c);
        return this.you({ type: "you", ts, text: "", images: [], bash: { command: this.d.text(c.command), stdout: null, stderr: null } });
      }
      case "bash-output": {
        const bash = this.lastYou?.bash;
        if (bash) { bash.stdout = this.output(c.stdout); bash.stderr = this.output(c.stderr); }
        return undefined;
      }
      case "command-output":
        this.commandOutput(c.text, ts);
        return undefined;
      case "interrupt":
        this.cur = null;
        this.turns.push({ type: "note", ts, text: this.d.text(c.text.replace(/^\[|\]$/g, "")) });
        return undefined;
      case "summary":
        this.cur = null;
        this.turns.push({ type: "summary", ts, text: this.d.text(c.text) });
        return undefined;
      default:
        return undefined; // tool results (handled above), injected context, meta records
    }
  }

  you(turn) {
    this.cur = null;
    this.counts.prompts++;
    this.turns.push(turn);
    this.lastYou = turn;
  }

  // Display text, cut to the output limit: { text, omitted, lines }.
  output(raw) {
    const full = this.d.text(String(raw ?? ""));
    const cut = capText(full, this.o.maxOutput);
    return { text: cut.text, omitted: cut.omitted, lines: countLines(full) };
  }

  images(blocks) {
    const out = [];
    for (const b of blocks || []) {
      const src = b?.source || {};
      const media = String(src.media_type || "").toLowerCase();
      if (b?.type === "document") { out.push({ omitted: true, media: media || "document", document: true }); continue; }
      if (!this.o.images) { this.d.counts.images++; out.push({ omitted: true, media }); continue; }
      const data = typeof src.data === "string" ? src.data.replace(/\s+/g, "") : "";
      if (data.length > MAX_IMAGE && this.o.maxOutput > 0) { out.push({ omitted: true, media, bytes: Math.round(data.length * 0.75) }); continue; }
      if (src.type === "base64" && IMAGE_TYPES.has(media) && BASE64.test(data)) out.push({ media, data });
      else out.push({ omitted: true, media });
    }
    return out;
  }

  toolResult(b, rec) {
    if (!this.o.tools) return;
    const item = this.pending.get(b.tool_use_id);
    if (!item) return;
    let text = "";
    let imageBlocks = [];
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) {
      text = b.content.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n");
      imageBlocks = b.content.filter((x) => x?.type === "image");
    }
    item.result = { ...this.output(text), isError: !!b.is_error, images: this.images(imageBlocks) };
    const agentId = rec.toolUseResult?.agentId;
    if (item.kind === "agent" && typeof agentId === "string" && AGENT_ID.test(agentId)) item.agentId = agentId;
  }

  // --- assistant records -------------------------------------------------------------------
  assistant(rec) {
    const msg = rec.message;
    if (!msg || typeof msg !== "object") return;
    if (!this.cur) {
      this.cur = { type: "claude", ts: validIso(rec.timestamp), model: "", items: [], messageIds: new Set() };
      this.turns.push(this.cur);
    }
    const key = msg.id || rec.uuid || "";
    if (key) { this.cur.messageIds.add(key); this.noteUsage(key, msg.usage); }
    if (typeof msg.model === "string" && msg.model && !msg.model.startsWith("<")) {
      this.models.add(msg.model);
      this.cur.model ||= msg.model;
    }
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    for (const b of content) this.block(rec, b);
  }

  // Several records of one assistant message each repeat its usage: keep the highest of each counter.
  noteUsage(key, u) {
    if (!u || typeof u !== "object") return;
    const cur = this.usage.get(key) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.input = Math.max(cur.input, Number(u.input_tokens) || 0);
    cur.output = Math.max(cur.output, Number(u.output_tokens) || 0);
    cur.cacheRead = Math.max(cur.cacheRead, Number(u.cache_read_input_tokens) || 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, Number(u.cache_creation_input_tokens) || 0);
    this.usage.set(key, cur);
  }

  block(rec, b) {
    if (!b || typeof b !== "object") return;
    if (b.type === "text") {
      if (typeof b.text !== "string" || !b.text.trim()) return;
      this.cur.items.push({ type: "text", text: this.d.text(b.text), error: !!rec.isApiErrorMessage });
    } else if (b.type === "thinking") {
      if (typeof b.thinking !== "string" || !b.thinking.trim()) return;
      if (!this.o.thinking) { this.d.counts.thinking++; return; }
      this.cur.items.push({ type: "thinking", text: this.d.text(b.thinking) });
    } else if (b.type === "tool_use") {
      this.toolUse(b);
    } // redacted_thinking holds encrypted data: nothing to show
  }

  toolUse(b) {
    const id = typeof b.id === "string" ? b.id : "";
    if (id) {
      if (this.toolIds.has(id)) return;
      this.toolIds.add(id);
    }
    this.counts.toolCalls++;
    if (!this.o.tools) return;
    const name = String(b.name || "tool");
    const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
    const item = { type: "tool", id, name, ...this.describe(name, input), input: this.shapeInput(name, input), result: null };
    // The raw prompt (never shown, never in the model) lets attachSubagents find the call's subagent.
    if (name === "Task" || name === "Agent") this.promptKeys.set(item, String(input.prompt ?? "").trim());
    this.cur.items.push(item);
    if (id) this.pending.set(id, item);
  }

  // One line for the call: { kind (how it is styled), label, detail, code (detail is code, not prose),
  // where (a folder the search ran in) }.
  // Paths are shown relative to the project. Text goes through `display` before it is shortened, so
  // a secret cut in half by the shortening cannot be left half-visible.
  describe(name, input) {
    const t = (s) => this.d.text(String(s ?? ""));
    const rel = (p) => t(relPath(p, this.o.root));
    const short = (s, n) => oneLine(t(s), n);
    let r;
    switch (name) {
      case "Read": r = { kind: "read", detail: rel(input.file_path), code: true }; break;
      case "Write": r = { kind: "write", detail: rel(input.file_path), code: true }; break;
      case "Edit": case "MultiEdit": r = { kind: "edit", detail: rel(input.file_path), code: true }; break;
      case "NotebookEdit": r = { kind: "edit", label: "Edit notebook", detail: rel(input.notebook_path), code: true }; break;
      case "Bash": case "PowerShell": r = { kind: "bash", detail: short(input.command, 160), code: true }; break;
      case "Grep": case "Glob": r = { kind: "search", detail: short(input.pattern, 80), code: true, where: input.path ? rel(input.path) : "" }; break;
      case "WebFetch": r = { kind: "web", detail: short(input.url, 120), code: false }; break;
      case "WebSearch": r = { kind: "web", detail: `"${short(input.query, 100)}"`, code: false }; break;
      case "Task": case "Agent": r = { kind: "agent", label: "Subagent", detail: short(input.description || input.prompt, 120), code: false }; break;
      case "TodoWrite": r = { kind: "todo", label: "Updated the todo list", detail: `(${(Array.isArray(input.todos) ? input.todos : []).length} items)`, code: false }; break;
      case "ExitPlanMode": r = { kind: "plan", label: "Proposed a plan", detail: "", code: false }; break;
      case "Skill": r = { kind: "other", detail: short(`${input.skill ?? ""} ${input.args ?? ""}`, 120), code: true }; break;
      default: {
        const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
        if (mcp) r = { kind: "mcp", label: "MCP", detail: `${t(mcp[1])} › ${t(mcp[2])} ${short(JSON.stringify(input), 100)}`.trim(), code: false };
        else r = { kind: "other", detail: short(JSON.stringify(input), 140), code: false };
      }
    }
    return { kind: r.kind, label: t(r.label || name), detail: r.detail, code: r.code, where: r.where || "" };
  }

  // What the exporters need of a call's input, mapped and cut to size. Edits keep the old and new
  // text (for the diff), a written file its first lines, a command the command; any other tool
  // keeps its whole input (to be shown as JSON).
  shapeInput(name, input) {
    const d = this.d;
    const text = (s) => { const c = capText(d.text(String(s ?? "")), this.o.maxOutput); return { text: c.text, omitted: c.omitted }; };
    switch (name) {
      case "Write": {
        const lines = d.text(String(input.content ?? "")).split("\n");
        const shown = text(lines.slice(0, WRITE_LINES).join("\n"));
        return { file_path: d.text(String(input.file_path ?? "")), content: shown, totalLines: lines.length, moreLines: Math.max(0, lines.length - WRITE_LINES) };
      }
      case "Edit":
        return { file_path: d.text(String(input.file_path ?? "")), old_string: text(input.old_string), new_string: text(input.new_string), replace_all: !!input.replace_all };
      case "MultiEdit": {
        const edits = Array.isArray(input.edits) ? input.edits : [];
        return {
          file_path: d.text(String(input.file_path ?? "")),
          edits: edits.slice(0, MAX_EDITS).map((e) => ({ old_string: text(e?.old_string), new_string: text(e?.new_string) })),
          moreEdits: Math.max(0, edits.length - MAX_EDITS),
        };
      }
      case "Bash": case "PowerShell":
        return { command: text(input.command), description: d.text(String(input.description ?? "")) };
      case "ExitPlanMode":
        return { plan: text(input.plan) };
      case "Task": case "Agent":
        return { description: d.text(String(input.description ?? "")), prompt: text(input.prompt), subagent_type: d.text(String(input.subagent_type ?? "")) };
      case "TodoWrite": {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        return { todos: todos.slice(0, 100).map((t) => ({ content: d.text(String(t?.content ?? t?.activeForm ?? "")), status: String(t?.status || "") })) };
      }
      default: {
        // Short plain values are shown as name: value rows, anything else as JSON.
        const mapped = d.deep(input);
        const entries = Object.entries(mapped);
        const flat = entries.length > 0 && entries.every(([, v]) => ["string", "number", "boolean"].includes(typeof v));
        return {
          json: text(JSON.stringify(mapped, null, 2)),
          pairs: flat ? entries.map(([k, v]) => [k, capText(String(v), 600).text]) : null,
        };
      }
    }
  }

  // Tokens of one or more assistant messages.
  sumUsage(ids) {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const id of ids) {
      const u = this.usage.get(id);
      if (!u) continue;
      t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite;
    }
    return t;
  }

  finish({ id = "" } = {}) {
    const turns = [];
    for (const t of this.turns) {
      if (t.type === "claude") {
        t.tokens = this.sumUsage(t.messageIds);
        delete t.messageIds;
        if (!t.items.length) continue; // only thinking that was left out, or nothing to show
      }
      turns.push(t);
    }
    const tokens = this.sumUsage(this.usage.keys());
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    const titles = {};
    for (const [k, v] of Object.entries(this.titles)) titles[k] = this.d.text(v);
    return {
      id,
      title: pickTitle(titles, this.d.text(this.firstPrompt)),
      project: baseName(this.info.cwd),
      branch: this.d.text(this.info.branch),
      version: this.info.version,
      models: [...this.models],
      started: this.info.started,
      ended: this.info.ended,
      counts: { prompts: this.counts.prompts, toolCalls: this.counts.toolCalls, turns: turns.length, messages: this.usage.size },
      tokens,
      turns,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

// Reads one session file into the model.
// opts: redact, tools, thinking, images (false to drop), maxOutput (characters), subagents (false
// to leave out the steps of subagents), home, env, patterns (extra regular expressions to redact).
// --redact always drops thinking and images. Returns { session, display } (display.counts says
// what was redacted or dropped).
export function loadSession(file, opts = {}) {
  const id = path.basename(file, ".jsonl");
  const dir = path.dirname(file);
  const meta = quickMeta(file);
  const redact = !!opts.redact;
  const display = makeDisplay({
    redact,
    root: meta.cwd,
    home: opts.home ?? homeDir(opts.env || process.env),
    slug: path.basename(dir),
    toolResults: path.join(dir, id, "tool-results"),
    patterns: opts.patterns,
  });
  const o = {
    display,
    root: meta.cwd,
    tools: opts.tools !== false,
    thinking: opts.thinking !== false && !redact,
    images: opts.images !== false && !redact,
    maxOutput: opts.maxOutput ?? DEFAULT_MAX_OUTPUT,
  };
  const builder = new SessionBuilder(o);
  const readable = forEachLine(file, (line) => {
    const rec = tryParse(line);
    if (rec) builder.add(rec);
  });
  if (!readable) throw new UserError(`Cannot read ${file}`);
  const session = builder.finish({ id });
  if (o.tools && opts.subagents !== false) attachSubagents(session, builder, path.join(dir, id, "subagents"));
  return { session, display };
}

// A Task/Agent call gets the steps of its subagent, read from subagents/agent-<id>.jsonl next to the
// session. The call's result names the agent; when it does not (or the file is missing), the
// subagent is the one whose first prompt is the prompt the call was given.
function attachSubagents(session, parent, dir) {
  let byPrompt = null; // built only when needed: first prompt -> transcript file
  for (const turn of session.turns) {
    if (turn.type !== "claude") continue;
    for (const item of turn.items) {
      if (item.type !== "tool" || !parent.promptKeys.has(item)) continue;
      let file = item.agentId ? path.join(dir, `agent-${item.agentId}.jsonl`) : "";
      if (!file || !fs.existsSync(file)) {
        const key = parent.promptKeys.get(item);
        byPrompt ??= subagentsByPrompt(dir);
        file = key ? byPrompt.get(key) || "" : "";
      }
      if (!file) continue;
      const sub = new SessionBuilder({ ...parent.o, sidechain: true });
      if (!forEachLine(file, (line) => { const rec = tryParse(line); if (rec) sub.add(rec); })) continue;
      const steps = sub.finish().turns.filter((t) => t.type === "claude").flatMap((t) => t.items);
      if (steps.length) item.sub = { items: steps.slice(0, MAX_SUB_ITEMS), more: Math.max(0, steps.length - MAX_SUB_ITEMS), toolCalls: sub.counts.toolCalls };
    }
  }
}

// The subagent transcripts in a folder, keyed by the prompt each one started with.
function subagentsByPrompt(dir) {
  const map = new Map();
  for (const e of listDir(dir)) {
    if (!e.isFile() || !/^agent-.*\.jsonl$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    forEachLine(file, (line) => {
      const rec = tryParse(line);
      if (rec?.type !== "user") return true;
      const c = classifyUser(rec);
      if (c.kind === "prompt" && !map.has(c.text.trim())) map.set(c.text.trim(), file);
      return false; // only the first prompt of each file
    });
  }
  return map;
}
