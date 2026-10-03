// The HTML replay: one file, no network. Everything that comes from the transcript goes through
// the escaping templates in safe.mjs; the page's script and style sheet are fixed text (assets.mjs)
// and the page carries no transcript data except as escaped text and data: images.
import { h, raw, join } from "./safe.mjs";
import { markdownToHtml, plainToHtml, highlight, languageOf, diffRow } from "./markdown-lite.mjs";
import { diffLines, diffStats } from "./diff.mjs";
import { CSP, CSS, CLIENT_JS } from "./assets.mjs";
import { REPO_URL, VERSION } from "./version.mjs";
import { compact, kb, num, plural, utcDay, utcMinute, utcStamp, utcTime } from "./util.mjs";

const KINDS = new Set(["read", "edit", "write", "bash", "search", "web", "agent", "todo", "mcp", "plan", "other"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

// The time of a turn: the clock time, with the date too when the day changes.
function timeTag(ts, ctx) {
  if (!ts) return "";
  const day = utcDay(ts);
  const text = day && day !== ctx.day ? `${day} ${utcTime(ts)}` : utcTime(ts);
  if (day) ctx.day = day;
  return h`<time${ISO.test(ts) ? h` datetime="${ts}"` : ""} title="${`${utcStamp(ts)} UTC`}">${text}</time>`;
}

// A turn's tokens: what it sent in new (input and cache writes), what it re-read from the cache
// (every request of a turn reads the whole conversation again), and what Claude wrote.
function tokenTag(tok) {
  if (!tok) return "";
  const fresh = tok.input + tok.cacheWrite;
  if (!fresh && !tok.cacheRead && !tok.output) return "";
  const title = `input ${num(tok.input)} · cache write ${num(tok.cacheWrite)} · cache read ${num(tok.cacheRead)} · output ${num(tok.output)}`;
  return h`<span class="tok" title="${title}">in ${compact(fresh)}${tok.cacheRead ? ` · cached ${compact(tok.cacheRead)}` : ""} · out ${compact(tok.output)}</span>`;
}

function imageTags(images) {
  return join((images || []).map((im) => (im.omitted
    ? h`<span class="imgnote">${im.document ? "document" : "image"} omitted${im.bytes ? ` (${kb(im.bytes)}; --max-output 0 keeps large images)` : ""}</span> `
    : h`<img class="shot" alt="Image from the session" src="${`data:${im.media};base64,${im.data}`}">`)));
}

const truncNote = (omitted) => (omitted
  ? h`<div class="trunc">truncated: ${num(omitted)} characters left out of the middle (export with --max-output to keep more)</div>`
  : "");

// Collapsed output of a tool or a command. Failures start open.
function outputBlock(res, { label = "Output", open = false } = {}) {
  const hasText = !!res.text && !!res.text.trim();
  const hasImages = !!(res.images && res.images.length);
  if (!hasText && !hasImages) return h`<div class="noout">${label}: empty</div>`;
  const summary = `${label}${res.lines ? ` · ${plural(res.lines, "line")}` : ""}`;
  return h`<details class="out${res.isError ? " err" : ""}"${open ? raw(" open") : ""}><summary>${summary}</summary>${hasText ? h`<pre>${res.text}</pre>` : ""}${truncNote(res.omitted)}${imageTags(res.images)}</details>`;
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

function diffPre(oldStr, newStr) {
  const ops = diffLines(oldStr.text, newStr.text);
  const changed = ops.some((op) => op.t === "+" || op.t === "-");
  const rows = ops.map((op) => {
    if (op.t === "…") return diffRow("fold", `⋯ ${plural(op.n, "unchanged line")}`);
    return diffRow(op.t === "+" ? "add" : op.t === "-" ? "del" : "ctx", `${op.t} ${op.s}`);
  });
  const note = truncNote(oldStr.omitted + newStr.omitted);
  return { stats: diffStats(ops), html: changed ? h`<pre class="diff">${rows}</pre>${note}` : h`<div class="noout">no change</div>` };
}

const statsHint = (s) => `+${s.added} −${s.removed}`;

// The expanded part of a tool call and the short hint shown on its summary line.
function toolParts(item) {
  const i = item.input || {};
  const result = item.result;
  const out = result ? outputBlock(result, { label: result.isError ? "Error" : "Output", open: !!result.isError }) : h`<div class="noout">no result recorded</div>`;
  const resultHint = !result ? "no result" : result.lines ? plural(result.lines, "line") : "empty";
  switch (item.name) {
    case "Edit": {
      const d = diffPre(i.old_string, i.new_string);
      return {
        hint: statsHint(d.stats),
        body: [h`<div class="path">${i.file_path}${i.replace_all ? " · every occurrence" : ""}</div>`, d.html, result?.isError ? out : ""],
      };
    }
    case "MultiEdit": {
      const total = { added: 0, removed: 0 };
      const diffs = (i.edits || []).map((e, n) => {
        const d = diffPre(e.old_string, e.new_string);
        total.added += d.stats.added; total.removed += d.stats.removed;
        return h`<div class="path">edit ${n + 1} of ${(i.edits || []).length}</div>${d.html}`;
      });
      return {
        hint: statsHint(total),
        body: [h`<div class="path">${i.file_path}</div>`, diffs, i.moreEdits ? h`<div class="more">… ${plural(i.moreEdits, "more edit")} not shown</div>` : "", result?.isError ? out : ""],
      };
    }
    case "Write":
      return {
        hint: plural(i.totalLines, "line"),
        body: [
          h`<div class="path">${i.file_path} · ${plural(i.totalLines, "line")}</div>`,
          h`<pre class="code">${highlight(i.content.text, languageOf(i.file_path))}</pre>`,
          i.moreLines ? h`<div class="more">… ${plural(i.moreLines, "more line")}</div>` : "",
          truncNote(i.content.omitted),
          result?.isError ? out : "",
        ],
      };
    case "Bash": case "PowerShell":
      return {
        hint: result ? resultHint : "no result",
        body: [
          i.description ? h`<div class="desc">${i.description}</div>` : "",
          h`<pre class="cmd">${highlight(i.command.text, item.name === "Bash" ? "sh" : "ps")}</pre>${truncNote(i.command.omitted)}`,
          out,
        ],
      };
    case "TodoWrite":
      return {
        hint: "",
        body: h`<ul class="todos">${(i.todos || []).map((t) => h`<li${t.status === "completed" ? h` class="done"` : ""}>${t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} ${t.content}</li>`)}</ul>`,
      };
    case "ExitPlanMode":
      return { hint: "", body: [h`<div class="md">${markdownToHtml(i.plan.text)}</div>`, truncNote(i.plan.omitted), out] };
    case "Task": case "Agent":
      return {
        hint: resultHint,
        body: [
          i.description || i.subagent_type ? h`<div class="desc">${[i.description, i.subagent_type].filter(Boolean).join(" · ")}</div>` : "",
          plainToHtml(i.prompt.text),
          truncNote(i.prompt.omitted),
          out,
          item.sub ? subSteps(item.sub) : "",
        ],
      };
    default:
      return { hint: resultHint, body: [inputView(i), out] };
  }
}

// The input of a tool without a special view: name: value rows, or JSON when it is nested.
function inputView(i) {
  if (i.pairs) return h`<dl class="kv">${i.pairs.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
  return [h`<pre>${i.json.text}</pre>`, truncNote(i.json.omitted)];
}

function subSteps(sub) {
  return h`<details class="subsession"><summary>Subagent steps · ${plural(sub.toolCalls, "tool call")}</summary><div class="subitems">${items(sub.items)}${sub.more ? h`<div class="more">… ${plural(sub.more, "more step")} not shown</div>` : ""}</div></details>`;
}

function renderTool(item) {
  const kind = KINDS.has(item.kind) ? item.kind : "other";
  const { body, hint } = toolParts(item);
  const failed = !!item.result?.isError;
  return h`<details class="tool kind-${kind}${failed ? " failed" : ""}"><summary><span class="tn">${item.label}</span>${item.detail ? h`<code class="td">${item.detail}${item.where ? h`<span class="dim"> in </span>${item.where}` : ""}</code>` : ""}${failed ? h`<span class="badge err">failed</span>` : ""}${hint ? h`<span class="ts">${hint}</span>` : ""}</summary><div class="tb">${body}</div></details>`;
}

// The parts of a Claude turn (or of a subagent's steps), in order.
function items(list, ctx = { tools: true, thinking: true }) {
  return list.map((it) => {
    if (it.type === "text") return h`<div class="md${it.error ? " apierr" : ""}">${markdownToHtml(it.text)}</div>`;
    if (it.type === "thinking") return ctx.thinking ? h`<div class="thinking">${it.text}</div>` : "";
    if (it.type === "tool") return ctx.tools ? renderTool(it) : "";
    return "";
  });
}

// ---------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------

function renderYou(t, ctx, id) {
  const parts = [];
  if (t.command) {
    parts.push(h`<div class="cmd"><span class="chip">${t.command.name}</span>${t.command.args ? h` <span class="args">${t.command.args}</span>` : ""}</div>`);
    if (t.output) parts.push(outputBlock(t.output, { label: "Command output" }));
  }
  if (t.bash) {
    parts.push(h`<div class="cmd"><span class="chip">!</span><code>${t.bash.command}</code></div>`);
    if (t.bash.stdout?.text?.trim()) parts.push(outputBlock(t.bash.stdout));
    if (t.bash.stderr?.text?.trim()) parts.push(outputBlock(t.bash.stderr, { label: "Error output", open: true }));
  }
  if (t.text) parts.push(plainToHtml(t.text));
  if (t.images?.length) parts.push(imageTags(t.images));
  return h`<section class="turn you" id="${id}"><div class="who"><span class="name">You</span>${timeTag(t.ts, ctx)}</div><div class="body">${parts}</div></section>`;
}

function renderClaude(t, ctx, id) {
  const shown = t.items.filter((it) => (it.type !== "tool" || ctx.tools) && (it.type !== "thinking" || ctx.thinking));
  if (!shown.length) return "";
  const onlyThinking = shown.every((it) => it.type === "thinking");
  const model = t.model && t.model !== ctx.model ? h`<span class="mdl">${t.model}</span>` : "";
  if (t.model) ctx.model = t.model;
  return h`<section class="turn claude${onlyThinking ? " only-think" : ""}" id="${id}"><div class="who"><span class="name">Claude</span>${model}${timeTag(t.ts, ctx)}${tokenTag(t.tokens)}</div><div class="body">${items(shown, ctx)}</div></section>`;
}

function renderTurn(t, ctx) {
  const id = `t${ctx.n + 1}`;
  let html = "";
  if (t.type === "you") html = renderYou(t, ctx, id);
  else if (t.type === "claude") html = renderClaude(t, ctx, id);
  else if (t.type === "compact") {
    const detail = [t.trigger, t.preTokens ? `${compact(t.preTokens)} tokens before` : ""].filter(Boolean).join(", ");
    html = h`<div class="turn note compact" id="${id}"><span>Conversation compacted${detail ? ` (${detail})` : ""}</span>${timeTag(t.ts, ctx)}</div>`;
  } else if (t.type === "summary") {
    html = h`<section class="turn" id="${id}"><details class="sum"><summary>Summary carried over the compaction</summary><div class="md">${markdownToHtml(t.text)}</div></details></section>`;
  } else if (t.type === "note") {
    html = t.output
      ? h`<div class="turn note has-out" id="${id}">${outputBlock(t.output, { label: "Command output" })}</div>`
      : h`<div class="turn note" id="${id}"><span>${t.text}</span>${timeTag(t.ts, ctx)}</div>`;
  }
  if (html) ctx.n++;
  return html;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

function dateRange(a, b) {
  if (!a) return "";
  const start = utcMinute(a);
  if (!b || utcMinute(b) === start) return `${start} UTC`;
  const end = utcMinute(b);
  return `${start} → ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end} UTC`;
}

const pill = (label, value, title = "") => h`<span class="pill"${title ? h` title="${title}"` : ""}>${label} <b>${value}</b></span>`;

// renderHtml(session, { theme: "auto" | "light" | "dark", tools, thinking, redacted }) -> the page.
// tools and thinking (default true) say whether those parts are shown.
export function renderHtml(session, opts = {}) {
  const o = { theme: "auto", tools: true, thinking: true, redacted: false, ...opts };
  const ctx = { day: "", n: 0, model: "", tools: o.tools, thinking: o.thinking };
  const turns = session.turns.map((t) => renderTurn(t, ctx)).filter((x) => x);
  const claudeItems = session.turns.filter((t) => t.type === "claude").flatMap((t) => t.items);
  const hasTools = o.tools && claudeItems.some((it) => it.type === "tool");
  const hasThinking = o.thinking && claudeItems.some((it) => it.type === "thinking");
  const hasFolds = hasTools || session.turns.some((t) => t.type === "summary");
  const forced = o.theme === "dark" || o.theme === "light" ? o.theme : "";
  const c = session.counts;
  const tk = session.tokens;
  const range = dateRange(session.started, session.ended);
  const pills = [
    session.project ? pill("project", session.project) : "",
    session.branch ? pill("branch", session.branch) : "",
    session.models.length ? pill(session.models.length === 1 ? "model" : "models", session.models.join(", ")) : "",
    pill("prompts", num(c.prompts)),
    pill("tool calls", `${num(c.toolCalls)}${o.tools ? "" : " (not shown)"}`),
    tk.total ? pill("tokens", compact(tk.total), `input ${num(tk.input)} · cache read ${num(tk.cacheRead)} · cache write ${num(tk.cacheWrite)} · output ${num(tk.output)}`) : "",
    o.redacted ? pill("export", "redacted") : "",
  ];
  const bar = h`<div class="bar" role="search"><input id="q" type="search" placeholder="Filter turns (press / to focus)" aria-label="Filter turns" autocomplete="off"><span id="count" aria-live="polite"></span>${hasTools ? raw('<button type="button" data-act="tools" aria-pressed="true">Tool calls</button>') : ""}${hasThinking ? raw('<button type="button" data-act="thinking" aria-pressed="false">Thinking</button>') : ""}${hasFolds ? raw('<button type="button" data-act="expand" data-open="0">Expand all</button>') : ""}<button type="button" data-act="theme">Theme: auto</button></div>`;
  const page = h`<html lang="en"${forced ? raw(` data-theme="${forced}"`) : ""}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${raw(CSP)}"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="${forced || "light dark"}"><meta name="referrer" content="no-referrer"><meta name="generator" content="claude-replay ${VERSION}"><title>${session.title} · Claude Code session</title><style>${raw(CSS)}</style></head><body><div class="wrap"><header><h1>${session.title}</h1><p class="sub">Claude Code session${session.id ? ` ${session.id.slice(0, 8)}` : ""}${range ? ` · ${range}` : ""}</p><div class="meta">${pills}</div></header>${bar}<main id="turns">${turns.length ? turns : h`<p class="empty">This session has no conversation to show.</p>`}</main><footer>Exported with claude-replay ${VERSION} (${REPO_URL.replace("https://", "")}). A single file: it loads nothing from the network.</footer></div><script>${raw(CLIENT_JS)}</script></body></html>`;
  return `<!doctype html>\n${page.html}\n`;
}
