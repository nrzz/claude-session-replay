// Full-text search over past sessions. No index: each file is streamed line by line, and a line is
// only parsed as JSON when a cheap text test says it could contain one of the words.
//
// A session matches when every word appears somewhere in it, in: its title, the prompts typed,
// Claude's text, or tool commands and paths. --deep adds tool output and the text of files tools
// read, wrote or edited. Words match as lowercase substrings.
//
// Ranking: a word found in the title counts most, then in a prompt, in Claude's text, in a tool
// call, and (deep) in output; words that appear together in one message add a bonus; the number of
// occurrences adds a little. Equal scores go to the more recent session.
import { classifyUser, promptOf, titleRecord } from "./claude.mjs";
import { cleanText, cmp, escapeRegExp, forEachLine, oneLine, tryParse } from "./util.mjs";

const WEIGHT = { title: 12, you: 5, claude: 3, tool: 2, output: 1 };
const MAX_WORDS = 12;

export function parseWords(input) {
  const list = (Array.isArray(input) ? input : [input]).join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(list)].slice(0, MAX_WORDS);
}

function resultText(block) {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n");
  return "";
}

// What a tool call is searched as: its name and the commands, paths, patterns and addresses in it.
function toolText(b, deep) {
  const i = b.input && typeof b.input === "object" ? b.input : {};
  const parts = [`${b.name}:`];
  const add = (v) => { if (typeof v === "string" && v) parts.push(v); };
  switch (b.name) {
    case "Bash": case "PowerShell": add(i.command); add(i.description); break;
    case "Read": add(i.file_path); break;
    case "Write": add(i.file_path); if (deep) add(i.content); break;
    case "Edit": add(i.file_path); if (deep) { add(i.old_string); add(i.new_string); } break;
    case "MultiEdit": add(i.file_path); if (deep) for (const e of Array.isArray(i.edits) ? i.edits : []) { add(e?.old_string); add(e?.new_string); } break;
    case "NotebookEdit": add(i.notebook_path); if (deep) add(i.new_source); break;
    case "Grep": add(i.pattern); add(i.path); add(i.glob); break;
    case "Glob": add(i.pattern); add(i.path); break;
    case "WebFetch": add(i.url); add(i.prompt); break;
    case "WebSearch": add(i.query); break;
    case "Task": case "Agent": add(i.description); add(i.prompt); break;
    default: for (const v of Object.values(i)) add(v); // MCP and other tools: every string they were given
  }
  return parts.join(" ").slice(0, 20000);
}

// The searchable pieces of one record: { kind, text }.
function* segmentsOf(rec, deep) {
  if (rec.isSidechain) return;
  if (rec.type === "user") {
    const c = classifyUser(rec);
    if (c.kind === "prompt" || c.kind === "command" || c.kind === "bash") yield { kind: "you", text: promptOf(c) };
    const content = rec.message?.content;
    if (deep && Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") yield { kind: "output", text: resultText(b) };
  } else if (rec.type === "assistant") {
    const content = rec.message?.content;
    if (typeof content === "string") yield { kind: "claude", text: content };
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") yield { kind: "claude", text: b.text };
        else if (b?.type === "tool_use") yield { kind: "tool", text: toolText(b, deep) };
      }
    }
  }
}

function countOf(lower, word, cap = 20) {
  let n = 0;
  for (let i = lower.indexOf(word); i !== -1 && n < cap; i = lower.indexOf(word, i + word.length)) n++;
  return n;
}

// A short piece of text around the words, cut at word boundaries, with … where it was cut.
export function makeSnippet(text, words, width = 160) {
  const flat = cleanText(String(text)).replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const found = words.map((w) => lower.indexOf(w)).filter((p) => p >= 0).sort((a, b) => a - b);
  if (!found.length) return oneLine(flat, width);
  let from = 0;
  let most = 0;
  for (const p of found) {
    const target = Math.max(0, p - 30);
    const start = target === 0 ? 0 : flat.lastIndexOf(" ", target) + 1;
    const n = found.filter((q) => q >= start && q < start + width - 15).length;
    if (n > most) { most = n; from = start; }
  }
  let to = Math.min(flat.length, from + width);
  if (to < flat.length && flat[to] !== " ") {
    const sp = flat.lastIndexOf(" ", to);
    if (sp > from + width * 0.6) to = sp;
  }
  return `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

// Wraps every occurrence of a word in `mark` (a colouring function).
export function markWords(text, words, mark) {
  if (!words.length) return text;
  const re = new RegExp(words.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "gi");
  return text.replace(re, (m) => mark(m));
}

// Searches one session file. Returns null when some word is missing, else
// { entry, score, snippet, title }: the snippet is the best passage outside the title, as
// { kind, text, ts } (null when the words are only in the title), and title is the explicit title or "".
export function searchFile(entry, words, { deep = false } = {}) {
  const needles = words.map((w) => JSON.stringify(w).slice(1, -1)); // the way a word looks inside a JSON line
  const found = new Map(words.map((w) => [w, { weight: 0, count: 0 }]));
  const titles = {};
  let best = null;
  let together = 1;

  const take = (kind, text, ts) => {
    const lower = text.toLowerCase();
    const hit = words.filter((w) => lower.includes(w));
    if (!hit.length) return;
    for (const w of hit) {
      const f = found.get(w);
      f.weight = Math.max(f.weight, WEIGHT[kind]);
      f.count += countOf(lower, w);
    }
    together = Math.max(together, hit.length);
    if (kind === "title") return; // the title is shown anyway; the snippet is the best passage besides it
    if (!best || hit.length > best.n || (hit.length === best.n && WEIGHT[kind] > WEIGHT[best.kind])) {
      best = { n: hit.length, kind, text: makeSnippet(text, hit), ts };
    }
  };

  const opened = forEachLine(entry.file, (line) => {
    const maybeTitle = line.includes('-title"') || line.includes('"type":"summary"');
    if (!maybeTitle) {
      const lower = line.toLowerCase();
      if (!needles.some((n) => lower.includes(n))) return;
    }
    const rec = tryParse(line);
    if (!rec || typeof rec !== "object") return;
    const t = titleRecord(rec);
    if (t) { Object.assign(titles, t); return; }
    for (const seg of segmentsOf(rec, deep)) take(seg.kind, seg.text, rec.timestamp || "");
  });
  if (!opened) return null;

  const title = titles.custom || titles.ai || titles.summary || "";
  if (title) take("title", title, entry.updated);
  let score = 0;
  for (const f of found.values()) {
    if (!f.count && !f.weight) return null;
    score += f.weight + Math.log(1 + f.count);
  }
  score += 3 * (together - 1);
  return { entry, score, snippet: best ? { kind: best.kind, text: best.text, ts: best.ts } : null, title };
}

// Every session that matches, best first.
export function searchSessions(entries, words, { deep = false } = {}) {
  const hits = [];
  for (const e of entries) {
    const r = searchFile(e, words, { deep });
    if (r) hits.push(r);
  }
  return hits.sort((a, b) => b.score - a.score || cmp(b.entry.updated, a.entry.updated));
}
