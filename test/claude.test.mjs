import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Transcript, world, richSession, simpleSession, tmpDir } from "./helpers.mjs";
import {
  classifyUser, claudeDir, findById, findSessions, homeDir, isInside, lastTimestamp, projectSlug, promptText,
  quickMeta, scanSession, titleRecord,
} from "../src/claude.mjs";

// --- where Claude Code keeps things ----------------------------------------------------------

test("project folder names follow Claude Code's rule", () => {
  assert.equal(projectSlug("C:\\Users\\alice\\code\\web-app"), "C--Users-alice-code-web-app");
  assert.equal(projectSlug("/home/bob/web app"), "-home-bob-web-app");
  const long = `/srv/${"very-long-folder-name/".repeat(12)}`;
  const slug = projectSlug(long);
  assert.match(slug, /^.{200}-[0-9a-z]+$/);
  assert.equal(slug, projectSlug(long));
  assert.notEqual(slug, projectSlug(`${long}x`));
});

test("the config folder is $CLAUDE_CONFIG_DIR, else .claude in the home folder", () => {
  const dir = tmpDir("cr-c-");
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: dir }), path.resolve(dir));
  const home = path.join(dir, "h");
  assert.equal(claudeDir({ HOME: home, USERPROFILE: home }), path.join(home, ".claude"));
  assert.equal(homeDir({ HOME: home, USERPROFILE: home }), home);
});

test("isInside: the folder itself and everything below it, but not a sibling with the same start", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c/d"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
  assert.equal(isInside("/a/b", ""), false);
});

test("isInside treats Windows paths case-insensitively with either slash, on any OS", () => {
  assert.equal(isInside("C:\\Work\\App", "c:/work/app/src/x.ts"), true);
  assert.equal(isInside("C:\\Work\\App", "C:\\Work\\App-old"), false);
  assert.equal(isInside("C:\\Work\\App", "D:\\Work\\App"), false);
  assert.equal(isInside("C:\\Work\\App", "C:\\Work"), false);
});

// --- user records --------------------------------------------------------------------------

const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

test("a typed prompt is text that is not injected context, as a string or as blocks", () => {
  assert.deepEqual(classifyUser(user("fix it")), { kind: "prompt", text: "fix it", images: [] });
  assert.equal(classifyUser(user([{ type: "text", text: "one" }, { type: "text", text: "two" }])).text, "one\n\ntwo");
  assert.equal(promptText(user("fix it")), "fix it");
});

test("tool results, meta records and non-user records are not prompts", () => {
  assert.equal(classifyUser(user([{ type: "tool_result", tool_use_id: "t", content: "x" }])).kind, "tool-results");
  assert.equal(classifyUser(user("expanded skill text", { isMeta: true })).kind, "meta");
  assert.equal(classifyUser({ type: "assistant", message: { content: "x" } }).kind, "none");
  assert.equal(promptText(user([{ type: "tool_result", tool_use_id: "t", content: "x" }])), "");
});

test("a pasted image is part of a prompt, even with no text", () => {
  const withText = classifyUser(user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "look" }]));
  assert.equal(withText.kind, "prompt");
  assert.equal(withText.text, "look");
  assert.equal(withText.images.length, 1);
  assert.equal(classifyUser(user([{ type: "image", source: {} }])).kind, "prompt");
});

test("slash commands, shell commands and their output are recognised", () => {
  const cmd = classifyUser(user("<command-message>commit</command-message>\n<command-name>/commit</command-name>\n<command-args>fix typo</command-args>"));
  assert.deepEqual(cmd, { kind: "command", name: "/commit", args: "fix typo" });
  assert.equal(promptText(user("<command-name>/clear</command-name>\n<command-args></command-args>")), "/clear");
  assert.deepEqual(classifyUser(user("<bash-input>ls -la</bash-input>")), { kind: "bash", command: "ls -la" });
  assert.equal(promptText(user("<bash-input>ls -la</bash-input>")), "! ls -la");
  assert.deepEqual(classifyUser(user("<bash-stdout>a\nb</bash-stdout><bash-stderr>warn</bash-stderr>")), { kind: "bash-output", stdout: "a\nb", stderr: "warn" });
  assert.deepEqual(classifyUser(user("<local-command-stdout>Total cost: $1</local-command-stdout>")), { kind: "command-output", text: "Total cost: $1" });
});

test("a prompt that merely talks about the command tags is still a prompt", () => {
  const text = "Typed prompts are text; <command-name>/x</command-name> marks a slash command";
  assert.equal(classifyUser(user(text)).kind, "prompt");
});

test("injected context is dropped: reminders, IDE wrappers, caveats; interruptions are noted", () => {
  assert.equal(classifyUser(user([{ type: "text", text: "<system-reminder>be careful</system-reminder>" }])).kind, "skip");
  assert.equal(classifyUser(user("<system-reminder>x</system-reminder>real question")).text, "real question");
  const ide = classifyUser(user([{ type: "text", text: "<ide_opened_file>The user opened a.ts</ide_opened_file>" }, { type: "text", text: "what is this file?" }]));
  assert.equal(ide.text, "what is this file?");
  assert.equal(classifyUser(user("<local-command-caveat>Caveat: DO NOT respond</local-command-caveat>")).kind, "skip");
  assert.equal(classifyUser(user("Caveat: The messages below were generated by the user")).kind, "skip");
  assert.equal(classifyUser(user("[Request interrupted by user]")).kind, "interrupt");
  assert.equal(classifyUser(user("<task-notification>done</task-notification>")).kind, "skip");
});

test("a typed prompt that starts with an ordinary HTML tag is kept", () => {
  assert.equal(classifyUser(user("<div class='x'>why is this broken</div>")).kind, "prompt");
});

test("a compaction summary is its own kind", () => {
  const c = classifyUser(user([{ type: "text", text: "This session is being continued..." }], { isCompactSummary: true }));
  assert.deepEqual(c, { kind: "summary", text: "This session is being continued..." });
});

// --- titles ---------------------------------------------------------------------------------

test("titles: custom-title, ai-title, and a short summary line from older versions", () => {
  assert.deepEqual(titleRecord({ type: "custom-title", customTitle: "Mine" }), { custom: "Mine" });
  assert.deepEqual(titleRecord({ type: "ai-title", aiTitle: "Generated" }), { ai: "Generated" });
  assert.deepEqual(titleRecord({ type: "summary", summary: "Fix a bug", leafUuid: "x" }), { summary: "Fix a bug" });
  assert.equal(titleRecord({ type: "summary", summary: "x".repeat(400) }), null, "a long summary is a compaction summary, not a title");
  assert.equal(titleRecord({ type: "user" }), null);
});

// --- reading one session ------------------------------------------------------------------

test("scanSession: custom title beats the ai title; prompts, working folder, branch and times", () => {
  const w = world("scan");
  const s = richSession(w);
  const info = scanSession(s.file);
  assert.equal(info.title, "Fix login redirect loop");
  assert.equal(info.prompts, 5, "typed prompts: two lines, an image prompt, a slash command and a shell command");
  assert.equal(info.hasAssistant, true);
  assert.equal(info.cwd, s.root);
  assert.equal(info.branch, "fix/login");
  assert.match(info.started, /^2026-10-01T12:00/);
  assert.match(info.updated, /^2026-10-02T/);
  assert.match(info.firstPrompt, /^Fix the login redirect loop/);
});

test("scanSession: without a title record the first prompt names the session", () => {
  const w = world("scan");
  const s = simpleSession(w, { prompt: "How do I deploy this app to fly.io? It keeps failing on the release step" });
  assert.equal(scanSession(s.file).title, "How do I deploy this app to fly.io? It keeps failing on the release step".slice(0, 69) + "…");
});

test("scanSession: the last title record wins", () => {
  const w = world("scan");
  const s = simpleSession(w, { prompt: "x", extraRecords: (t) => { t.aiTitle("First"); t.aiTitle("Second"); t.customTitle("Named"); t.customTitle("Renamed"); } });
  assert.equal(scanSession(s.file).title, "Renamed");
});

test("scanSession: a file with only bookkeeping has nothing in it", () => {
  const w = world("scan");
  const root = w.project("empty");
  const t = new Transcript({ cwd: root });
  t.bookkeeping();
  const s = t.write(w.claude);
  const info = scanSession(s.file);
  assert.equal(info.prompts, 0);
  assert.equal(info.hasAssistant, false);
});

test("lastTimestamp and quickMeta read the ends of a file", () => {
  const w = world("scan");
  const s = richSession(w);
  assert.match(lastTimestamp(s.file), /^2026-10-02T\d\d:\d\d:\d\d\.\d{3}Z$/);
  const meta = quickMeta(s.file);
  assert.equal(meta.cwd, s.root);
  assert.equal(meta.branch, "fix/login");
  assert.match(meta.started, /^2026-10-01T12:00/);
});

test("lastTimestamp finds a timestamp even when the last record is far bigger than the tail it reads", () => {
  const dir = tmpDir("cr-c-");
  const file = path.join(dir, "big.jsonl");
  const first = JSON.stringify({ type: "user", timestamp: "2026-10-01T10:00:00.000Z", message: { content: "hi" } });
  const huge = JSON.stringify({ type: "assistant", timestamp: "2026-10-01T11:00:00.000Z", message: { content: "x".repeat(300_000) } });
  fs.writeFileSync(file, `${first}\n${huge}\n`);
  assert.equal(lastTimestamp(file), "2026-10-01T11:00:00.000Z");
});

// --- finding sessions ---------------------------------------------------------------------

test("findSessions: this project and folders inside it, not a sibling whose name starts the same", () => {
  const w = world("find");
  const a = simpleSession(w, { project: "webapp", prompt: "root session", start: "2026-10-01T12:00:00.000Z" });
  const inner = path.join(a.root, "packages", "api");
  fs.mkdirSync(inner, { recursive: true });
  const b = new Transcript({ cwd: inner, start: "2026-10-02T12:00:00.000Z", seed: "inner" });
  b.prompt("inner session"); b.say("ok");
  b.write(w.claude);
  simpleSession(w, { project: "webapp-old", prompt: "sibling" });
  simpleSession(w, { project: "other", prompt: "unrelated" });
  const found = findSessions({ env: w.env, root: a.root });
  assert.deepEqual(found.map((e) => e.id), [b.id, a.id], "newest first, sibling and unrelated project left out");
  assert.equal(findSessions({ env: w.env, all: true }).length, 4);
});

test("findSessions: subagent transcripts are not sessions of their own", () => {
  const w = world("find");
  const s = richSession(w);
  assert.ok(fs.existsSync(path.join(s.dir, s.id, "subagents", `agent-${s.agentId}.jsonl`)));
  assert.equal(findSessions({ env: w.env, all: true }).length, 1);
});

test("findSessions: Windows-style working folders are matched on any OS", () => {
  const w = world("find");
  const cwd = "C:\\Users\\alice\\code\\web-app";
  const t = new Transcript({ cwd, seed: "win" });
  t.prompt("hi"); t.say("hello");
  t.write(w.claude);
  const other = new Transcript({ cwd: "C:\\Users\\alice\\code\\web-app-old", seed: "win2" });
  other.prompt("hi"); other.say("hello");
  other.write(w.claude);
  assert.deepEqual(findSessions({ env: w.env, root: cwd }).map((e) => e.id), [t.id]);
  assert.deepEqual(findSessions({ env: w.env, root: "c:/users/alice/code/web-app" }).map((e) => e.id), [t.id], "case and slashes do not matter");
});

test("findSessions: a session is ordered by its last record, not by the file's modified time", () => {
  const w = world("find");
  const older = simpleSession(w, { prompt: "older", start: "2026-09-01T12:00:00.000Z" });
  const newer = simpleSession(w, { prompt: "newer", start: "2026-10-01T12:00:00.000Z" });
  const future = new Date("2030-01-01T00:00:00Z");
  fs.utimesSync(older.file, future, future); // a restored backup can touch every file
  const ids = findSessions({ env: w.env, all: true }).map((e) => e.id);
  assert.deepEqual(ids, [newer.id, older.id]);
});

test("findById: the whole id or a prefix, in any project, ignoring case", () => {
  const w = world("find");
  const a = simpleSession(w, { project: "one", id: "abcdef12-0000-4000-8000-000000000001" });
  const b = simpleSession(w, { project: "two", id: "abcdef99-0000-4000-8000-000000000002" });
  assert.deepEqual(findById("abcdef12", w.env).map((e) => e.id), [a.id]);
  assert.deepEqual(findById("ABCDEF", w.env).map((e) => e.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(findById(a.id, w.env).map((e) => e.id), [a.id]);
  assert.deepEqual(findById("ffffff", w.env), []);
});
