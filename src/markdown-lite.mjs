// Markdown-lite: the part of Markdown that assistant text uses, rendered to safe HTML, plus a tiny
// syntax highlighter for fenced code.
//
//   blocks    paragraphs, # headings, - and 1. lists (nested, with [ ] items), > quotes, --- rules,
//             | tables |, fenced code
//   inline    `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs; a newline is a line break
//   links     only http and https URLs become links (rel="noopener noreferrer"); any other link
//             is shown as its text, with the address in brackets, and cannot be clicked
// Everything goes through safe.mjs, so transcript text can never become markup.
import { esc, h, raw, join } from "./safe.mjs";
import { escapeRegExp } from "./util.mjs";

const MAX_DEPTH = 8;            // nesting of lists and quotes
const HIGHLIGHT_LIMIT = 200000; // characters of code that get highlighted; more is shown plain

// ---------------------------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------------------------

const words = (s) => new Set(s.split(/\s+/));
const KEYWORDS = {
  js: words("as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield"),
  py: words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield"),
  sh: words("if then else elif fi for while until do done case esac function in select return exit export local readonly set unset source"),
  ps: words("if else elseif foreach for while do switch function param return try catch finally throw break continue $true $false $null"),
  go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil"),
  rust: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
  c: words("abstract auto bool boolean break byte case catch char class const continue default delete do double else enum extern false final finally float for foreach fun function goto if implements import include inline instanceof int interface internal let long namespace new null nullptr override package private protected public readonly return sealed short signed sizeof static string struct super switch template this throw throws true try typedef typeof union unsigned using val var virtual void volatile while yield"),
  rb: words("alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield"),
  sql: words("select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all null is in like between exists case when then else end primary key foreign references default unique"),
  json: words("true false null"),
  yaml: words("true false null yes no on off"),
  none: new Set(),
};
// How each language family is tokenized. strings: which quote characters open a string.
const PROFILES = {
  js: { kw: "js", line: ["//"], block: ["/*", "*/"], strings: "\"'`" },
  json: { kw: "json", line: [], block: null, strings: '"' },
  py: { kw: "py", line: ["#"], block: null, strings: "\"'" },
  sh: { kw: "sh", line: ["#"], block: null, strings: "\"'" },
  ps: { kw: "ps", line: ["#"], block: null, strings: "\"'", ci: true },
  go: { kw: "go", line: ["//"], block: ["/*", "*/"], strings: "\"'`" },
  rust: { kw: "rust", line: ["//"], block: ["/*", "*/"], strings: '"' },
  c: { kw: "c", line: ["//"], block: ["/*", "*/"], strings: "\"'" },
  rb: { kw: "rb", line: ["#"], block: null, strings: "\"'" },
  sql: { kw: "sql", line: ["--"], block: ["/*", "*/"], strings: "'\"", ci: true },
  yaml: { kw: "yaml", line: ["#"], block: null, strings: "\"'" },
  css: { kw: "none", line: [], block: ["/*", "*/"], strings: "\"'" },
  markup: { kw: "none", line: [], block: ["<!--", "-->"], strings: '"' },
};
const LANGS = {
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", typescript: "js", tsx: "js", node: "js",
  json: "json", jsonc: "json", json5: "json",
  py: "py", python: "py", python3: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh",
  ps1: "ps", powershell: "ps", pwsh: "ps",
  go: "go", golang: "go", rs: "rust", rust: "rust",
  java: "c", kt: "c", kotlin: "c", cs: "c", csharp: "c", c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", swift: "c", php: "c", scala: "c", dart: "c",
  rb: "rb", ruby: "rb", sql: "sql", yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml",
  html: "markup", xml: "markup", svg: "markup", css: "css", scss: "css", diff: "diff", patch: "diff",
};

// One regular expression per language: the first group that matches says what the token is.
// Every part consumes at least one character and has no nested repetition that could backtrack
// badly, so highlighting takes time proportional to the code.
const tokenizers = new Map();
function tokenizerFor(family) {
  if (tokenizers.has(family)) return tokenizers.get(family);
  const p = PROFILES[family];
  const q = [...p.strings].map((ch) => {
    const e = escapeRegExp(ch);
    return ch === "`" ? "`(?:[^`\\\\]|\\\\[\\s\\S])*`?" : `${e}(?:[^${e}\\\\\\n]|\\\\.)*${e}?`;
  });
  const parts = [];
  if (p.block) parts.push(`(?<c>${escapeRegExp(p.block[0])}[\\s\\S]*?(?:${escapeRegExp(p.block[1])}|$))`);
  if (p.line.length) parts.push(`(?<l>(?:${p.line.map(escapeRegExp).join("|")})[^\\n]*)`);
  parts.push(`(?<s>${q.join("|")})`);
  parts.push("(?<n>\\b0[xX][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)");
  parts.push("(?<w>[A-Za-z_$][\\w$]*)");
  const t = { re: new RegExp(parts.join("|"), "g"), kw: KEYWORDS[p.kw], ci: !!p.ci };
  tokenizers.set(family, t);
  return t;
}

// The language family for a fence label or a file name's extension, or "" for none.
export function languageOf(label) {
  const key = String(label || "").toLowerCase().replace(/^.*\./, "");
  return LANGS[key] || "";
}

// One line of a diff as a coloured row.
export function diffRow(kind, text) {
  return h`<span class="dl ${kind}">${text}</span>`;
}
function highlightDiff(code) {
  return join(code.split("\n").map((line) => {
    const kind = /^(\+\+\+|---|diff |index )/.test(line) ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    return diffRow(kind, line);
  }));
}

// Code as HTML with keywords, strings, comments and numbers wrapped in <span class="k|s|c|n">.
export function highlight(code, lang = "") {
  const family = languageOf(lang);
  const text = String(code);
  if (!family || text.length > HIGHLIGHT_LIMIT) return h`${text}`;
  if (family === "diff") return highlightDiff(text);
  const { re, kw, ci } = tokenizerFor(family);
  re.lastIndex = 0;
  let out = "";
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > pos) out += esc(text.slice(pos, m.index));
    const g = m.groups;
    let cls = "";
    if (g.c !== undefined || g.l !== undefined) cls = "c";
    else if (g.s !== undefined) cls = "s";
    else if (g.n !== undefined) cls = "n";
    else if (g.w !== undefined && kw.has(ci ? g.w.toLowerCase() : g.w)) cls = "k";
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
    pos = m.index + m[0].length;
  }
  return raw(out + esc(text.slice(pos)));
}

// A block of code: <pre class="code">, with the language label when there is one.
export function codeBlock(code, lang = "") {
  const label = /^[A-Za-z0-9+#.-]{1,20}$/.test(lang) ? lang : "";
  return h`<div class="fence">${label ? h`<span class="lang">${label}</span>` : ""}<pre class="code">${highlight(code, label)}</pre></div>`;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const URL_AT = /https?:\/\/[^\s<>"'`]+/y;
const HTTP_URL = /^https?:\/\/[^\s<>"'`]+$/i;
const URL_BEFORE = /[\s(\["'<>*_~]/; // what may stand before a web address in prose (< is the <https://...> form)

// A web address as it appears in prose, without the punctuation that ends the sentence or the
// bracket that closes "(see https://...)". The brackets are counted once, not on every pass.
function trimUrl(url) {
  const count = (ch) => { let n = 0; for (let i = 0; i < url.length; i++) if (url[i] === ch) n++; return n; };
  let open = count("(");
  let close = count(")");
  let openSq = count("[");
  let closeSq = count("]");
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (".,;:!?*_~'\"".includes(last)) end--;
    else if (last === ")" && open < close) { end--; close--; }
    else if (last === "]" && openSq < closeSq) { end--; closeSq--; }
    else break;
    if (last === "(") open--;
    else if (last === "[") openSq--;
  }
  return url.slice(0, end);
}

// Is there something after "http://" or "https://" (the punctuation trimmed off may have left nothing)?
const hasHost = (url) => url.length > (url[4] === "s" ? 8 : 7);
const anchor = (url, label) => `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${label}</a>`;

// The end of the code span that opens with a run of n backticks at `from - n`, or -1.
export function codeSpanEnd(text, from, n) {
  const limit = Math.min(text.length, from + 2000);
  for (let j = from; j < limit;) {
    if (text[j] !== "`") { j++; continue; }
    let len = 0;
    while (text[j + len] === "`") len++;
    if (len === n) return j;
    j += len;
  }
  return -1;
}

// [label](url "title"): { label, url, end } or null.
function parseLink(text, i) {
  let j = i + 1;
  let depth = 1;
  for (; j < text.length && text[j] !== "\n" && j - i < 400; j++) {
    if (text[j] === "[") depth++;
    else if (text[j] === "]" && --depth === 0) break;
  }
  if (text[j] !== "]" || text[j + 1] !== "(") return null;
  const start = j + 2;
  let k = start;
  let parens = 0;
  for (; k < text.length && k - start < 2000 && !/\s/.test(text[k]); k++) {
    if (text[k] === "(") parens++;
    else if (text[k] === ")") { if (parens === 0) break; parens--; }
  }
  let end;
  if (text[k] === ")") end = k + 1;
  else if (k < text.length && /\s/.test(text[k])) {
    const title = /\s+"[^"\n]*"\s*\)/y;
    title.lastIndex = k;
    const m = title.exec(text);
    if (!m) return null;
    end = k + m[0].length;
  } else return null;
  return { label: text.slice(i + 1, j), url: text.slice(start, k), end };
}

// *x*, **x**, _x_, __x__ with the usual rules: the opening mark is followed by a non-space, the
// closing one preceded by a non-space, and an underscore inside a word (snake_case) is not emphasis.
function parseEmphasis(text, i, depth) {
  const c = text[i];
  const m = text[i + 1] === c ? 2 : 1;
  const mark = c.repeat(m);
  const next = text[i + m] ?? " ";
  if (/\s/.test(next) || next === c) return null;
  if (c === "_" && i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) return null;
  const limit = Math.min(text.length, i + m + 600);
  for (let from = i + m; from < limit;) {
    const k = text.indexOf(mark, from);
    if (k === -1 || k >= limit) return null;
    const before = text[k - 1];
    const after = text[k + m] ?? " ";
    const closes = !/\s/.test(before) && before !== c
      && (c === "*" ? after !== c : !/[A-Za-z0-9]/.test(after));
    if (closes) return { tag: m === 2 ? "strong" : "em", inner: text.slice(i + m, k), end: k + m };
    from = k + 1;
  }
  return null;
}

// inLink: this text is the label of a link, which must not hold another link.
export function inline(text, depth = 0, inLink = false) {
  const src = String(text);
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(esc(buf)); buf = ""; } };
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      const end = codeSpanEnd(src, i + run, run);
      if (end !== -1) {
        flush();
        let code = src.slice(i + run, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push(`<code>${esc(code)}</code>`);
        i = end + run;
      } else { buf += "`".repeat(run); i += run; }
    } else if (c === "[" && depth < 3 && !inLink) {
      const link = parseLink(src, i);
      if (link) {
        flush();
        const label = inline(link.label, depth + 1, true).html;
        if (HTTP_URL.test(link.url)) out.push(anchor(link.url, label));
        else if (/^[a-z][a-z0-9+.-]*:/i.test(link.url)) out.push(`${label} <span class="dim">(${esc(link.url)})</span>`);
        else out.push(label);
        i = link.end;
      } else { buf += c; i++; }
    } else if ((c === "*" || c === "_") && depth < 3) {
      const em = parseEmphasis(src, i, depth);
      if (em) { flush(); out.push(`<${em.tag}>${inline(em.inner, depth + 1, inLink).html}</${em.tag}>`); i = em.end; }
      else { buf += c; i++; }
    } else if (c === "~" && src[i + 1] === "~" && depth < 3) {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2 && end < i + 1500 && !/\s/.test(src[i + 2]) && !/\s/.test(src[end - 1])) {
        flush();
        out.push(`<del>${inline(src.slice(i + 2, end), depth + 1, inLink).html}</del>`);
        i = end + 2;
      } else { buf += "~~"; i += 2; }
    } else if (c === "h" && !inLink && (i === 0 || URL_BEFORE.test(src[i - 1]))) {
      URL_AT.lastIndex = i;
      const m = URL_AT.exec(src);
      const url = m ? trimUrl(m[0]) : "";
      if (hasHost(url)) { flush(); out.push(anchor(url, esc(url))); i += url.length; }
      else { buf += c; i++; }
    } else if (c === "\n") {
      flush();
      out.push("<br>");
      i++;
    } else { buf += c; i++; }
  }
  flush();
  return raw(out.join(""));
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const indentOf = (s) => s.replace(/\t/g, "    ").match(/^ */)[0].length;
const stripIndent = (line, n) => { let k = 0; while (k < n && line[k] === " ") k++; return line.slice(k); };

// A fenced code block starting at lines[i]: { end (index after it), lang, code }, or null.
export function readFence(lines, i) {
  const m = FENCE_OPEN.exec(lines[i]);
  if (!m) return null;
  const mark = m[2];
  const closing = new RegExp(`^\\s*${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
  const body = [];
  let j = i + 1;
  while (j < lines.length && !closing.test(lines[j])) { body.push(stripIndent(lines[j], m[1].length)); j++; }
  return { end: j < lines.length ? j + 1 : j, lang: m[3], code: body.join("\n") };
}

function headingOf(line) {
  const m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2].replace(/[ \t]+#+[ \t]*$/, "").trim() };
}
function isRule(line) {
  const t = line.trim();
  return t.length >= 3 && /^[-*_]$/.test(t[0]) && [...t].every((ch) => ch === t[0] || ch === " ") && t.replace(/ /g, "").length >= 3;
}

// Cells of a table row.
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function tableAt(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return null;
  const sep = splitRow(lines[i + 1]);
  if (!lines[i + 1].includes("-") || !sep.every((c) => /^:?-+:?$/.test(c))) return null;
  const head = splitRow(lines[i]);
  if (head.length !== sep.length) return null;
  const align = sep.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
    const cells = splitRow(lines[j]);
    rows.push(head.map((_, k) => cells[k] ?? ""));
    j++;
  }
  return { end: j, head, align, rows };
}
const cell = (tag, text, align) => `<${tag}${align ? ` class="${align}"` : ""}>${inline(text).html}</${tag}>`;
function renderTable(t) {
  const head = `<thead><tr>${t.head.map((c, k) => cell("th", c, t.align[k])).join("")}</tr></thead>`;
  const body = `<tbody>${t.rows.map((r) => `<tr>${r.map((c, k) => cell("td", c, t.align[k])).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="tablewrap"><table>${head}${body}</table></div>`;
}

function startsBlock(line) {
  return FENCE_OPEN.test(line) || !!headingOf(line) || isRule(line) || /^\s*>/.test(line) || LIST_ITEM.test(line);
}

// One list starting at lines[i]: { end, html }.
function readList(lines, i, depth) {
  const first = LIST_ITEM.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const baseIndent = indentOf(first[1]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    if (!lines[i].trim()) { // blank lines between two items keep them in one list: a loose list
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
      if (!next || indentOf(next[1]) !== baseIndent || /\d/.test(next[2]) !== ordered) break;
      loose = true;
      i = j;
    }
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || indentOf(m[1]) < baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = indentOf(m[1]) + m[2].length + Math.min(m[3].length, 4);
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) { body.push(""); i++; continue; }
        break;
      }
      if (indentOf(l) >= contentIndent) { body.push(stripIndent(l, contentIndent)); i++; continue; }
      if (!startsBlock(l) && body[body.length - 1].trim()) { body.push(l.trim()); i++; continue; } // lazy continuation
      break;
    }
    items.push(body);
  }
  const tag = ordered ? "ol" : "ul";
  // A list with a blank line between items, or inside one, is loose: every item's text is a paragraph.
  const tight = !loose && items.every((body) => body.every((l, k) => k === 0 || l.trim())); // (an empty item is not a blank line)
  const li = items.map((body) => {
    let task = "";
    const t = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (t) { task = t[1] === " " ? "☐ " : "☑ "; body[0] = body[0].slice(t[0].length); }
    const inner = blocks(body, depth + 1).map((b) => (b.t === "p" && tight ? b.inner : b.html)).join("");
    return `<li>${esc(task)}${inner}</li>`;
  }).join("");
  return { end: i, html: `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${li}</${tag}>` };
}

// Lines to blocks: [{ t: "p" | "other", html, inner? }].
function blocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = readFence(lines, i);
    if (fence) { out.push({ t: "other", html: codeBlock(fence.code, fence.lang).html }); i = fence.end; continue; }
    const head = headingOf(line);
    if (head) {
      const level = Math.min(6, head.level + 2); // the page's own title is the h1
      out.push({ t: "other", html: `<h${level}>${inline(head.text).html}</h${level}>` });
      i++;
      continue;
    }
    if (isRule(line)) { out.push({ t: "other", html: "<hr>" }); i++; continue; }
    if (/^\s*>/.test(line) && depth < MAX_DEPTH) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { quoted.push(lines[i].replace(/^\s*> ?/, "")); i++; }
      out.push({ t: "other", html: `<blockquote>${blocks(quoted, depth + 1).map((b) => b.html).join("")}</blockquote>` });
      continue;
    }
    if (LIST_ITEM.test(line) && depth < MAX_DEPTH) {
      const list = readList(lines, i, depth);
      out.push({ t: "other", html: list.html });
      i = list.end;
      continue;
    }
    const table = tableAt(lines, i);
    if (table) { out.push({ t: "other", html: renderTable(table) }); i = table.end; continue; }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !tableAt(lines, i)) { para.push(lines[i]); i++; }
    const inner = inline(para.join("\n")).html;
    out.push({ t: "p", inner, html: `<p>${inner}</p>` });
  }
  return out;
}

const normalize = (s) => String(s).replace(/\r\n?/g, "\n");

// Assistant text as HTML.
export function markdownToHtml(src) {
  return raw(blocks(normalize(src).split("\n")).map((b) => b.html).join(""));
}

// What the person typed, as HTML: line breaks and spacing kept as typed, fenced code as code
// blocks, web addresses as links. No other Markdown is interpreted, so pasted text, stack traces
// and shell commands appear exactly as they were written.
export function plainToHtml(src) {
  const lines = normalize(src).split("\n");
  const out = [];
  let text = [];
  const flushText = () => {
    const t = text.join("\n").replace(/^\n+|\s+$/g, "");
    text = [];
    if (t) out.push(`<div class="plain">${linkify(t)}</div>`);
  };
  for (let i = 0; i < lines.length;) {
    const fence = readFence(lines, i);
    if (fence) { flushText(); out.push(codeBlock(fence.code, fence.lang).html); i = fence.end; } else { text.push(lines[i]); i++; }
  }
  flushText();
  return raw(out.join(""));
}

function linkify(text) {
  let out = "";
  let last = 0;
  for (let i = text.indexOf("http"); i !== -1; i = text.indexOf("http", i + 1)) {
    if (i < last || (i > 0 && !URL_BEFORE.test(text[i - 1]))) continue;
    URL_AT.lastIndex = i;
    const m = URL_AT.exec(text);
    const url = m ? trimUrl(m[0]) : "";
    if (!hasHost(url)) continue;
    out += esc(text.slice(last, i)) + anchor(url, esc(url));
    last = i + url.length;
  }
  return out + esc(text.slice(last));
}

