import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { ROOT, parseHtml, textOf, countOf } from "./helpers.mjs";
import { buildExample, demoTranscript, EXAMPLE } from "../scripts/build-example.mjs";
import { findSecrets } from "../src/redact.mjs";
import { CLIENT_JS, CSP } from "../src/assets.mjs";

const built = buildExample();
const checkedIn = fs.readFileSync(EXAMPLE, "utf8");

test("docs/example.html is exactly what scripts/build-example.mjs produces (run: npm run build:example)", () => {
  assert.equal(checkedIn, built);
  assert.equal(buildExample(), built, "building twice gives the same bytes");
});

test("the example is a single safe page", () => {
  const p = parseHtml(checkedIn);
  assert.deepEqual(p.errors, []);
  assert.equal(p.scripts.length, 1);
  assert.equal(p.scripts[0], CLIENT_JS);
  assert.ok(p.tags.some((t) => t.name === "meta" && t.attrs.content === CSP));
  for (const t of p.tags) {
    if (t.attrs.src !== undefined) assert.match(t.attrs.src, /^data:image\/png;base64,/);
    if (t.attrs.href !== undefined) assert.match(t.attrs.href, /^https:\/\/example\.com\/acme\/webapp\/pull\/482$/);
    assert.ok(!Object.keys(t.attrs).some((k) => k.startsWith("on")));
  }
});

test("the example shows what the README says a replay shows", () => {
  const checks = {
    "a header": /<span class="pill">branch <b>fix\/login-redirect<\/b>/,
    "a day change": /<time datetime="2026-10-02T[^"]+" title="[^"]+">2026-10-02 /,
    "red and green diffs": /<span class="dl del">- .*<span class="dl add">\+ /,
    "a failed command": /<details class="tool kind-bash failed">/,
    "a written file": /<span class="tn">Write<\/span><code class="td">tests\/auth\/expired-session\.test\.ts<\/code>/,
    "a todo list": /<ul class="todos">/,
    "cut output with its note": /<div class="trunc">truncated: /,
    "thinking behind a switch": /<div class="thinking">/,
    "an image": /<img class="shot" alt="Image from the session" src="data:image\/png;base64,/,
    "subagent steps": /<details class="subsession"><summary>Subagent steps · 2 tool calls<\/summary>/,
    "an MCP call": /<span class="tn">MCP<\/span><code class="td">github › create_pull_request/,
    "a compaction": /Conversation compacted \(auto, 162K tokens before\)/,
    "a slash command": /<span class="chip">\/cost<\/span>/,
    "a shell command": /<span class="chip">!<\/span><code>git status --short<\/code>/,
    "a table": /<table><thead>/,
    "highlighted code": /<span class="k">export<\/span> <span class="k">function<\/span> readSession/,
    "a link": /<a href="https:\/\/example\.com\/acme\/webapp\/pull\/482" rel="noopener noreferrer" target="_blank">PR #482<\/a>/,
  };
  for (const [what, re] of Object.entries(checks)) assert.match(checkedIn, re, what);
});

test("the example is small enough to open anywhere and to keep in the repository", () => {
  const bytes = Buffer.byteLength(checkedIn);
  assert.ok(bytes < 100 * 1024, `${bytes} bytes`);
  console.log(`# docs/example.html: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
});

test("the example holds nothing from the machine that built it", () => {
  const text = textOf(checkedIn);
  for (const needle of ["C:\\Users", "/Users/", "AppData", "cr-example", os.userInfo().username, process.env.USERNAME, process.env.USER].filter((x) => x && x.length > 2)) {
    assert.ok(!checkedIn.includes(needle) && !text.includes(needle), `contains ${needle}`);
  }
  assert.deepEqual(findSecrets(checkedIn), {}, "nothing in it looks like a secret");
  assert.ok(!checkedIn.includes(ROOT));
});

test("the demo session is a real transcript: every record is valid JSON with the fields Claude Code writes", () => {
  const t = demoTranscript();
  const conversation = t.records.filter((r) => r.uuid);
  assert.ok(conversation.length > 50);
  for (const r of conversation) for (const k of ["uuid", "sessionId", "timestamp", "cwd", "version", "isSidechain"]) assert.ok(k in r, `${r.type} lacks ${k}`);
  assert.equal(countOf(JSON.stringify(t.records), '"type":"tool_use"'), 18, "the header of the page says 18 tool calls");
  assert.equal(t.subagents.length, 1);
});
