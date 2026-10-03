import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Transcript, world, richSession, simpleSession, run, uuid } from "./helpers.mjs";
import { findSessions } from "../src/claude.mjs";
import { makeSnippet, markWords, parseWords, searchFile, searchSessions } from "../src/search.mjs";

// A world with sessions that differ in where a word occurs.
function corpus() {
  const w = world("srch");
  const mk = (name, build, { start = "2026-10-01T12:00:00.000Z", project = "app" } = {}) => {
    const t = new Transcript({ cwd: w.project(project), seed: name, start });
    build(t);
    return { name, ...t.write(w.claude) };
  };
  const s = {};
  s.title = mk("title", (t) => { t.prompt("let us look at billing"); t.say("ok"); t.customTitle("Stripe webhook retries"); });
  s.prompt = mk("prompt", (t) => { t.prompt("how do I verify a stripe webhook signature?"); t.say("Use the raw body."); });
  s.answer = mk("answer", (t) => { t.prompt("billing question"); t.say("A stripe webhook needs the raw body. The webhook handler must return 2xx; stripe retries."); });
  s.stripeOnly = mk("stripeOnly", (t) => { t.prompt("stripe dashboard?"); t.say("open the dashboard"); });
  s.webhookOnly = mk("webhookOnly", (t) => { t.prompt("webhook basics"); t.say("a webhook is a callback"); });
  s.tool = mk("tool", (t) => { t.prompt("check the endpoints"); t.run("Bash", { command: "curl https://api.stripe.com/v1/webhook_endpoints" }, "ok"); });
  s.path = mk("path", (t) => { t.prompt("read it"); t.run("Read", { file_path: `${t.cwd}/src/payments/stripe-webhook.ts` }, "export {}"); });
  s.output = mk("output", (t) => { t.prompt("run it"); t.run("Bash", { command: "node run.js" }, "Error: ENOTFOUND stripe-cli webhook-listener"); });
  s.edit = mk("edit", (t) => { t.prompt("add a handler"); t.run("Edit", { file_path: `${t.cwd}/src/h.ts`, old_string: "x", new_string: "function handleBilling() { return stripeWebhook(); }" }, "ok"); });
  s.thinking = mk("thinking", (t) => { t.prompt("hello"); t.think("secretword in my reasoning"); t.say("fine"); });
  s.other = mk("other", (t) => { t.prompt("stripe webhook in another project"); t.say("yes"); }, { project: "elsewhere" });
  return { w, s, ids: (hits) => hits.map((h) => h.entry.id), entries: () => findSessions({ env: w.env, root: w.project("app") }) };
}

test("parseWords: lowercase, split on spaces, unique, at most 12", () => {
  assert.deepEqual(parseWords(["Stripe  Webhook", "stripe", "ÉCOLE"]), ["stripe", "webhook", "école"]);
  assert.deepEqual(parseWords([]), []);
  assert.equal(parseWords(Array.from({ length: 20 }, (_, i) => `w${i}`)).length, 12);
});

test("every word must match, anywhere in the session; the order of the words does not matter", () => {
  const c = corpus();
  const hits = searchSessions(c.entries(), parseWords(["stripe", "webhook"]));
  const got = new Set(c.ids(hits));
  for (const name of ["title", "prompt", "answer", "tool", "path"]) assert.ok(got.has(c.s[name].id), `${name} should match`);
  for (const name of ["stripeOnly", "webhookOnly", "other"]) assert.ok(!got.has(c.s[name].id), `${name} should not match`);
  assert.deepEqual(c.ids(searchSessions(c.entries(), parseWords(["webhook", "stripe"]))), c.ids(hits));
});

test("words are matched case-insensitively and as parts of words", () => {
  const c = corpus();
  assert.ok(c.ids(searchSessions(c.entries(), ["STRIPE".toLowerCase()])).includes(c.s.stripeOnly.id));
  assert.ok(c.ids(searchSessions(c.entries(), parseWords("WEBHOOK_END"))).includes(c.s.tool.id), "a part of a longer word");
});

test("a title hit ranks above a prompt hit, above Claude's text, above a tool call", () => {
  const c = corpus();
  const order = c.ids(searchSessions(c.entries(), parseWords("stripe webhook")));
  const at = (name) => order.indexOf(c.s[name].id);
  assert.ok(at("title") < at("prompt"), "title before prompt");
  assert.ok(at("prompt") < at("answer"), "prompt before Claude's text");
  assert.ok(at("answer") < at("tool"), "Claude's text before a tool call");
  assert.equal(order[0], c.s.title.id);
});

test("a title beats many mentions in Claude's text", () => {
  const w = world("srch");
  const loud = new Transcript({ cwd: w.project("app"), seed: "loud" });
  loud.prompt("question"); for (let i = 0; i < 30; i++) loud.say("the kubernetes cluster and kubernetes pods and kubernetes nodes");
  loud.write(w.claude);
  const titled = new Transcript({ cwd: w.project("app"), seed: "titled" });
  titled.prompt("hello"); titled.say("hi"); titled.customTitle("Kubernetes notes");
  titled.write(w.claude);
  const hits = searchSessions(findSessions({ env: w.env, root: w.project("app") }), ["kubernetes"]);
  assert.equal(hits[0].entry.id, titled.id);
});

test("equal matches are ordered by recency", () => {
  const w = world("srch");
  const ids = [];
  for (const [i, start] of ["2026-08-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z"].entries()) {
    const t = new Transcript({ cwd: w.project("app"), seed: `same${i}`, start });
    t.prompt("the same words about caching"); t.say("the same answer");
    t.write(w.claude);
    ids.push(t.id);
  }
  const hits = searchSessions(findSessions({ env: w.env, root: w.project("app") }), ["caching"]);
  assert.deepEqual(hits.map((h) => h.entry.id), [ids[1], ids[2], ids[0]]);
});

test("words that sit together in one message score higher than words spread over the session", () => {
  const w = world("srch");
  const together = new Transcript({ cwd: w.project("app"), seed: "tog" });
  together.prompt("alpha beta together"); together.say("ok"); together.write(w.claude);
  const apart = new Transcript({ cwd: w.project("app"), seed: "apart" });
  apart.prompt("alpha first"); apart.say("then beta later"); apart.write(w.claude);
  const hits = searchSessions(findSessions({ env: w.env, root: w.project("app") }), ["alpha", "beta"]);
  assert.deepEqual(hits.map((h) => h.entry.id), [together.id, apart.id]);
});

test("tool commands, paths and addresses are searched by default; tool output and file contents only with --deep", () => {
  const c = corpus();
  const find = (words, deep) => new Set(c.ids(searchSessions(c.entries(), parseWords(words), { deep })));
  assert.ok(find("api.stripe.com").has(c.s.tool.id));
  assert.ok(find("payments").has(c.s.path.id));
  assert.ok(!find("enotfound").has(c.s.output.id));
  assert.ok(find("enotfound", true).has(c.s.output.id));
  assert.ok(!find("handlebilling").has(c.s.edit.id));
  assert.ok(find("handlebilling", true).has(c.s.edit.id));
});

test("thinking is never searched", () => {
  const c = corpus();
  assert.deepEqual(searchSessions(c.entries(), ["secretword"], { deep: true }), []);
});

test("a subagent's transcript and sidechain records are not searched", () => {
  const w = world("srch");
  const s = richSession(w, { extra: "zzextra" });
  const sub = path.join(s.dir, s.id, "subagents", `agent-${s.agentId}.jsonl`);
  fs.appendFileSync(sub, JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "only-in-the-subagent" }] } }) + "\n");
  const entries = findSessions({ env: w.env, all: true });
  assert.equal(searchSessions(entries, ["only-in-the-subagent"], { deep: true }).length, 0);
  assert.equal(searchSessions(entries, ["zzextra"]).length, 1);
});

test("words with quotes, backslashes and non-ASCII letters are found", () => {
  const w = world("srch");
  const t = new Transcript({ cwd: w.project("app"), seed: "odd" });
  t.prompt('say "hello" to C:\\Users\\me and drink café 😀');
  t.say("done");
  t.write(w.claude);
  const entries = findSessions({ env: w.env, root: w.project("app") });
  for (const word of ['"hello"', "c:\\users\\me", "café", "😀"]) assert.equal(searchSessions(entries, [word.toLowerCase()]).length, 1, word);
  assert.equal(searchSessions(entries, ["hello\\"]).length, 0);
});

test("a session in another project is only found with --all", async () => {
  const c = corpus();
  assert.ok(!c.ids(searchSessions(c.entries(), parseWords("stripe webhook"))).includes(c.s.other.id));
  const all = await run(["search", "stripe", "webhook", "--all"], c.w, { cwd: c.w.project("app") });
  assert.ok(all.out.includes(c.s.other.id.slice(0, 8)));
  const here = await run(["search", "stripe", "webhook"], c.w, { cwd: c.w.project("app") });
  assert.ok(!here.out.includes(c.s.other.id.slice(0, 8)));
});

test("the snippet shows the match in context, with the kind of text it came from", () => {
  const c = corpus();
  const hit = searchSessions(c.entries(), parseWords("raw body"))[0];
  assert.equal(hit.snippet.kind, "claude");
  assert.match(hit.snippet.text, /raw body/);
  const tool = searchSessions(c.entries(), parseWords("api.stripe.com"))[0];
  assert.equal(tool.snippet.kind, "tool");
  assert.match(tool.snippet.text, /^Bash: curl https:\/\/api\.stripe\.com/);
});

test("the best snippet is the message that holds the most of the words", () => {
  const w = world("srch");
  const t = new Transcript({ cwd: w.project("app"), seed: "best" });
  t.prompt("alpha only here"); t.say("beta only here"); t.say("both alpha and beta are here"); t.write(w.claude);
  const [hit] = searchSessions(findSessions({ env: w.env, root: w.project("app") }), ["alpha", "beta"]);
  assert.match(hit.snippet.text, /both alpha and beta/);
});

test("makeSnippet: a window around the words, cut at word boundaries, with … where it was cut", () => {
  const text = `${"lorem ipsum ".repeat(40)}the needle is here ${"dolor sit ".repeat(40)}`;
  const s = makeSnippet(text, ["needle"]);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.includes("the needle is here"));
  assert.ok(s.length <= 170);
  assert.ok(!/…\S*[a-z]{12}/.test(s.slice(0, 20)), "no half words at the start");
  assert.equal(makeSnippet("short text with word", ["word"]), "short text with word");
  assert.equal(makeSnippet("nothing here", ["zzz"]), "nothing here");
});

test("makeSnippet: when the words are far apart it shows the first", () => {
  const text = `needle one ${"filler ".repeat(100)} haystack two`;
  assert.match(makeSnippet(text, ["needle", "haystack"]), /^needle one/);
});

test("markWords wraps each occurrence, longest word first, regardless of case", () => {
  assert.equal(markWords("Login and login-flow", ["login", "login-flow"], (m) => `[${m}]`), "[Login] and [login-flow]");
  assert.equal(markWords("a.b", ["a.b"], (m) => `<${m}>`), "<a.b>");
  assert.equal(markWords("text", [], (m) => m), "text");
});

test("results come with a score and the session's explicit title", () => {
  const c = corpus();
  const hit = searchFile(c.entries().find((e) => e.id === c.s.title.id), ["stripe"]);
  assert.equal(hit.title, "Stripe webhook retries");
  assert.ok(hit.score > 12);
  assert.equal(searchFile(c.entries()[0], ["no-such-word-anywhere"]), null);
});

test("on a terminal the matches are highlighted, in a pipe they are not", async () => {
  const c = corpus();
  const piped = await run(["search", "raw", "body"], c.w, { cwd: c.w.project("app") });
  assert.ok(!piped.out.includes("\x1b["));
  const tty = await run(["search", "raw", "body"], c.w, { cwd: c.w.project("app"), tty: true, env: { NO_COLOR: "" } });
  assert.ok(tty.out.includes("\x1b[1;33mraw\x1b[0m"));
  assert.ok(tty.out.includes("\x1b[1;33mbody\x1b[0m"));
});

test("the printed result: id, date, title, then one snippet", async () => {
  const c = corpus();
  const r = await run(["search", "stripe", "webhook"], c.w, { cwd: c.w.project("app") });
  assert.equal(r.code, 0);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^5 sessions in this project with all of: stripe webhook$/);
  assert.match(lines[1], new RegExp(`^${c.s.title.id.slice(0, 8)}  2026-10-0[12]  Stripe webhook retries$`));
  assert.match(lines[2], new RegExp(`^${c.s.prompt.id.slice(0, 8)}  2026-10-0[12]  how do I verify a stripe webhook signature\\?$`), "a title-only hit has no second line");
  assert.match(lines[3], /^    you    how do I verify a stripe webhook signature\?$/);
});

test("--limit shows the best few, and no match is exit code 1 with a hint", async () => {
  const c = corpus();
  const few = await run(["search", "stripe", "--limit", "2"], c.w, { cwd: c.w.project("app") });
  assert.match(few.out, /\(best 2\)/);
  assert.equal(few.out.split("\n").filter((l) => /^[0-9a-f]{8}  /.test(l)).length, 2);
  const none = await run(["search", "zzzzzz"], c.w, { cwd: c.w.project("app") });
  assert.equal(none.code, 1);
  assert.match(none.out, /No session in this project has all of: zzzzzz \(--deep also searches tool output\)\./);
  assert.match(none.out, /Use --all to search every project\./);
  const missing = await run(["search"], c.w, { cwd: c.w.project("app") });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Give one or more words/);
});

test("--deep is offered and works from the command line", async () => {
  const c = corpus();
  const plain = await run(["search", "enotfound"], c.w, { cwd: c.w.project("app") });
  assert.equal(plain.code, 1);
  const deep = await run(["search", "enotfound", "--deep"], c.w, { cwd: c.w.project("app") });
  assert.equal(deep.code, 0);
  assert.match(deep.out, /output +Error: ENOTFOUND stripe-cli webhook-listener/);
});

test("a search over 300 synthetic sessions is quick", async () => {
  const w = world("speed");
  const topics = ["billing", "login", "deploy", "cache", "search", "email", "upload", "metrics", "queue", "auth"];
  const root = w.project("big");
  for (let i = 0; i < 300; i++) {
    const t = new Transcript({ id: uuid("speed", i), seed: `s${i}`, cwd: root, start: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 3600_000).toISOString() });
    const topic = topics[i % topics.length];
    t.prompt(`Please help with the ${topic} module number ${i}`);
    for (let k = 0; k < 12; k++) {
      t.run("Bash", { command: `npm run ${topic}:${k}`, description: "run" }, `output line ${"x".repeat(200)}\n`.repeat(8));
      t.say(`Step ${k} of the ${topic} work: ${"the helper now takes options and returns early on empty input; ".repeat(4)}`);
    }
    if (i % 100 === 0) t.say("a very rare marker: zebra-quagga");
    t.write(w.claude);
  }
  const entries = findSessions({ env: w.env, root });
  assert.equal(entries.length, 300);
  const timed = (words, deep = false) => { const t0 = Date.now(); const hits = searchSessions(entries, words, { deep }); return { hits, ms: Date.now() - t0 }; };
  const rare = timed(["zebra-quagga"]);
  assert.equal(rare.hits.length, 3);
  const common = timed(["billing", "module"]);
  assert.equal(common.hits.length, 30);
  const deep = timed(["output", "line"], true);
  assert.equal(deep.hits.length, 300);
  const cli = await run(["search", "zebra-quagga"], w, { cwd: root });
  assert.match(cli.out, /^3 sessions in this project/);
  for (const r of [rare, common, deep]) assert.ok(r.ms < 8000, `a search took ${r.ms} ms`);
  console.log(`# 300 sessions: rare word ${rare.ms} ms, two common words ${common.ms} ms, deep ${deep.ms} ms`);
});

test("a very large session is streamed, not loaded: a word near its end is found", () => {
  const w = world("huge");
  const root = w.project("p");
  const t = new Transcript({ cwd: root, seed: "huge" });
  t.prompt("start");
  const dir = path.join(w.claude, "projects");
  const written = t.write(w.claude);
  const filler = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "y".repeat(1_000_000) }] } }) + "\n";
  const fd = fs.openSync(written.file, "a");
  for (let i = 0; i < 40; i++) fs.writeSync(fd, filler); // 40 MB
  fs.writeSync(fd, JSON.stringify({ type: "assistant", timestamp: "2026-10-02T00:00:00.000Z", message: { content: [{ type: "text", text: "the final answer mentions pomegranate" }] } }) + "\n");
  fs.closeSync(fd);
  assert.ok(fs.statSync(written.file).size > 40_000_000 && dir);
  const t0 = Date.now();
  const hits = searchSessions(findSessions({ env: w.env, root }), ["pomegranate"]);
  assert.equal(hits.length, 1);
  assert.ok(Date.now() - t0 < 10000);
});

test("the list of sessions is not the place a search looks beyond: unreadable files are skipped", () => {
  const w = world("srch");
  simpleSession(w, { prompt: "findable thing" });
  const entries = findSessions({ env: w.env, all: true });
  entries.push({ id: "gone", file: path.join(w.base, "missing.jsonl"), updated: "2026-01-01T00:00:00.000Z" });
  assert.equal(searchSessions(entries, ["findable"]).length, 1);
});
