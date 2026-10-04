import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { world, richSession, simpleSession, parseHtml, textOf, countOf, SECRETS, PAYLOADS, PNG_1PX, Transcript } from "./helpers.mjs";
import { replayFile } from "../src/replay.mjs";
import { renderHtml } from "../src/html.mjs";
import { CLIENT_JS, CSP, CSS } from "../src/assets.mjs";
import { esc } from "../src/safe.mjs";

const w = world("html");
const rich = richSession(w, { id: "11111111-2222-4333-8444-555555555555" });
const base = { home: w.home };
const full = replayFile(rich.file, base);
const html = full.text;
const redacted = replayFile(rich.file, { ...base, redact: true });
const parsed = parseHtml(html);

// The page's markup, without <span>s: syntax highlighting adds them depending on what the code says.
const signature = (page) => parseHtml(page).tags
  .filter((t) => t.name !== "span")
  .map((t) => (t.close ? `/${t.name}` : `${t.name}${t.attrs.class ? `.${t.attrs.class}` : ""}`))
  .join(" ");

// --- the page as a whole ----------------------------------------------------------------------

test("the page is well-formed: every tag balances and no stray < appears", () => {
  assert.deepEqual(parsed.errors, []);
  assert.ok(html.startsWith("<!doctype html>\n<html lang=\"en\">"));
  assert.equal(countOf(html, "<details"), countOf(html, "</details>"));
  assert.equal(countOf(html, "<section"), countOf(html, "</section>"));
});

test("a strict Content-Security-Policy is the first thing in the head", () => {
  assert.equal(CSP, "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
  const meta = parsed.tags.find((t) => t.name === "meta" && t.attrs["http-equiv"]);
  assert.equal(meta.attrs["http-equiv"], "Content-Security-Policy");
  assert.equal(meta.attrs.content, CSP);
  const names = parsed.tags.map((t) => t.name);
  assert.ok(names.indexOf("meta") < names.indexOf("style") && names.indexOf("meta") < names.indexOf("script"));
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<style>"));
});

test("the only script is ours, fixed text, and it does not contain the end of a script", () => {
  assert.equal(parsed.scripts.length, 1);
  assert.equal(parsed.scripts[0], CLIENT_JS);
  assert.equal(countOf(html, "<script"), 1);
  assert.equal(countOf(html, "</script"), 1);
  assert.ok(!CLIENT_JS.includes("</script") && !CSS.includes("</style"));
  assert.doesNotThrow(() => new vm.Script(CLIENT_JS), "the script is valid JavaScript");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|import\(/.test(CLIENT_JS), "the script never builds markup or touches the network");
});

test("no transcript data in a script tag: no JSON blocks, no data attributes", () => {
  assert.ok(!/type="application\/(ld\+)?json"/.test(html));
  assert.ok(!parsed.tags.some((t) => Object.keys(t.attrs).some((k) => k.startsWith("data-") && !["data-act", "data-open"].includes(k))));
});

test("nothing is loaded from outside: images are data: URLs, links are http(s) only, no frames or forms", () => {
  for (const t of parsed.tags) {
    assert.ok(!["iframe", "object", "embed", "form", "base", "link", "frame", "applet", "audio", "video", "source"].includes(t.name), `<${t.name}>`);
    if (t.attrs.src !== undefined) assert.match(t.attrs.src, /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/);
    if (t.attrs.href !== undefined) assert.match(t.attrs.href, /^https?:\/\//);
    for (const k of Object.keys(t.attrs)) assert.ok(!k.startsWith("on"), `${k} on <${t.name}>`);
  }
  assert.ok(!/@import|url\(/.test(CSS), "the style sheet loads nothing");
});

test("every link opens safely", () => {
  const anchors = parsed.tags.filter((t) => t.name === "a" && !t.close);
  assert.ok(anchors.length >= 1);
  for (const a of anchors) {
    assert.match(a.attrs.rel, /noopener/);
    assert.match(a.attrs.rel, /noreferrer/);
  }
});

test("the header shows title, dates, project, branch, models, prompts, tool calls and tokens", () => {
  const text = textOf(html);
  assert.match(html, /<h1>Fix login redirect loop<\/h1>/);
  assert.match(html, /<title>Fix login redirect loop · Claude Code session<\/title>/);
  assert.ok(text.includes("Claude Code session 11111111 · 2026-10-01 12:00 → 2026-10-02 "));
  assert.match(html, /<span class="pill">project <b>webapp<\/b><\/span>/);
  assert.match(html, /<span class="pill">branch <b>fix\/login<\/b><\/span>/);
  assert.match(html, /<span class="pill">model <b>claude-opus-5-5<\/b><\/span>/);
  assert.match(html, /<span class="pill">prompts <b>5<\/b><\/span>/);
  assert.match(html, /<span class="pill">tool calls <b>15<\/b><\/span>/);
  assert.match(html, /<span class="pill" title="input [\d,]+ · cache read [\d,]+ · cache write [\d,]+ · output [\d,]+">tokens <b>\d+K<\/b><\/span>/);
});

test("the conversation is turns labelled You and Claude, each with a time", () => {
  const you = parsed.tags.filter((t) => t.attrs.class === "turn you").length;
  const claude = parsed.tags.filter((t) => (t.attrs.class || "").startsWith("turn claude")).length;
  assert.equal(you, 5);
  assert.ok(claude >= 4);
  assert.equal(countOf(html, '<span class="name">You</span>'), 5);
  assert.match(html, /<time datetime="2026-10-01T12:00:40\.000Z" title="2026-10-01 12:00:40 UTC">2026-10-01 12:00:40<\/time>/);
  assert.match(html, /<span class="tok" title="input \d+ · cache write [\d,]+ · cache read [\d,]+ · output \d+">in [\d.]+K? · cached [\d.]+K · out \d+<\/span>/);
});

test("times show the date again when the day changes", () => {
  assert.match(html, /<time datetime="2026-10-02T[\d:.]+Z" title="[^"]+">2026-10-02 \d\d:\d\d:\d\d<\/time>/);
  assert.match(html, /<time datetime="2026-10-01T12:01:40\.000Z" title="[^"]+">12:01:40<\/time>/, "the same day shows only the clock");
});

test("a sticky filter box and the switches are in the page, and need the script to show", () => {
  assert.match(html, /<input id="q" type="search"/);
  assert.match(CSS, /\.bar\{display:none;position:sticky;top:0/);
  assert.match(CSS, /\.js \.bar\{display:flex\}/);
  for (const act of ["tools", "thinking", "expand", "theme"]) assert.ok(html.includes(`data-act="${act}"`), act);
});

test("light and dark: follows the system by default, or is forced", () => {
  assert.ok(!/<html[^>]* data-theme/.test(html));
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(CSS, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)/);
  const dark = replayFile(rich.file, { ...base, theme: "dark" }).text;
  assert.match(dark, /<html lang="en" data-theme="dark">/);
  assert.match(dark, /<meta name="color-scheme" content="dark">/);
  assert.match(replayFile(rich.file, { ...base, theme: "light" }).text, /<html lang="en" data-theme="light">/);
  assert.match(replayFile(rich.file, { ...base, theme: "<script>" }).text, /<html lang="en">/, "an unknown theme is ignored, never printed");
});

test("print styles: no toolbar, wrapping code, light colours, page breaks kept tidy", () => {
  const print = CSS.slice(CSS.indexOf("@media print"));
  for (const part of [".bar", "white-space:pre-wrap", "max-height:none", "break-inside:avoid", "color-scheme:light", "a[href^=\"http\"]::after"]) assert.ok(print.includes(part), part);
});

test("the footer says it is a single file and shows the version, with no date so exports repeat exactly", () => {
  assert.match(html, /<footer>Exported with claude-replay 1\.0\.1 \(github\.com\/nrzz\/claude-session-replay\)\. A single file/);
  assert.equal(replayFile(rich.file, base).text, html, "the same session exports to the same bytes");
});

// --- what the conversation shows ------------------------------------------------------------------

test("tool calls are collapsible, with a one-line summary: name, what, and a hint", () => {
  const tools = parsed.tags.filter((t) => t.name === "details" && /^tool /.test(t.attrs.class || ""));
  assert.equal(tools.length, 15 + 1, "fifteen calls and one inside the subagent's steps");
  assert.ok(tools.every((t) => !("open" in t.attrs)), "all collapsed");
  assert.match(html, /<summary><span class="tn">Read<\/span><code class="td">src\/auth\.ts<\/code><span class="ts">2 lines<\/span><\/summary>/);
  assert.match(html, /<span class="tn">Grep<\/span><code class="td">redirect<span class="dim"> in <\/span>src<\/code>/);
  assert.match(html, /<span class="tn">MCP<\/span><code class="td">github › create_issue /);
  assert.match(html, /<span class="tn">Subagent<\/span><code class="td">Review the change<\/code>/);
});

test("an edit is a red and green line diff", () => {
  assert.match(html, /<pre class="diff"><span class="dl del">- redirect\(callbackUrl\) <\/span><span class="dl add">\+ redirect\(safe\(callbackUrl\)\) <\/span><\/pre>/);
  assert.match(html, /<span class="tn">Edit<\/span><code class="td">src\/auth\.ts<\/code><span class="ts">\+1 −1<\/span>/);
  assert.match(html, /edit 1 of 2<\/div><pre class="diff"><span class="dl del">- # App<\/span><span class="dl add">\+ # App \(fixed\)<\/span>/);
});

test("a written file shows its first 200 lines and says how many more there are", () => {
  assert.ok(html.includes("case 199"));
  assert.ok(!html.includes("case 200"));
  assert.match(html, /<div class="more">… 50 more lines<\/div>/);
  assert.match(html, /<span class="tn">Write<\/span><code class="td">test\/auth\.test\.ts<\/code><span class="ts">250 lines<\/span>/);
});

test("a command's output is collapsed; a failure is marked and its error is open", () => {
  assert.match(html, /<pre class="cmd">npm test<\/pre><details class="out err" open><summary>Error · 3 lines<\/summary>/);
  assert.match(html, /<details class="tool kind-bash failed"><summary><span class="tn">Bash<\/span><code class="td">npm test<\/code><span class="badge err">failed<\/span>/);
  assert.match(html, /<details class="out"><summary>Output · 2 lines<\/summary>/);
});

test("huge output is cut with a visible note, and keeps both ends", () => {
  assert.match(html, /<div class="trunc">truncated: [\d,]+ characters left out of the middle \(export with --max-output to keep more\)<\/div>/);
  assert.ok(html.includes(`done ${SECRETS.slack}`), "the end is kept");
  const lines = countOf(html, "build line\n");
  assert.ok(lines > 1000 && lines < 2500, `kept ${lines} of 6000 lines`);
  const big = replayFile(rich.file, { ...base, maxOutput: 0 }).text;
  assert.ok(!big.includes("class=\"trunc\""));
  assert.ok(big.length > html.length + 40000);
});

test("thinking is in the page but hidden until its switch is used", () => {
  assert.match(html, /<div class="thinking">the token ghp_b+ is in the env <\/div>/);
  assert.match(CSS, /\.thinking\{display:none/);
  assert.match(CSS, /\.show-thinking \.thinking\{display:block\}/);
  assert.ok(html.includes('data-act="thinking"'));
});

test("thinking can be left out entirely", () => {
  const out = replayFile(rich.file, { ...base, thinking: false });
  assert.ok(!out.text.includes('class="thinking"'));
  assert.ok(!out.text.includes("is in the env"));
  assert.ok(!out.text.includes('data-act="thinking"'));
});

test("a pasted image is shown inline from its own data", () => {
  assert.match(html, /<img class="shot" alt="Image from the session" src="data:image\/png;base64,[A-Za-z0-9+/]+=*">/);
  assert.ok(html.includes(PNG_1PX));
});

test("images can be left out", () => {
  const out = replayFile(rich.file, { ...base, images: false }).text;
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("image omitted"));
});

test("--no-tools shows the conversation without any tool call", () => {
  const out = replayFile(rich.file, { ...base, tools: false }).text;
  assert.ok(!out.includes("<details class=\"tool"));
  assert.ok(!out.includes("npm test"));
  assert.ok(!out.includes('data-act="tools"'));
  assert.match(out, /tool calls <b>15 \(not shown\)<\/b>/);
  assert.ok(out.includes("The route regex is"), "Claude's words are still there");
  assert.deepEqual(parseHtml(out).errors, []);
});

test("compaction shows a divider and the summary it carried", () => {
  assert.match(html, /<div class="turn note compact" id="t\d+"><span>Conversation compacted \(auto, 167K tokens before\)<\/span>/);
  assert.match(html, /<details class="sum"><summary>Summary carried over the compaction<\/summary><div class="md"><p>This session is being continued/);
});

test("slash commands show as chips, shell commands with a ! chip, and their output as collapsed blocks", () => {
  assert.match(html, /<div class="cmd"><span class="chip">\/review<\/span> <span class="args">src<\/span><\/div><details class="out"><summary>Command output · 1 line<\/summary><pre>Review done: 2 comments<\/pre><\/details>/);
  assert.match(html, /<div class="cmd"><span class="chip">!<\/span><code>git status --short<\/code><\/div><details class="out"><summary>Output · 1 line<\/summary><pre> M src\/auth\.ts<\/pre><\/details><details class="out" open><summary>Error output · 1 line<\/summary><pre>warning: nothing<\/pre>/);
});

test("the todo list shows each item's state, and the plan and other tools have a readable body", () => {
  assert.match(html, /<ul class="todos"><li class="done">\u2611 write tests<\/li><li>\u25D0 update docs<\/li><li>\u2610 release<\/li><\/ul>/);
  assert.match(html, /<dl class="kv"><dt>title<\/dt><dd>Follow up<\/dd><dt>repo<\/dt><dd>acme\/webapp<\/dd><\/dl>/);
});

test("a subagent's steps are nested under the call that started it", () => {
  assert.match(html, /<details class="subsession"><summary>Subagent steps · 1 tool call<\/summary><div class="subitems"><details class="tool kind-read">/);
  assert.ok(html.includes("Looks fine, one nit about logging."));
});

test("an interruption is a quiet note", () => {
  assert.match(html, /<div class="turn note" id="t\d+"><span>Request interrupted by user<\/span>/);
});

test("Claude's text is rendered: headings, lists, code, tables, quotes, safe links", () => {
  assert.match(html, /<h4>Summary<\/h4>/);
  assert.match(html, /<li>validates the <strong>callback<\/strong> with <code>safe\(\)<\/code><\/li>/);
  assert.match(html, /<span class="k">export<\/span> <span class="k">function<\/span> safe/);
  assert.match(html, /<table><thead><tr><th>file<\/th><th>change<\/th><\/tr><\/thead><tbody><tr><td>src\/auth\.ts<\/td><td>fixed<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>quoted line<\/p><\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs\?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">the docs<\/a>/);
  assert.ok(html.includes('bad <span class="dim">(javascript:alert(1))</span>'));
});

test("--redact replaces secrets in the name and value rows of any tool's input", () => {
  const root = w.project("creds");
  const t = new Transcript({ id: "77777777-2222-4333-8444-555555555555", seed: "creds", cwd: root, branch: "main", start: "2026-10-01T12:00:00.000Z" });
  t.prompt("connect to the database");
  const values = { password: "hunter2hunter2", api_key: "abcd1234efgh5678", token: "tok_abcdef123456", db_password: "s3cr3t-pass", query: "select 1" };
  t.run("mcp__db__query", values, "1 row");
  t.say("done");
  const { file } = t.write(w.claude);
  const plain = replayFile(file, base).text;
  assert.ok(plain.includes("hunter2hunter2"), "without --redact the values are shown as recorded");
  const htmlOut = replayFile(file, { ...base, redact: true }).text;
  const mdOut = replayFile(file, { ...base, redact: true, format: "md" }).text;
  for (const out of [htmlOut, mdOut]) {
    for (const secret of ["hunter2hunter2", "abcd1234efgh5678", "tok_abcdef123456", "s3cr3t-pass"]) assert.equal(out.includes(secret), false, secret);
    assert.ok(out.includes("REDACTED:named-secret"), "the one-line summary is redacted by field name too");
  }
  assert.ok(htmlOut.includes("<dd>select 1</dd>"), "a field that is not a secret is kept");
});

test("control codes and text-direction overrides are removed from the header's names too", () => {
  const evil = "‮evil\u001b[31m";
  const t = new Transcript({ id: "88888888-2222-4333-8444-555555555555", seed: "names", cwd: `${w.project("names")}${evil}`, branch: "main", version: `2.1.286${evil}`, model: `claude-opus-5-5${evil}`, start: "2026-10-01T12:00:00.000Z" });
  t.prompt("hello there");
  t.say("hi");
  t.compact({ trigger: `auto${evil}`, preTokens: 1000 });
  t.say("after");
  const { file } = t.write(w.claude);
  for (const out of [replayFile(file, base).text, replayFile(file, { ...base, format: "md" }).text]) {
    assert.equal(/[‪-‮⁦-⁩\u001b]/.test(out), false, "no override or escape character survives");
    assert.ok(out.includes("claude-opus-5-5evil"), "the model name is kept, cleaned");
  }
});

test("the home folder is shown as ~ even without --redact, and nothing else is changed", () => {
  assert.ok(html.includes("~/notes.txt"));
  assert.ok(!html.includes(w.home), "the home folder path never appears");
  assert.ok(html.includes(rich.root.replace(/&/g, "&amp;")) || html.includes(esc(rich.root)), "the project folder is kept without --redact");
  assert.ok(html.includes(SECRETS.github), "secrets are kept without --redact (the CLI warns about them)");
});

test("a session with nothing to show says so", () => {
  const s = { id: "", title: "Empty", project: "", branch: "", version: "", models: [], started: "", ended: "", counts: { prompts: 0, toolCalls: 0, turns: 0, messages: 0 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turns: [] };
  const out = renderHtml(s);
  assert.match(out, /<p class="empty">This session has no conversation to show\.<\/p>/);
  assert.deepEqual(parseHtml(out).errors, []);
});

test("a tool kind outside the known list is styled as other, never printed into a class", () => {
  const s = { id: "", title: "T", project: "", branch: "", version: "", models: [], started: "", ended: "", counts: { prompts: 1, toolCalls: 1, turns: 2, messages: 1 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: [{ type: "claude", ts: "", model: "", tokens: null, items: [{ type: "tool", id: "x", name: "Odd", kind: '"><script>', label: "Odd", detail: "d", code: false, where: "", input: { json: { text: "{}", omitted: 0 }, pairs: null }, result: null }] }] };
  const out = renderHtml(s);
  assert.match(out, /<details class="tool kind-other">/);
  assert.deepEqual(parseHtml(out).errors, []);
});

// --- hostile transcripts ------------------------------------------------------------------------

for (const redact of [false, true]) {
  for (const payload of PAYLOADS) {
    test(`hostile text cannot become markup (${redact ? "redacted" : "plain"} export): ${payload.slice(0, 32)}`, () => {
      const w2 = world("evil");
      const evil = richSession(w2, { id: "22222222-2222-4333-8444-555555555555", extra: payload, title: `T ${payload}` });
      const control = richSession(w2, { id: "33333333-2222-4333-8444-555555555555", project: "webapp2", extra: "harmless", title: "T harmless" });
      const out = replayFile(evil.file, { home: w2.home, redact }).text;
      const ref = replayFile(control.file, { home: w2.home, redact }).text;
      const p = parseHtml(out);
      assert.deepEqual(p.errors, [], "balanced, no stray <");
      assert.equal(p.scripts.length, 1);
      assert.equal(p.scripts[0], CLIENT_JS);
      assert.equal(countOf(out, "<script"), 1);
      assert.equal(countOf(out, "<details"), countOf(out, "</details>"));
      for (const t of p.tags) {
        assert.ok(!["iframe", "img", "svg", "object", "embed", "form", "link", "base"].includes(t.name) || (t.name === "img" && /^data:image\/png;base64,/.test(t.attrs.src || "")), `<${t.name}> appeared`);
        for (const [k, v] of Object.entries(t.attrs)) {
          assert.ok(!k.startsWith("on"), `${k}=${v}`);
          if (k === "href") assert.match(v, /^https?:\/\//);
          if (k === "src") assert.match(v, /^data:image\/png;base64,/);
        }
      }
      if (esc(payload) !== payload) {
        // (a payload that is one of our own closing tags is checked by the balance of tags above)
        if (payload !== "</details>") assert.ok(!out.includes(payload), `the payload appears unescaped: ${payload}`);
        assert.ok(out.includes(esc(payload)), "but it is shown, as text");
      }
      assert.equal(signature(out), signature(ref), "the markup is the same as for harmless text: the payload changed no structure");
      assert.ok(textOf(out).includes(payload), "decoded, the page shows exactly what was typed");
    });
  }
}

test("hostile text in a title, a file name and a command cannot reach the title element or the script", () => {
  const w2 = world("evil");
  const t = new Transcript({ cwd: w2.project("p"), seed: "t" });
  t.prompt("go");
  t.run("Read", { file_path: `${t.cwd}/</script><script>alert(1)</script>.ts` }, "x");
  t.run("Bash", { command: "echo '</script><script>alert(2)</script>'" }, "</script><script>alert(3)</script>");
  t.customTitle("</title><script>alert(4)</script>");
  const file = t.write(w2.claude).file;
  const out = replayFile(file, { home: w2.home }).text;
  const p = parseHtml(out);
  assert.deepEqual(p.errors, []);
  assert.equal(p.scripts.length, 1);
  assert.equal(p.scripts[0], CLIENT_JS);
  assert.match(out, /<title>&lt;\/title&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt; · Claude Code session<\/title>/);
});

test("control characters, colour codes and bidi overrides from a transcript never reach the page", () => {
  const w2 = world("evil");
  const t = new Transcript({ cwd: w2.project("p"), seed: "c" });
  t.prompt("a\u202Eb\u2066c\u0000d");
  t.run("Bash", { command: "ls" }, "\x1b[31mred\x1b[0m \x1b]0;title\x07done");
  const out = replayFile(t.write(w2.claude).file, { home: w2.home }).text;
  assert.ok(!/[\u202a-\u202e\u2066-\u2069\u0000\u001b\u0007]/.test(out));
  assert.ok(out.includes("abcd") && out.includes("red done"));
});

// --- redacted export ------------------------------------------------------------------------------

test("a redacted export has no secrets, no home folder, no project path, no thinking and no images", () => {
  const out = redacted.text;
  for (const secret of Object.values(SECRETS)) assert.ok(!out.includes(secret), `leaked ${secret}`);
  assert.ok(!out.includes("hunter2secret"));
  assert.ok(!out.includes(w.home) && !out.includes(rich.root) && !out.includes(w.base));
  assert.ok(!out.includes('class="thinking"') && !out.includes("<img") && !out.includes("SIG123"));
  assert.match(out, /<span class="pill">export <b>redacted<\/b><\/span>/);
  assert.ok(out.includes("[REDACTED:github-token]") && out.includes("[REDACTED:anthropic-key]") && out.includes("postgres://app:[REDACTED:url-password]@db.internal"));
  assert.ok(out.includes("src/auth.ts") && out.includes("~/notes.txt") && out.includes("&lt;tool-results&gt;/big-1.txt"));
  assert.deepEqual(parseHtml(out).errors, []);
});

test("a redacted export counts what it did", () => {
  const c = redacted.display.counts;
  assert.ok(c.secrets["github-token"] >= 1 && c.secrets["anthropic-key"] >= 1 && c.secrets["url-password"] >= 1 && c.secrets["slack-token"] >= 1);
  assert.equal(c.thinking, 1);
  assert.equal(c.images, 1);
  assert.ok(c.paths >= 10);
});

test("size: a session with a 70 KB command output and a 250-line file stays under 120 KB with the default cap", () => {
  assert.ok(html.length < 120000, `${html.length} bytes`);
});

test("simple sessions render", () => {
  const w2 = world("simple");
  const s = simpleSession(w2, { prompt: "How do I deploy?", answer: "Run `fly deploy`.", title: "Deploy question" });
  const out = replayFile(s.file, { home: w2.home }).text;
  assert.deepEqual(parseHtml(out).errors, []);
  assert.match(out, /<h1>Deploy question<\/h1>/);
  assert.match(out, /<code>fly deploy<\/code>/);
  assert.ok(!out.includes('data-act="tools"') && !out.includes('data-act="thinking"'), "no switches for what is not there");
});

test("Windows paths: relative in the one-liners, ~ for the home folder, and the project folder name, on any OS", () => {
  const w2 = world("winhtml");
  const cwd = "C:\\Users\\alice\\code\\web-app";
  const t = new Transcript({ cwd, seed: "winhtml", branch: "main" });
  t.prompt(`Look at ${cwd}\\src\\a.ts and C:\\Users\\alice\\notes.txt`);
  t.run("Read", { file_path: `${cwd}\\src\\a.ts` }, `see ${cwd}\\src\\b.ts:12:3`);
  t.run("Edit", { file_path: "c:/users/ALICE/Code/Web-App/src/b.ts", old_string: "a", new_string: "b" }, "ok");
  t.run("Grep", { pattern: "x", path: `${cwd}\\src` }, "r");
  const file = t.write(w2.claude).file;
  const plain = replayFile(file, { home: "C:\\Users\\alice" }).text;
  assert.match(plain, /<span class="pill">project <b>web-app<\/b><\/span>/);
  assert.match(plain, /<span class="tn">Read<\/span><code class="td">src\/a\.ts<\/code>/);
  assert.match(plain, /<span class="tn">Edit<\/span><code class="td">src\/b\.ts<\/code>/, "any letter case and either slash");
  assert.match(plain, /<span class="tn">Grep<\/span><code class="td">x<span class="dim"> in <\/span>src<\/code>/);
  assert.ok(plain.includes("Look at ~/code/web-app/src/a.ts and ~/notes.txt"), "without --redact only the home folder changes");
  assert.ok(plain.includes("see ~/code/web-app/src/b.ts:12:3"));
  const red = replayFile(file, { home: "C:\\Users\\alice", redact: true }).text;
  assert.ok(red.includes("Look at src/a.ts and ~/notes.txt"));
  assert.ok(red.includes("see src/b.ts:12:3"));
  assert.ok(!red.toLowerCase().includes("alice"), "the user name is nowhere in a redacted export");
  assert.deepEqual(parseHtml(red).errors, []);
});
