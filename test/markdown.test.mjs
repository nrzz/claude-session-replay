import test from "node:test";
import assert from "node:assert/strict";
import { world, richSession, simpleSession, Transcript, SECRETS, PAYLOADS, countOf } from "./helpers.mjs";
import { replayFile } from "../src/replay.mjs";
import { neutralizeHtml } from "../src/markdown.mjs";
import { codeSpanEnd } from "../src/markdown-lite.mjs";

const w = world("md");
const rich = richSession(w, { id: "11111111-2222-4333-8444-555555555555" });
const opts = { home: w.home, format: "md" };
const md = replayFile(rich.file, opts).text;

// The Markdown outside fenced code blocks.
const outsideFences = (text) => {
  const out = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const m = /^(`{3,}|~{3,})/.exec(line);
    if (fence) { if (m && line.startsWith(fence) && line.trim() === fence) fence = ""; continue; }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return out.join("\n");
};

test("the export opens with the title and a line of facts", () => {
  assert.ok(md.startsWith("# Fix login redirect loop\n\n_Claude Code session `11111111` · project `webapp` · branch `fix/login` · 2026-10-01 12:00 → 2026-10-02 "));
  assert.match(md, /· 5 prompts · 15 tool calls · \d+K tokens · `claude-opus-5-5`_\n/);
  assert.ok(md.trimEnd().endsWith("_Exported with claude-replay 1.0.0._"));
  assert.ok(md.endsWith("\n"));
});

test("who said what: You and Claude headings, with the time (and the date when the day changes)", () => {
  assert.equal(countOf(md, "### You"), 5);
  assert.match(md, /### You · 2026-10-01 12:00 UTC\n/);
  assert.match(md, /### Claude · 12:01\n/);
  assert.match(md, /### You · 2026-10-02 14:04 UTC\n/);
});

test("each tool call is a one-line bullet with paths relative to the project", () => {
  for (const line of [
    "- Read `src/auth.ts`",
    "- Edit `src/auth.ts`",
    "- Write `test/auth.test.ts`",
    "- MultiEdit `README.md`",
    "- Bash `npm test` (failed)",
    "- Bash `npm run build`",
    "- Grep `redirect` in `src`",
    "- Glob `**/*.ts`",
    "- WebFetch https://example.com/docs",
    '- WebSearch "express redirect loop fix"',
    "- Subagent Review the change",
    "- MCP github › create_issue {\"title\":\"Follow up\",\"repo\":\"acme/webapp\"}",
    "- Skill `commit`",
  ]) assert.ok(md.includes(`${line}\n`), `missing: ${line}`);
  assert.ok(md.includes("- Updated the todo list (3 items)\n  - [x] write tests\n  - [ ] update docs\n  - [ ] release\n"));
  assert.ok(md.includes("- Bash `grep -rn \"a\\|b\" "), "an absolute path inside a command is left as the command had it");
});

test("tool output is in collapsible blocks, with failures open", () => {
  assert.match(md, /<details><summary>Output · 2 lines<\/summary>\n\n```text\nexport const GITHUB_TOKEN = "[^"]+";\nredirect\(callbackUrl\) \n```\n\n<\/details>/);
  assert.match(md, /<details open><summary>Error output · 3 lines<\/summary>\n\n```text\nFAIL test\/auth\.test\.ts\n  expected 1 received 2\nExit code 1\n```\n\n<\/details>/);
});

test("edits show as diffs, a written file as its content, nothing for a successful edit's own message", () => {
  assert.match(md, /<details><summary>Diff · \+1 −1<\/summary>\n\n```diff\n-redirect\(callbackUrl\) \n\+redirect\(safe\(callbackUrl\)\) \n```\n\n<\/details>/);
  assert.match(md, /<details><summary>Diff · \+2 −2<\/summary>\n\n```diff\n-# App\n\+# App \(fixed\)\n@@ next edit @@\n-login\n\+sign in\n```/);
  assert.match(md, /<details><summary>Content · 250 lines<\/summary>\n\n```ts\ntest\("case 0"/);
  assert.match(md, /case 199"[^\n]*\n```\n\n_… 50 more lines_\n\n<\/details>/);
  assert.ok(!md.includes("has been updated. Full build output"), "the success message of an edit is not repeated");
});

test("huge output is cut with a visible note", () => {
  assert.match(md, /_Truncated: [\d,]+ characters left out of the middle\._/);
  assert.ok(md.includes(`done ${SECRETS.slack}`));
});

test("thinking is in a collapsible block; images are named, not embedded", () => {
  assert.match(md, /<details><summary>Thinking<\/summary>\n\nthe token ghp_b+ is in the env\n\n<\/details>/);
  assert.match(md, /_\[image image\/png, \d+ B, not embedded in Markdown\]_/);
  assert.ok(!md.includes("base64"));
});

test("compaction, slash commands, shell commands and interruptions", () => {
  assert.ok(md.includes("---\n\n_The conversation was compacted here (auto, 167K tokens before)._"));
  assert.match(md, /<details><summary>Summary carried over the compaction<\/summary>\n\nThis session is being continued/);
  assert.ok(md.includes("`/review` src"));
  assert.match(md, /<details><summary>Command output · 1 line<\/summary>\n\n```text\nReview done: 2 comments\n```/);
  assert.ok(md.includes("`! git status --short`"));
  assert.match(md, /<details open><summary>Error output · 1 line<\/summary>\n\n```text\nwarning: nothing\n```/);
  assert.ok(md.includes("_Request interrupted by user_"));
});

test("Claude's own Markdown comes through as it was written", () => {
  assert.ok(md.includes("## Summary\n\nDone. The fix:"));
  assert.ok(md.includes("- see [the docs](https://example.com/docs?a=1&b=2) and [bad](javascript:alert(1))"), "the transcript's text is kept; this is a text format, not a page");
  assert.ok(md.includes("```ts\nconst x: number = 1; // note"));
  assert.ok(md.includes("| src/auth.ts | fixed |"));
});

test("the home folder is ~ and the project is kept in the one-liners only", () => {
  assert.ok(md.includes("~/notes.txt"));
  assert.ok(!md.includes(w.home));
});

test("the details blocks balance, and every one has a summary", () => {
  const text = outsideFences(md);
  assert.equal(countOf(text, "<details"), countOf(text, "</details>"));
  assert.equal(countOf(text, "<details"), countOf(text, "<summary>"));
  assert.ok(countOf(text, "<details") > 20);
});

test("a fence is always longer than any run of backticks inside what it holds", () => {
  const w2 = world("md");
  const t = new Transcript({ cwd: w2.project("p"), seed: "f" });
  t.prompt("go");
  t.run("Bash", { command: "echo" }, "before\n```\nfake end of fence\n```\n````\nafter");
  const out = replayFile(t.write(w2.claude).file, { home: w2.home, format: "md" }).text;
  assert.match(out, /`````text\nbefore\n```\nfake end of fence\n```\n````\nafter\n`````/);
});

test("a command that holds backticks is quoted so the line stays one piece of code", () => {
  const w2 = world("md");
  const t = new Transcript({ cwd: w2.project("p"), seed: "q" });
  t.prompt("go");
  t.run("Bash", { command: "echo `date` | cat" }, "x");
  const out = replayFile(t.write(w2.claude).file, { home: w2.home, format: "md" }).text;
  assert.ok(out.includes("- Bash ``echo `date` | cat``\n"));
});

test("raw HTML in the transcript is neutralized outside code, and left literal inside code", () => {
  const w2 = world("md");
  const t = new Transcript({ cwd: w2.project("p"), seed: "h" });
  t.prompt("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
  t.say("Use `<b>bold</b>` or:\n\n```html\n<div onclick=\"x()\">ok</div>\n```\n\nbut not <iframe src=javascript:alert(2)></iframe> or </details>.");
  t.run("Bash", { command: "echo '</details><script>alert(3)</script>'" }, "</details>\n<script>alert(4)</script>");
  const out = replayFile(t.write(w2.claude).file, { home: w2.home, format: "md" }).text;
  const outside = outsideFences(out);
  assert.ok(out.includes("&lt;script>alert(1)&lt;/script> and &lt;img src=x onerror=alert(1)>"));
  assert.ok(out.includes("Use `<b>bold</b>` or:"), "inline code is literal");
  assert.ok(out.includes('```html\n<div onclick="x()">ok</div>\n```'), "fenced code is literal");
  assert.ok(out.includes("but not &lt;iframe src=javascript:alert(2)>&lt;/iframe> or &lt;/details>."));
  assert.ok(!/<(script|img|iframe)/i.test(outside.replace(/`[^`]*`/g, "")), "no raw tag outside code");
  const live = outside.replace(/``[^`]*``|`[^`]*`/g, ""); // what a Markdown renderer would see as markup
  assert.equal(countOf(live, "<details"), countOf(live, "</details>"));
  assert.ok(out.includes("```text\n</details>\n<script>alert(4)</script>\n```"), "tool output stays literal inside its fence");
});

// The text a Markdown renderer would treat as markup: no fenced code, no code spans.
function liveText(text) {
  const lines = outsideFences(text).split("\n");
  const joined = lines.join("\n");
  let out = "";
  for (let i = 0; i < joined.length;) {
    if (joined[i] !== "`") { out += joined[i++]; continue; }
    let run = 1;
    while (joined[i + run] === "`") run++;
    const end = codeSpanEnd(joined, i + run, run);
    if (end === -1) { out += "`".repeat(run); i += run; } else i = end + run;
  }
  return out;
}

test("every field of a record that reaches the header or a one-liner is made safe, not only the conversation text", () => {
  const w2 = world("md");
  const hostile = "<img src=x onerror=alert(1)>";
  const t = new Transcript({ cwd: `/work/${hostile}\``, branch: `feat/<b>\`x`, model: "claude<script>alert(1)</script>", seed: "fields" });
  t.prompt("go");
  t.run(`<svg onload=alert(2)>`, { a: 1 }, "ok");
  t.run("Bash", { command: `echo '<script>alert(3)</script>'\n\necho "${hostile}"` }, "ok");
  t.compact({ trigger: "<iframe src=x>", preTokens: 5 });
  t.user("<command-name>/a\n\nb</command-name>");
  t.bashInput(`echo '${hostile}'\n\n<b>second line</b>`);
  t.say("done");
  t.customTitle(`line one\n\n${hostile}`);
  const out = replayFile(t.write(w2.claude).file, { home: w2.home, format: "md" }).text;
  const live = liveText(out).replace(/<\/?(?:details|summary)(?: open)?>/g, "");
  assert.ok(!/<[a-zA-Z/!]/.test(live), `a live tag outside code: ${live.match(/<[a-zA-Z/!][^\n]{0,50}/)}`);
  assert.ok(out.startsWith("# line one &lt;img src=x onerror=alert(1)>\n"), "a title is one line");
  assert.equal(countOf(live, "<details"), 0, "no stray details");
});

test("neutralizeHtml: only < outside code changes", () => {
  assert.equal(neutralizeHtml("a <b> c"), "a &lt;b> c");
  assert.equal(neutralizeHtml("`<b>` and <i>"), "`<b>` and &lt;i>");
  assert.equal(neutralizeHtml("``a<b``c <d>"), "``a<b``c &lt;d>");
  assert.equal(neutralizeHtml("```\n<x>\n```\n<y>"), "```\n<x>\n```\n&lt;y>");
  assert.equal(neutralizeHtml("an `unclosed <b> span"), "an `unclosed &lt;b> span");
  assert.equal(neutralizeHtml("~~~\n<x>\n~~~"), "~~~\n<x>\n~~~");
  assert.equal(neutralizeHtml("multi\n`line <b>\nspan` <c>"), "multi\n`line <b>\nspan` &lt;c>");
});

test("every hostile payload leaves the Markdown without a live tag outside code", () => {
  for (const payload of PAYLOADS) {
    const w2 = world("md");
    const e = richSession(w2, { id: "44444444-2222-4333-8444-555555555555", extra: payload, title: `T ${payload}` });
    const out = replayFile(e.file, { home: w2.home, format: "md" }).text;
    const outside = outsideFences(out).replace(/``[^`]*``|`[^`]*`/g, "");
    const own = outside.replace(/<\/?details( open)?>|<\/?summary>/g, "");
    assert.ok(!/<[a-zA-Z/]/.test(own), `a raw tag outside code for ${payload}: ${own.match(/<[a-zA-Z/][^\n]{0,40}/)}`);
  }
});

test("--no-tools leaves out every tool line and block; --no-thinking leaves out thinking", () => {
  const noTools = replayFile(rich.file, { ...opts, tools: false }).text;
  assert.ok(!noTools.includes("- Bash") && !noTools.includes("```diff") && !noTools.includes("npm test"));
  assert.ok(noTools.includes("tool calls (not shown)") || noTools.includes("15 tool calls (not shown)"));
  assert.ok(noTools.includes("The route regex is"));
  const noThinking = replayFile(rich.file, { ...opts, thinking: false }).text;
  assert.ok(!noThinking.includes("Thinking") && !noThinking.includes("is in the env"));
});

test("--redact removes secrets, shortens paths and leaves out thinking and images", () => {
  const out = replayFile(rich.file, { ...opts, redact: true }).text;
  for (const secret of Object.values(SECRETS)) assert.ok(!out.includes(secret), `leaked ${secret}`);
  assert.ok(!out.includes(w.base) && !out.includes("Thinking"));
  assert.ok(out.includes("[REDACTED:github-token]") && out.includes("redacted"));
  assert.ok(out.includes("image omitted") || out.includes("[image omitted]"));
  assert.ok(out.includes("Fix the login redirect loop in src/auth.ts."), "paths in the prompt are relative");
  assert.ok(out.includes("`<tool-results>/big-1.txt`") === false && out.includes("<tool-results>/big-1.txt"));
});

test("Windows paths: relative to the project and ~ for the home folder, on any OS", () => {
  const w2 = world("md");
  const cwd = "C:\\Users\\alice\\code\\web-app";
  const t = new Transcript({ cwd, seed: "win", branch: "main" });
  t.prompt(`Look at ${cwd}\\src\\a.ts and C:\\Users\\alice\\notes.txt`);
  t.run("Read", { file_path: `${cwd}\\src\\a.ts` }, "x");
  t.run("Edit", { file_path: `C:/Users/Alice/code/Web-App/src/b.ts`, old_string: "a", new_string: "b" }, "ok");
  t.run("Bash", { command: `cd ${cwd} && dir C:\\Users\\alice\\notes.txt` }, "ok");
  t.say(`Done in ${cwd}\\src\\a.ts`);
  const file = t.write(w2.claude).file;
  const plain = replayFile(file, { home: "C:\\Users\\alice", format: "md" }).text;
  assert.ok(plain.includes("- Read `src/a.ts`\n"));
  assert.ok(plain.includes("- Edit `src/b.ts`\n"), "any letter case and either slash");
  assert.ok(plain.includes("Look at ~/code/web-app/src/a.ts and ~/notes.txt"), "without --redact only the home folder changes, and the project is inside it");
  const red = replayFile(file, { home: "C:\\Users\\alice", format: "md", redact: true }).text;
  assert.ok(red.includes("Look at src/a.ts and ~/notes.txt"));
  assert.ok(red.includes("Bash `cd . && dir ~/notes.txt`"));
  assert.ok(red.includes("Done in src/a.ts"));
  assert.ok(!red.includes("alice"));
});

test("a simple session is short and clean", () => {
  const w2 = world("md");
  const s = simpleSession(w2, { prompt: "How do I deploy?", answer: "Run `fly deploy`.", title: "Deploy question" });
  const out = replayFile(s.file, { home: w2.home, format: "md" }).text;
  assert.match(out, /^# Deploy question\n\n_Claude Code session `[0-9a-f]{8}` · project `webapp` · branch `main` · 2026-10-01 12:00 UTC · 1 prompt · 0 tool calls · /);
  assert.ok(out.includes("### You · 2026-10-01 12:00 UTC\n\nHow do I deploy?\n\n### Claude · 12:00\n\nRun `fly deploy`.\n"));
});
