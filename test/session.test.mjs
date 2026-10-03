import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Transcript, PNG_1PX, SECRETS, world, richSession, simpleSession } from "./helpers.mjs";
import { SessionBuilder, loadSession } from "../src/session.mjs";
import { makeDisplay } from "../src/redact.mjs";
import { scanSession } from "../src/claude.mjs";
import { UserError } from "../src/util.mjs";

const ROOT = "/work/app";
const HOME = "/home/dev";

// Builds a model from an in-memory transcript.
function build(fn, { redact = false, ...opts } = {}) {
  const t = new Transcript({ cwd: ROOT, seed: "mem", start: "2026-10-01T09:00:00.000Z" });
  fn(t);
  const display = makeDisplay({ redact, root: ROOT, home: HOME, slug: "-work-app" });
  const b = new SessionBuilder({ display, root: ROOT, ...opts });
  for (const r of t.records) b.add(r);
  return { session: b.finish({ id: t.id }), display, builder: b, t };
}

test("turns: a prompt, then everything Claude did until the next prompt", () => {
  const { session } = build((t) => {
    t.prompt("A");
    t.say("looking", { stop: null });
    const id = t.tool("Read", { file_path: `${ROOT}/src/a.ts` });
    t.result(id, "file body");
    t.say("done");
    t.prompt("B");
    t.say("ok");
  });
  assert.deepEqual(session.turns.map((t) => t.type), ["you", "claude", "you", "claude"]);
  assert.deepEqual(session.turns[1].items.map((i) => i.type), ["text", "tool", "text"]);
  assert.equal(session.turns[0].text, "A");
  assert.equal(session.counts.prompts, 2);
  assert.equal(session.counts.toolCalls, 1);
});

test("a tool call is paired with its result; one that never got a result stays open", () => {
  const { session } = build((t) => {
    t.prompt("go");
    const a = t.tool("Bash", { command: "echo hi" });
    t.result(a, "hi\n");
    t.tool("Bash", { command: "sleep 100" }); // interrupted: no result
  });
  const [first, second] = session.turns[1].items;
  assert.equal(first.result.text, "hi\n");
  assert.equal(first.result.lines, 1);
  assert.equal(first.result.isError, false);
  assert.equal(second.result, null);
});

test("a failed tool result is marked", () => {
  const { session } = build((t) => { t.prompt("go"); t.run("Bash", { command: "false" }, "Exit code 1", { isError: true }); });
  assert.equal(session.turns[1].items[0].result.isError, true);
});

test("tokens: one assistant message written as several records is counted once, per turn and in total", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.assistant([{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "a" }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }], { usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } });
    t.result("tu1", "x");
    t.say("b", { usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0 } });
  });
  assert.deepEqual(session.turns[1].tokens, { input: 30, output: 10, cacheRead: 2100, cacheWrite: 50 });
  assert.equal(session.tokens.total, 30 + 10 + 2100 + 50);
  assert.equal(session.counts.messages, 2);
});

test("tokens: the highest value of a repeated message wins, so a streamed total is not undercounted", () => {
  const { session } = build((t) => {
    t.prompt("go");
    const [rec] = t.say("x", { usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    t.raw({ ...rec, uuid: "dup-c", message: { ...rec.message, usage: { ...rec.message.usage, output_tokens: 99 } } });
  });
  assert.equal(session.tokens.output, 99);
  assert.equal(session.counts.messages, 1);
});

test("models: each one once, in order, without the placeholder Claude Code uses for its own messages", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.say("a", { model: "claude-opus-5-5" });
    t.say("b", { model: "<synthetic>" });
    t.say("c", { model: "claude-sonnet-5-5" });
    t.say("d", { model: "claude-opus-5-5" });
  });
  assert.deepEqual(session.models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("compaction: a boundary, then the summary it carried, and Claude's next turn starts afresh", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.say("working");
    t.compact({ trigger: "manual", preTokens: 90000, summary: "We were fixing a bug." });
    t.say("continuing");
  });
  assert.deepEqual(session.turns.map((t) => t.type), ["you", "claude", "compact", "summary", "claude"]);
  assert.equal(session.turns[2].trigger, "manual");
  assert.equal(session.turns[2].preTokens, 90000);
  assert.match(session.turns[3].text, /We were fixing a bug\./);
});

test("slash commands, shell commands and their output become prompts with output attached", () => {
  const { session } = build((t) => {
    t.command("review", "src");
    t.caveat();
    t.expansion("Review the code in src carefully.");
    t.commandOutput("2 comments");
    t.bashInput("git status");
    t.bashOutput("clean", "warn");
    t.say("noted");
  });
  const [cmd, bash] = session.turns;
  assert.deepEqual(cmd.command, { name: "/review", args: "src" });
  assert.equal(cmd.output.text, "2 comments");
  assert.equal(bash.bash.command, "git status");
  assert.equal(bash.bash.stdout.text, "clean");
  assert.equal(bash.bash.stderr.text, "warn");
  assert.equal(session.counts.prompts, 2, "the expansion and the caveat are not prompts");
  assert.equal(session.turns.length, 3);
});

test("an interruption is a note, and ends Claude's turn", () => {
  const { session } = build((t) => { t.prompt("go"); t.say("a"); t.interrupt(); t.say("b"); });
  assert.deepEqual(session.turns.map((t) => t.type), ["you", "claude", "note", "claude"]);
  assert.equal(session.turns[2].text, "Request interrupted by user");
});

test("thinking is kept as text, dropped on request, and counted when dropped", () => {
  const make = (t) => { t.prompt("go"); t.think("secret reasoning"); t.say("answer"); };
  const kept = build(make).session;
  assert.deepEqual(kept.turns[1].items.map((i) => i.type), ["thinking", "text"]);
  const dropped = build(make, { thinking: false });
  assert.deepEqual(dropped.session.turns[1].items.map((i) => i.type), ["text"]);
  assert.equal(dropped.display.counts.thinking, 1);
  assert.ok(!JSON.stringify(dropped.session).includes("secret reasoning"));
});

test("a turn holding only thinking that was left out disappears", () => {
  const { session } = build((t) => { t.prompt("go"); t.think("hmm"); t.prompt("next"); t.say("ok"); }, { thinking: false });
  assert.deepEqual(session.turns.map((t) => t.type), ["you", "you", "claude"]);
});

test("signed or redacted thinking with no text is ignored", () => {
  const { session } = build((t) => { t.prompt("go"); t.assistant([{ type: "thinking", thinking: "", signature: "abc" }, { type: "redacted_thinking", data: "ENCRYPTED" }, { type: "text", text: "hi" }]); });
  assert.deepEqual(session.turns[1].items.map((i) => i.type), ["text"]);
  assert.ok(!JSON.stringify(session).includes("ENCRYPTED"));
});

test("images: pasted images are kept as data when they are real image types", () => {
  const { session } = build((t) => { t.image("see", "image/png", PNG_1PX); });
  assert.deepEqual(session.turns[0].images, [{ media: "image/png", data: PNG_1PX }]);
});

test("images: other media types, bad base64 and URL sources are left out, never embedded", () => {
  const { session } = build((t) => {
    t.promptBlocks([
      { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: 'AAAA"onerror="x' } },
      { type: "image", source: { type: "url", url: "https://evil.example/x.png" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "text", text: "files" },
    ]);
  });
  assert.equal(session.turns[0].images.length, 4);
  assert.ok(session.turns[0].images.every((i) => i.omitted));
  assert.ok(!JSON.stringify(session).includes("evil.example"));
});

test("images can be dropped on request and are counted", () => {
  const { session, display } = build((t) => { t.image("see"); }, { images: false });
  assert.deepEqual(session.turns[0].images, [{ omitted: true, media: "image/png" }]);
  assert.equal(display.counts.images, 1);
});

test("images inside a tool result are carried with the result", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.run("Read", { file_path: `${ROOT}/shot.png` }, [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } }, { type: "text", text: "a screenshot" }]);
  });
  const res = session.turns[1].items[0].result;
  assert.equal(res.images.length, 1);
  assert.equal(res.text, "a screenshot");
});

test("tool summaries: paths are relative to the project, home is ~, MCP tools show server and tool", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.run("Read", { file_path: `${ROOT}/src/a.ts` }, "x");
    t.run("Read", { file_path: `${HOME}/notes.md` }, "x");
    t.run("Read", { file_path: "/etc/hosts" }, "x");
    t.run("Edit", { file_path: `${ROOT}/src/b.ts`, old_string: "a", new_string: "b" }, "ok");
    t.run("Grep", { pattern: "foo", path: `${ROOT}/src` }, "x");
    t.run("mcp__github__create_issue", { title: "T" }, "ok");
    t.run("Task", { description: "Look around", prompt: "p" }, "ok");
    t.run("WebSearch", { query: "q" }, "r");
    t.run("Skill", { skill: "commit", args: "-m x" }, "ok");
  });
  const [r1, r2, r3, ed, grep, mcp, task, web, skill] = session.turns[1].items;
  assert.equal(r1.detail, "src/a.ts");
  assert.equal(r2.detail, "~/notes.md");
  assert.equal(r3.detail, "/etc/hosts");
  assert.equal(ed.detail, "src/b.ts");
  assert.equal(grep.detail, "foo");
  assert.equal(grep.where, "src");
  assert.equal(mcp.label, "MCP");
  assert.match(mcp.detail, /^github › create_issue /);
  assert.equal(task.label, "Subagent");
  assert.equal(task.detail, "Look around");
  assert.equal(web.detail, '"q"');
  assert.equal(skill.detail, "commit -m x");
  assert.deepEqual([r1.kind, ed.kind, grep.kind, mcp.kind, task.kind, web.kind], ["read", "edit", "search", "mcp", "agent", "web"]);
});

test("a written file keeps its first 200 lines and says how many more there were", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.run("Write", { file_path: `${ROOT}/big.txt`, content: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") }, "ok");
  });
  const w = session.turns[1].items[0].input;
  assert.equal(w.totalLines, 500);
  assert.equal(w.moreLines, 300);
  assert.equal(w.content.text.split("\n").length, 200);
  assert.ok(w.content.text.endsWith("line 199"));
});

test("a multi-edit keeps its first 50 edits", () => {
  const { session } = build((t) => {
    t.prompt("go");
    t.run("MultiEdit", { file_path: `${ROOT}/a.txt`, edits: Array.from({ length: 70 }, (_, i) => ({ old_string: `o${i}`, new_string: `n${i}` })) }, "ok");
  });
  const m = session.turns[1].items[0].input;
  assert.equal(m.edits.length, 50);
  assert.equal(m.moreEdits, 20);
});

test("tool output is cut to the limit, and the lines of the whole output are still counted", () => {
  const out = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
  const { session } = build((t) => { t.prompt("go"); t.run("Bash", { command: "big" }, out); }, { maxOutput: 2000 });
  const res = session.turns[1].items[0].result;
  assert.ok(res.text.length < 2100);
  assert.ok(res.omitted > 30000);
  assert.equal(res.lines, 5000);
  assert.ok(res.text.startsWith("row 0\n") && res.text.endsWith("row 4999"));
});

test("a limit of 0 keeps all of the output", () => {
  const out = "x".repeat(100000);
  const { session } = build((t) => { t.prompt("go"); t.run("Bash", { command: "big" }, out); }, { maxOutput: 0 });
  assert.equal(session.turns[1].items[0].result.text.length, 100000);
  assert.equal(session.turns[1].items[0].result.omitted, 0);
});

test("redaction happens before the output is cut, so a secret on the cut line leaves no fragment", () => {
  const out = `${"a".repeat(59)} ${SECRETS.github} ${"b".repeat(5000)}`;
  for (const max of [64, 70, 80, 90, 100]) {
    const { session } = build((t) => { t.prompt("go"); t.run("Bash", { command: "x" }, out); }, { redact: true, maxOutput: max });
    const text = session.turns[1].items[0].result.text;
    assert.ok(!/gh[pousr]_/.test(text), `fragment of the token at limit ${max}: ${text.slice(0, 120)}`);
  }
});

test("a subagent's own records are skipped in the main transcript, and read when asked for", () => {
  const records = (t) => { t.prompt("go"); t.say("main"); };
  const { t } = build(records);
  const side = { ...t.records[1], uuid: "side-1", isSidechain: true, message: { ...t.records[1].message, content: [{ type: "text", text: "sidechain text" }] } };
  const make = (sidechain) => {
    const display = makeDisplay({ home: HOME });
    const b = new SessionBuilder({ display, sidechain });
    for (const r of [...t.records, side]) b.add(r);
    return JSON.stringify(b.finish());
  };
  assert.ok(!make(false).includes("sidechain text"));
  assert.ok(make(true).includes("sidechain text"));
});

test("records repeated in the file (a resumed session) are shown once", () => {
  const { t } = build((t) => { t.prompt("only once"); t.say("answer"); });
  const display = makeDisplay({ home: HOME });
  const b = new SessionBuilder({ display });
  for (const r of [...t.records, ...t.records]) b.add(r);
  const s = b.finish();
  assert.equal(s.counts.prompts, 1);
  assert.equal(s.turns.length, 2);
});

test("garbage records do not stop the build", () => {
  const display = makeDisplay({ home: HOME });
  const b = new SessionBuilder({ display });
  for (const r of [null, undefined, 5, "text", [], {}, { type: "user" }, { type: "assistant" }, { type: "user", message: { content: 7 } }, { type: "assistant", message: { content: [null, 3, { type: "tool_use" }] } }]) b.add(r);
  assert.doesNotThrow(() => b.finish());
});

test("titles: custom beats ai beats a summary line beats the first prompt, and secrets in them are redacted", () => {
  const titled = (extra) => build((t) => { t.prompt("the first prompt"); extra(t); }, { redact: true }).session.title;
  assert.equal(titled(() => {}), "the first prompt");
  assert.equal(titled((t) => t.raw({ type: "summary", summary: "A summary", leafUuid: "x" })), "A summary");
  assert.equal(titled((t) => { t.raw({ type: "summary", summary: "A summary" }); t.aiTitle("AI"); }), "AI");
  assert.equal(titled((t) => { t.aiTitle("AI"); t.customTitle("Mine"); }), "Mine");
  assert.equal(titled((t) => t.customTitle(`key ${SECRETS.github}`)), "key [REDACTED:github-token]");
});

test("header facts: project folder name, branch, version, first and last time", () => {
  const { session } = build((t) => { t.prompt("a"); t.say("b"); t.skip(3600_000); t.prompt("c"); t.say("d"); });
  assert.equal(session.project, "app");
  assert.equal(session.branch, "main");
  assert.equal(session.version, "2.1.286");
  assert.equal(session.started, "2026-10-01T09:00:00.000Z");
  assert.equal(session.ended, "2026-10-01T10:01:00.000Z");
});

test("the project folder name works for a Windows working folder on any OS", () => {
  const t = new Transcript({ cwd: "C:\\Users\\alice\\code\\web-app", seed: "w" });
  t.prompt("hi"); t.say("yo");
  const b = new SessionBuilder({ display: makeDisplay({}) });
  for (const r of t.records) b.add(r);
  assert.equal(b.finish().project, "web-app");
});

test("an API error message is flagged so it can be shown as one", () => {
  const { session } = build((t) => { t.prompt("go"); const [rec] = t.say("API Error: overloaded"); rec.isApiErrorMessage = true; });
  assert.equal(session.turns[1].items[0].error, true);
});

test("tools: false leaves tool calls out of the model but still counts them", () => {
  const { session } = build((t) => { t.prompt("go"); t.say("a", { stop: null }); t.run("Bash", { command: "ls" }, "out"); t.say("b"); }, { tools: false });
  assert.deepEqual(session.turns[1].items.map((i) => i.type), ["text", "text"]);
  assert.equal(session.counts.toolCalls, 1);
});

test("a Task result names its subagent, and only a plain id is accepted", () => {
  const { session } = build((t) => {
    t.prompt("go");
    const a = t.tool("Task", { description: "d", prompt: "p" });
    t.result(a, "ok", { toolUseResult: { agentId: "abc123" } });
    const b = t.tool("Task", { description: "d", prompt: "p" });
    t.result(b, "ok", { toolUseResult: { agentId: "../../etc/passwd" } });
  });
  const [a, b] = session.turns[1].items;
  assert.equal(a.agentId, "abc123");
  assert.equal(b.agentId, undefined);
});

// --- loading a file ---------------------------------------------------------------------------

test("loadSession: the same prompt count as the listing, and the session id from the file name", () => {
  const w = world("load");
  const s = richSession(w);
  const { session } = loadSession(s.file, { home: w.home });
  assert.equal(session.id, s.id);
  assert.equal(session.counts.prompts, scanSession(s.file).prompts);
  assert.equal(session.title, "Fix login redirect loop");
  assert.equal(session.project, "webapp");
});

test("loadSession: a subagent's steps are attached to the Task call that started it", () => {
  const w = world("load");
  const s = richSession(w);
  const { session } = loadSession(s.file, { home: w.home });
  const task = session.turns.flatMap((t) => t.items || []).find((i) => i.name === "Task");
  assert.equal(task.agentId, s.agentId);
  assert.deepEqual(task.sub.items.map((i) => i.type), ["tool", "text"]);
  assert.equal(task.sub.toolCalls, 1);
  assert.equal(loadSession(s.file, { home: w.home, subagents: false }).session.turns.flatMap((t) => t.items || []).find((i) => i.name === "Task").sub, undefined);
});

test("loadSession: a missing subagent file is not an error", () => {
  const w = world("load");
  const s = richSession(w);
  fs.rmSync(path.join(s.dir, s.id), { recursive: true, force: true });
  const { session } = loadSession(s.file, { home: w.home });
  assert.equal(session.turns.flatMap((t) => t.items || []).find((i) => i.name === "Task").sub, undefined);
});

test("loadSession --redact: thinking and images are dropped and counted, whatever else was asked", () => {
  const w = world("load");
  const s = richSession(w);
  const { session, display } = loadSession(s.file, { home: w.home, redact: true, thinking: true, images: true });
  assert.ok(!JSON.stringify(session).includes("SIG123"));
  assert.ok(session.turns.every((t) => t.type !== "you" || !(t.images || []).some((i) => i.data)));
  assert.ok(display.counts.thinking >= 1);
  assert.ok(display.counts.images >= 1);
});

test("loadSession: a file that cannot be read is a plain error", () => {
  const w = world("load");
  assert.throws(() => loadSession(path.join(w.base, "nope.jsonl"), { home: w.home }), UserError);
});

test("loadSession: a simple session has two turns", () => {
  const w = world("load");
  const s = simpleSession(w, { prompt: "hello", answer: "world" });
  const { session } = loadSession(s.file, { home: w.home });
  assert.deepEqual(session.turns.map((t) => [t.type, t.text ?? t.items[0].text]), [["you", "hello"], ["claude", "world"]]);
});

// --- robustness against format variations ---------------------------------------------------------

test("a slash command's output recorded as a system record is attached like a user record's", () => {
  const { session } = build((t) => {
    t.command("cost");
    t.chain({ type: "system", subtype: "local_command", content: "<local-command-stdout>Total cost: $0.42</local-command-stdout>", level: "info" });
    t.chain({ type: "system", subtype: "informational", content: "something else" });
    t.chain({ type: "system", subtype: "local_command", content: "<local-command-stdout>orphan output</local-command-stdout>" });
  });
  assert.equal(session.turns[0].output.text, "Total cost: $0.42");
  assert.equal(session.turns[1].type, "note");
  assert.equal(session.turns[1].output.text, "orphan output");
  assert.equal(session.turns.length, 2, "other system records are not shown");
});

test("a subagent is found by the prompt it started with when the result does not name it", () => {
  const w = world("load");
  const root = w.project("sub");
  const t = new Transcript({ cwd: root, seed: "subfallback" });
  t.prompt("go");
  const named = t.tool("Task", { description: "named", prompt: "Look at the named thing" });
  t.subagent("named1", "Look at the named thing", (s) => { s.say("steps of the named one"); });
  t.result(named, "done", { toolUseResult: { agentId: "named1" } });
  const unnamed = t.tool("Task", { description: "unnamed", prompt: "  Look at the unnamed thing  " });
  t.subagent("zzz999", "Look at the unnamed thing", (s) => { s.say("steps of the unnamed one"); });
  t.result(unnamed, "done");
  const missing = t.tool("Agent", { description: "wrong id", prompt: "Look at the third thing" });
  t.subagent("third3", "Look at the third thing", (s) => { s.say("steps of the third one"); });
  t.result(missing, "done", { toolUseResult: { agentId: "doesnotexist" } });
  const none = t.tool("Task", { description: "none", prompt: "A prompt nobody ran" });
  t.result(none, "done");
  const { session } = loadSession(t.write(w.claude).file, { home: w.home });
  const [a, b, c, d] = session.turns[1].items;
  assert.equal(a.sub.items[0].text, "steps of the named one");
  assert.equal(b.sub.items[0].text, "steps of the unnamed one");
  assert.equal(c.sub.items[0].text, "steps of the third one");
  assert.equal(d.sub, undefined);
  assert.ok(!JSON.stringify(session).includes("promptKey"));
});

test("the raw prompt used to find a subagent never appears in the model", () => {
  const w = world("load");
  const t = new Transcript({ cwd: w.project("sub"), seed: "rawkey" });
  t.prompt("go");
  const id = t.tool("Task", { description: "d", prompt: `use ${SECRETS.github} to log in` });
  t.result(id, "ok");
  const { session } = loadSession(t.write(w.claude).file, { home: w.home, redact: true });
  assert.ok(!JSON.stringify(session).includes(SECRETS.github));
  assert.ok(!Object.keys(session.turns[1].items[0]).includes("promptKey"));
});

test("an image over 1 MB is left out with its size, unless output limits are off", () => {
  const big = "A".repeat(1_500_000);
  const make = (t) => { t.image("big", "image/png", big); };
  const cut = build(make).session.turns[0].images[0];
  assert.equal(cut.omitted, true);
  assert.equal(cut.bytes, 1_125_000);
  assert.equal(build(make, { maxOutput: 0 }).session.turns[0].images[0].data.length, 1_500_000);
});
