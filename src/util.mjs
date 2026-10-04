// Small shared helpers: errors, text and number formatting, colours and file reading.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

// A problem the person can fix (wrong id, bad option). Printed without a stack trace, exit code 1.
export class UserError extends Error {}
export const fail = (message) => { throw new UserError(message); };

// Compares two strings by code unit: the same order on every machine, whatever its locale.
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Numbers, sizes, text
// ---------------------------------------------------------------------------------------------

export const pad2 = (n) => String(n).padStart(2, "0");
export const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 950 -> "950", 12345 -> "12.3K", 1234567 -> "1.2M". Used for token counts.
export function compact(n) {
  n = Math.round(Number(n) || 0);
  if (n < 1000) return String(n);
  const [div, unit] = n < 999500 ? [1e3, "K"] : [1e6, "M"];
  const v = n / div;
  return (v < 100 ? v.toFixed(1) : String(Math.round(v))).replace(/\.0$/, "") + unit;
}

export function kb(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// One line of text for a terminal or a summary: control codes, colour sequences and text-direction
// overrides go first, so a crafted session title cannot drive the terminal it is printed in.
export function oneLine(s, max = 200) {
  const t = cleanText(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "…" : t;
}

// The last part of a path in either spelling, whatever the OS we run on ("C:\a\b" and "/a/b" give "b").
export function baseName(p) {
  return String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

// What a terminal or a browser should never be handed: colour codes and other control sequences,
// bidirectional overrides that can make text read differently from how it is stored, and stray
// control characters. A lone carriage return is a progress bar redrawing itself: keep the last draw.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
export function cleanText(s) {
  let t = String(s ?? "").replace(ANSI, "").replace(/\r+\n/g, "\n");
  if (t.includes("\r")) { // split instead of a regex: no quadratic backtracking on a huge line
    t = t.split("\n").map((l) => l.slice(l.lastIndexOf("\r") + 1)).join("\n");
  }
  return t.replace(CONTROL, "");
}

// Cut a long text down to `max` characters, keeping the start and the end (the end of command
// output is usually where the error is). Returns { text, omitted } with the number of characters
// left out. max <= 0 means no limit.
export function capText(text, max, headShare = 0.7) {
  const s = String(text ?? "");
  if (!(max > 0) || s.length <= max) return { text: s, omitted: 0 };
  const head = Math.floor(max * headShare);
  const tail = max - head;
  let a = s.slice(0, head);
  let b = s.slice(s.length - tail);
  if (/[\ud800-\udbff]$/.test(a)) a = a.slice(0, -1); // never split a surrogate pair
  if (/^[\udc00-\udfff]/.test(b)) b = b.slice(1);
  return { text: `${a}\n\n…\n\n${b}`, omitted: s.length - a.length - b.length };
}

// ---------------------------------------------------------------------------------------------
// Dates. Files carry UTC, so the same export reads the same on every machine; the terminal
// listing uses local time because it is for the person at the keyboard.
// ---------------------------------------------------------------------------------------------

const toIso = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString() : ""; };
export const utcDay = (iso) => toIso(iso).slice(0, 10);
export const utcTime = (iso) => toIso(iso).slice(11, 19);
export const utcStamp = (iso) => { const t = toIso(iso); return t ? `${t.slice(0, 10)} ${t.slice(11, 19)}` : ""; };
export const utcMinute = (iso) => utcStamp(iso).slice(0, 16);
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------
// Colours: on for a terminal, off for pipes and when NO_COLOR is set. FORCE_COLOR switches them
// on anywhere (the tests use it).
// ---------------------------------------------------------------------------------------------

export function makeColors(env = process.env, isTTY = !!process.stdout.isTTY) {
  const forced = !!env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  const on = forced || (isTTY && !env.NO_COLOR);
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { on, bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36"), hit: paint("1;33") };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const tryParse = (line) => { try { return JSON.parse(line); } catch { return null; } };
export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Calls fn(line) for every non-empty line of a UTF-8 file, reading it in 1 MB pieces so a session
// of hundreds of megabytes never has to fit in memory as one string. Stops early when fn returns
// false. Returns false when the file cannot be opened.
export function forEachLine(file, fn) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return false; }
  const buf = Buffer.allocUnsafe(1 << 20);
  const decoder = new StringDecoder("utf8");
  let pieces = []; // the unfinished last line, kept as pieces so a huge line is joined only once
  let first = true;
  const emit = (raw) => {
    let line = raw;
    if (first) { first = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line ? fn(line) : undefined;
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const chunk = decoder.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = chunk.indexOf("\n", start); nl !== -1; nl = chunk.indexOf("\n", start)) {
        pieces.push(chunk.slice(start, nl));
        start = nl + 1;
        const line = pieces.length === 1 ? pieces[0] : pieces.join("");
        pieces = [];
        if (emit(line) === false) return true;
      }
      if (start < chunk.length) pieces.push(chunk.slice(start));
    }
    pieces.push(decoder.end());
    const last = pieces.join("");
    if (last) emit(last);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// The last `bytes` of a file as text, cut at a line start when the file is longer.
export function readTailText(file, bytes) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const span = Math.min(bytes, size);
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, size - span);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}
