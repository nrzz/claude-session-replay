// The Markdown export: who said what, one line per tool call with paths relative to the project,
// and collapsible <details> blocks for diffs and tool output. Meant for pull requests, issues and
// docs, so raw HTML in the transcript is neutralized: "<" outside code becomes "&lt;".
import { diffLines, diffStats } from "./diff.mjs";
import { codeSpanEnd, readFence } from "./markdown-lite.mjs";
import { compact, kb, num, plural, utcDay, utcMinute, utcStamp, utcTime } from "./util.mjs";
import { VERSION } from "./version.mjs";

// "<" becomes "&lt;" everywhere except in fenced code and inline code spans.
export function neutralizeHtml(text) {
  const lines = String(text).split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(escapeOutsideSpans(para.join("\n")));
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const fence = readFence(lines, i);
    if (fence) { flush(); out.push(lines.slice(i, fence.end).join("\n")); i = fence.end; } else { para.push(lines[i]); i++; }
  }
  flush();
  return out.join("\n");
}
function escapeOutsideSpans(s) {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const end = codeSpanEnd(s, i + run, run);
      if (end !== -1) { out += s.slice(i, end + run); i = end + run; } else { out += "`".repeat(run); i += run; }
    } else { out += c === "<" ? "&lt;" : c; i++; }
  }
  return out;
}

// A code fence that no line of the text can close: longer than any run of backticks inside it.
function fence(text, lang = "") {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const mark = "`".repeat(Math.max(3, longest + 1));
  return `${mark}${lang}\n${String(text).replace(/\n$/, "")}\n${mark}`;
}
function codeSpan(s) {
  const t = String(s);
  const longest = Math.max(0, ...(t.match(/`+/g) || []).map((r) => r.length));
  const mark = "`".repeat(longest + 1);
  return /^`|`$/.test(t) ? `${mark} ${t} ${mark}` : `${mark}${t}${mark}`;
}

// One line of text: whitespace collapsed, so it cannot hold a blank line that would end a paragraph
// or a code span (and with it the protection a code span gives).
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const details = (summary, body, open = false) => `<details${open ? " open" : ""}><summary>${summary.replace(/</g, "&lt;")}</summary>\n\n${body}\n\n</details>`;

function outputBlock(res, label = "Output", open = false) {
  if (!res || !res.text || !res.text.trim()) return "";
  const note = res.omitted ? `\n\n_Truncated: ${num(res.omitted)} characters left out of the middle._` : "";
  return details(`${label}${res.lines ? ` · ${plural(res.lines, "line")}` : ""}`, fence(res.text, "text") + note, open);
}

function diffBlock(oldStr, newStr) {
  const ops = diffLines(oldStr.text, newStr.text);
  const text = ops.map((op) => (op.t === "…" ? `@@ ${plural(op.n, "unchanged line")} @@` : `${op.t}${op.s}`)).join("\n");
  return { stats: diffStats(ops), text, changed: ops.some((op) => op.t === "+" || op.t === "-") };
}

function toolMarkdown(item) {
  const i = item.input || {};
  const result = item.result;
  const detail = (item.detail ? (item.code ? codeSpan(item.detail) : neutralizeHtml(item.detail)) : "") + (item.where ? ` in ${codeSpan(item.where)}` : "");
  const failed = result?.isError ? " (failed)" : "";
  const parts = [`- ${neutralizeHtml(flat(item.label))}${detail ? ` ${detail}` : ""}${failed}`];
  const blocks = [];
  switch (item.name) {
    case "Edit": {
      const d = diffBlock(i.old_string, i.new_string);
      if (d.changed) blocks.push(details(`Diff · +${d.stats.added} −${d.stats.removed}`, fence(d.text, "diff")));
      break;
    }
    case "MultiEdit": {
      const ds = (i.edits || []).map((e) => diffBlock(e.old_string, e.new_string)).filter((d) => d.changed);
      const added = ds.reduce((n, d) => n + d.stats.added, 0);
      const removed = ds.reduce((n, d) => n + d.stats.removed, 0);
      if (ds.length) blocks.push(details(`Diff · +${added} −${removed}`, fence(ds.map((d) => d.text).join("\n@@ next edit @@\n"), "diff")));
      break;
    }
    case "Write": {
      const lang = (String(i.file_path || "").match(/\.([A-Za-z0-9]+)$/) || [])[1] || "";
      const more = i.moreLines ? `\n\n_… ${plural(i.moreLines, "more line")}_` : "";
      blocks.push(details(`Content · ${plural(i.totalLines, "line")}`, fence(i.content.text, lang) + more));
      break;
    }
    case "TodoWrite":
      for (const t of i.todos || []) parts.push(`  - [${t.status === "completed" ? "x" : " "}] ${neutralizeHtml(t.content)}`);
      break;
    case "ExitPlanMode":
      blocks.push(details("Plan", neutralizeHtml(i.plan.text)));
      break;
    case "Task": case "Agent":
      blocks.push(details("Prompt", fence(i.prompt.text, "text")));
      break;
    default:
  }
  const writesOnly = item.name === "Edit" || item.name === "MultiEdit" || item.name === "Write";
  if (!writesOnly || result?.isError) {
    const block = outputBlock(result, result?.isError ? "Error output" : "Output", !!result?.isError);
    if (block) blocks.push(block);
  }
  return { line: parts.join("\n"), blocks };
}

function imageLines(images) {
  return (images || []).map((im) => (im.omitted
    ? `_[${im.document ? "document" : "image"} omitted${im.bytes ? ` (${kb(im.bytes)})` : ""}]_`
    : `_[image ${im.media}, ${kb(Math.round(im.data.length * 0.75))}, not embedded in Markdown]_`));
}

// renderMarkdown(session, { tools, thinking, redacted }) -> text
export function renderMarkdown(session, opts = {}) {
  const o = { tools: true, thinking: true, redacted: false, ...opts };
  const out = [`# ${neutralizeHtml(flat(session.title))}`, ""];
  const c = session.counts;
  const facts = [
    `Claude Code session ${codeSpan(flat(session.id || "").slice(0, 8))}`,
    session.project ? `project ${codeSpan(flat(session.project))}` : "",
    session.branch ? `branch ${codeSpan(flat(session.branch))}` : "",
    session.started ? `${utcMinute(session.started)}${session.ended && utcMinute(session.ended) !== utcMinute(session.started) ? ` → ${utcMinute(session.ended)}` : ""} UTC` : "",
    plural(c.prompts, "prompt"),
    `${plural(c.toolCalls, "tool call")}${o.tools ? "" : " (not shown)"}`,
    session.tokens.total ? `${compact(session.tokens.total)} tokens` : "",
    session.models.length ? session.models.map((m) => codeSpan(flat(m))).join(", ") : "",
    o.redacted ? "redacted" : "",
  ].filter(Boolean);
  out.push(`_${facts.join(" · ")}_`, "");

  let day = "";
  const stamp = (ts) => {
    if (!ts) return "";
    const d = utcDay(ts);
    const text = d && d !== day ? `${utcStamp(ts).slice(0, 16)} UTC` : utcTime(ts).slice(0, 5);
    if (d) day = d;
    return ` · ${text}`;
  };

  for (const t of session.turns) {
    if (t.type === "you") {
      out.push(`### You${stamp(t.ts)}`, "");
      if (t.command) out.push(`${codeSpan(flat(t.command.name))}${t.command.args ? ` ${neutralizeHtml(t.command.args)}` : ""}`, "");
      if (t.command && t.output) { const b = outputBlock(t.output, "Command output"); if (b) out.push(b, ""); }
      if (t.bash) {
        out.push(codeSpan(flat(`! ${t.bash.command}`)), "");
        for (const [res, label, open] of [[t.bash.stdout, "Output", false], [t.bash.stderr, "Error output", true]]) {
          const b = outputBlock(res, label, open);
          if (b) out.push(b, "");
        }
      }
      if (t.text) out.push(neutralizeHtml(t.text.trim()), "");
      const imgs = imageLines(t.images);
      if (imgs.length) out.push(imgs.join("\n"), "");
    } else if (t.type === "claude") {
      const shown = t.items.filter((it) => (it.type !== "tool" || o.tools) && (it.type !== "thinking" || o.thinking));
      if (!shown.length) continue;
      out.push(`### Claude${stamp(t.ts)}`, "");
      for (const it of shown) {
        if (it.type === "text") out.push(neutralizeHtml(it.text.trim()), "");
        else if (it.type === "thinking") out.push(details("Thinking", neutralizeHtml(it.text.trim())), "");
        else if (it.type === "tool") {
          const m = toolMarkdown(it);
          out.push(m.line, "");
          for (const b of m.blocks) out.push(b, "");
        }
      }
    } else if (t.type === "compact") {
      const detail = [t.trigger, t.preTokens ? `${compact(t.preTokens)} tokens before` : ""].filter(Boolean).join(", ");
      out.push("---", "", `_The conversation was compacted here${detail ? ` (${neutralizeHtml(flat(detail))})` : ""}._`, "");
    } else if (t.type === "summary") {
      out.push(details("Summary carried over the compaction", neutralizeHtml(t.text.trim())), "");
    } else if (t.type === "note") {
      if (t.output) { const b = outputBlock(t.output, "Command output"); if (b) out.push(b, ""); } else out.push(`_${neutralizeHtml(flat(t.text))}_`, "");
    }
  }
  out.push("---", "", `_Exported with claude-replay ${VERSION}._`);
  return `${out.join("\n").trim()}\n`; // no blank-line squeezing: it would alter code and output inside fences
}
