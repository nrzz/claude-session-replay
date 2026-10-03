import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CLI, ROOT, Transcript, SECRETS, world, richSession, simpleSession, run, runCli, tmpDir } from "./helpers.mjs";
import { openCommand, resolveSession } from "../src/cli.mjs";
import { main } from "../src/cli.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// One world for the read-only tests: a rich session, a simple one, another project, a sub-project.
const w = world("cli");
const rich = richSession(w, { id: "aaaaaaaa-1111-4222-8333-444444444444" });
const fly = simpleSession(w, { id: "bbbbbbbb-1111-4222-8333-444444444444", project: "flyapp", prompt: "how do I deploy to fly.io", answer: "run fly deploy", title: "Fly deploy question", start: "2026-10-03T12:00:00.000Z" });
const other = simpleSession(w, { id: "cccccccc-1111-4222-8333-444444444444", project: "other", prompt: "an unrelated chat", answer: "ok", start: "2026-10-04T12:00:00.000Z" });
const inner = new Transcript({ id: "dddddddd-1111-4222-8333-444444444444", cwd: path.join(rich.root, "packages", "api"), seed: "inner", start: "2026-10-05T12:00:00.000Z" });
inner.prompt("inner prompt"); inner.say("inner answer"); inner.customTitle("Inner API work");
inner.write(w.claude);
const empty = new Transcript({ id: "eeeeeeee-1111-4222-8333-444444444444", cwd: rich.root, seed: "empty" });
empty.bookkeeping();
empty.write(w.claude);

// --- help, version, errors ----------------------------------------------------------------------

test("help is printed for no arguments, help, --help and -h, and says what every command does", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"], ["list", "--help"], ["export", "-h"]]) {
    const r = await run(argv, w);
    assert.equal(r.code, 0, argv.join(" "));
    for (const part of ["claude-replay list", "claude-replay search", "claude-replay export", "claude-replay open", "--redact", "--max-output", "--deep", "nrzz/claude-session-replay"]) assert.ok(r.out.includes(part), `${argv.join(" ")}: ${part}`);
  }
});

test("--version prints the package version", async () => {
  for (const flag of ["--version", "-v", "version"]) assert.equal((await run([flag], w)).out.trim(), pkg.version);
});

test("an unknown command or option is an error with the usage", async () => {
  const bad = await run(["bogus"], w);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown command "bogus"/);
  assert.match(bad.err, /claude-replay export/);
  const opt = await run(["list", "--bogus"], w);
  assert.equal(opt.code, 1);
  assert.match(opt.err, /Unknown option --bogus/);
  assert.equal((await run(["export", "x", "--limit", "3"], w)).code, 1, "an option of another command is unknown here");
});

// --- list ---------------------------------------------------------------------------------------

test("list shows this project's sessions, newest first, with id, last activity, prompts, size and title", async () => {
  const r = await run(["list"], w, { cwd: rich.root });
  assert.equal(r.code, 0);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^Sessions in .*webapp {2}\(2, newest first\)$/);
  assert.match(lines[1], /^ {2}ID {8}LAST ACTIVITY {5}PROMPTS {6}SIZE {2}TITLE$/);
  assert.match(lines[2], /^ {2}dddddddd {2}2026-10-0\d \d\d:\d\d +1 +\d+ KB {2}Inner API work$/);
  assert.match(lines[3], /^ {2}aaaaaaaa {2}2026-10-0\d \d\d:\d\d +5 +\d+ KB {2}Fix login redirect loop$/);
  assert.ok(!r.out.includes("bbbbbbbb") && !r.out.includes("cccccccc"), "other projects are left out");
  assert.ok(!r.out.includes("eeeeeeee"), "a session with nothing said in it is hidden");
});

test("list --all covers every project and names each one", async () => {
  const r = await run(["list", "--all"], w, { cwd: w.base });
  assert.match(r.out.split("\n")[0], /^Sessions in all projects {2}\(4, newest first\)$/);
  const rows = r.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l));
  assert.deepEqual(rows.map((l) => l.trim().slice(0, 8)), ["dddddddd", "cccccccc", "bbbbbbbb", "aaaaaaaa"]);
  assert.match(rows[1], /other$/);
  assert.match(rows[3], /webapp$/);
});

test("list --project picks another folder, and --limit shortens the list", async () => {
  const r = await run(["list", "--project", path.join(w.base, "work", "other")], w, { cwd: w.base });
  assert.match(r.out, /cccccccc/);
  assert.ok(!r.out.includes("aaaaaaaa"));
  const limited = await run(["list", "--all", "--limit", "2"], w, { cwd: w.base });
  assert.match(limited.out.split("\n")[0], /\(2 of 5, newest first\)/);
  assert.equal(limited.out.split("\n").filter((l) => /^ {2}[0-9a-f]{8} /.test(l)).length, 2);
  const rel = await run(["list", "--project", "work/other"], w, { cwd: w.base });
  assert.match(rel.out, /cccccccc/, "a relative folder is relative to where you are");
});

test("list in a folder with no sessions says so, and how to look further", async () => {
  const r = await run(["list"], w, { cwd: w.project("nothing-here") });
  assert.equal(r.code, 0);
  assert.match(r.out, /No Claude Code sessions found for .*nothing-here/);
  assert.match(r.out, /Use --all to list every project's sessions\./);
});

test("list with no Claude folder at all does not fail", async () => {
  const lonely = world("lonely");
  fs.rmSync(lonely.claude, { recursive: true, force: true });
  const r = await run(["list", "--all"], lonely, { cwd: lonely.base });
  assert.equal(r.code, 0);
  assert.match(r.out, /No Claude Code sessions found/);
});

test("list cuts long titles to the width of the terminal", async () => {
  const w2 = world("cli");
  simpleSession(w2, { prompt: "x".repeat(300), title: "A very long title ".repeat(10) });
  const r = await run(["list"], w2, { cwd: path.join(w2.base, "work", "webapp"), columns: 80 });
  const row = r.out.split("\n").find((l) => /^ {2}[0-9a-f]{8} /.test(l));
  assert.ok(row.length <= 80, `${row.length} wide`);
  assert.ok(row.endsWith("…"));
});

test("list rejects a limit that is not a whole number", async () => {
  for (const bad of ["0", "-1", "two", "1.5"]) {
    const r = await run(["list", "--limit", bad], w, { cwd: rich.root });
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--limit needs a whole number/);
  }
});

// --- finding a session ----------------------------------------------------------------------------

test("a full id and a unique prefix of 6 or more characters find a session in any project", () => {
  const ctx = { cwd: w.base, env: w.env, warn() {}, c: { cyan: (s) => s, dim: (s) => s } };
  assert.equal(resolveSession(rich.id, {}, ctx).id, rich.id);
  assert.equal(resolveSession("cccccc", {}, ctx).id, other.id, "found without --all, from outside its project");
  assert.equal(resolveSession("CCCCCC", {}, ctx).id, other.id);
});

test("an ambiguous id prefix lists the candidates and stops", async () => {
  const w2 = world("cli");
  simpleSession(w2, { id: "abcdef11-0000-4000-8000-000000000001", project: "one", prompt: "first one", title: "First" });
  simpleSession(w2, { id: "abcdef22-0000-4000-8000-000000000002", project: "two", prompt: "second one", title: "Second" });
  const r = await run(["export", "abcdef", "--out", "-"], w2);
  assert.equal(r.code, 1);
  assert.match(r.err, /2 sessions start with abcdef:/);
  assert.match(r.err, /abcdef11 .*First/);
  assert.match(r.err, /abcdef22 .*Second/);
  assert.match(r.err, /ambiguous/);
  assert.equal(r.out, "");
  assert.equal((await run(["export", "abcdef1", "--out", "-"], w2)).code, 0, "a longer prefix is enough");
});

test("words pick the best matching session when it clearly wins", async () => {
  const r = await run(["export", "fly", "deploy", "--out", "-"], w, { cwd: rich.root });
  assert.equal(r.code, 1, "this project has no such session...");
  const all = await run(["export", "fly", "deploy", "--all", "--md", "--out", "-"], w, { cwd: w.base });
  assert.equal(all.code, 0);
  assert.ok(all.out.startsWith("# Fly deploy question"));
});

test("words that match several sessions about equally list them and exit 1", async () => {
  const w2 = world("cli");
  simpleSession(w2, { id: "11110001-0000-4000-8000-000000000001", prompt: "tune the cache layer", title: "Cache tuning" });
  simpleSession(w2, { id: "11110002-0000-4000-8000-000000000002", prompt: "tune the cache layer", title: "Cache tuning", start: "2026-10-02T12:00:00.000Z" });
  const r = await run(["export", "cache", "--out", "-"], w2, { cwd: path.join(w2.base, "work", "webapp") });
  assert.equal(r.code, 1);
  assert.match(r.err, /2 sessions match "cache" about equally well/);
  assert.match(r.err, /11110002 .*Cache tuning/);
  assert.match(r.err, /11110001 .*Cache tuning/);
  assert.match(r.err, /Name one by its id/);
});

test("nothing matches: exit 1 and a hint about --all", async () => {
  const r = await run(["export", "no-such-thing-anywhere"], w, { cwd: rich.root });
  assert.equal(r.code, 1);
  assert.match(r.err, /No session in this project has all of: no-such-thing-anywhere\. Use --all/);
  const hexish = await run(["export", "deadbeef", "--all"], w, { cwd: rich.root });
  assert.equal(hexish.code, 1);
  assert.match(hexish.err, /No session in any project has all of: deadbeef/);
});

test("export and open need to be told which session", async () => {
  for (const cmd of ["export", "open"]) {
    const r = await run([cmd], w, { cwd: rich.root });
    assert.equal(r.code, 1);
    assert.match(r.err, /Which session\?/);
  }
});

// --- export -------------------------------------------------------------------------------------

test("export writes ./claude-session-<id8>.html by default and reports the size", async () => {
  const dir = tmpDir("cr-out-");
  const r = await run(["export", "aaaaaa"], w, { cwd: dir });
  assert.equal(r.code, 0);
  const file = path.join(dir, "claude-session-aaaaaaaa.html");
  assert.ok(fs.existsSync(file));
  assert.equal(r.out, `Wrote ${file} (${Math.round(fs.statSync(file).size / 1024)} KB, 12 turns, 15 tool calls)\n`);
  assert.ok(fs.readFileSync(file, "utf8").startsWith("<!doctype html>"));
});

test("export --md writes a Markdown file, and --out decides the name and the folder", async () => {
  const dir = tmpDir("cr-out-");
  const md = await run(["export", "aaaaaa", "--md"], w, { cwd: dir });
  assert.ok(fs.existsSync(path.join(dir, "claude-session-aaaaaaaa.md")));
  assert.equal(md.code, 0);
  const nested = await run(["export", "aaaaaa", "--out", path.join("docs", "nested folder", "replay.html")], w, { cwd: dir });
  assert.equal(nested.code, 0);
  assert.ok(fs.existsSync(path.join(dir, "docs", "nested folder", "replay.html")));
  const inferred = await run(["export", "aaaaaa", "--out", "notes.md"], w, { cwd: dir });
  assert.ok(fs.readFileSync(path.join(dir, "notes.md"), "utf8").startsWith("# Fix login redirect loop"), "an .md name means Markdown");
  const forced = await run(["export", "aaaaaa", "--html", "--out", "page.md"], w, { cwd: dir });
  assert.ok(fs.readFileSync(path.join(dir, "page.md"), "utf8").startsWith("<!doctype html>"), "--html wins over the extension");
  assert.equal(inferred.code + forced.code, 0);
});

test("--html and --md together are an error", async () => {
  const r = await run(["export", "aaaaaa", "--html", "--md"], w, { cwd: tmpDir("cr-out-") });
  assert.equal(r.code, 1);
  assert.match(r.err, /Choose --html or --md, not both/);
});

test("--out - prints the export and keeps the report off standard output", async () => {
  const r = await run(["export", "aaaaaa", "--md", "--out", "-"], w, { cwd: tmpDir("cr-out-") });
  assert.equal(r.code, 0);
  assert.ok(r.out.startsWith("# Fix login redirect loop"));
  assert.match(r.err, /claude-replay: wrote Markdown to standard output \(\d+ KB, 12 turns, 15 tool calls\)/);
  assert.ok(!r.out.includes("Wrote "));
});

test("--theme and --max-output are checked and applied", async () => {
  const dir = tmpDir("cr-out-");
  assert.match((await run(["export", "aaaaaa", "--theme", "purple"], w, { cwd: dir })).err, /--theme must be one of auto, light, dark/);
  assert.match((await run(["export", "aaaaaa", "--max-output", "lots"], w, { cwd: dir })).err, /--max-output needs a size/);
  await run(["export", "aaaaaa", "--theme", "dark", "--out", "d.html"], w, { cwd: dir });
  assert.match(fs.readFileSync(path.join(dir, "d.html"), "utf8"), /<html lang="en" data-theme="dark">/);
  await run(["export", "aaaaaa", "--max-output", "1", "--out", "small.html"], w, { cwd: dir });
  await run(["export", "aaaaaa", "--max-output", "0", "--out", "all.html"], w, { cwd: dir });
  assert.ok(fs.statSync(path.join(dir, "small.html")).size < fs.statSync(path.join(dir, "all.html")).size - 50000);
});

test("--no-tools, --no-thinking and --no-images leave those out", async () => {
  const dir = tmpDir("cr-out-");
  await run(["export", "aaaaaa", "--no-tools", "--no-thinking", "--no-images", "--out", "x.html"], w, { cwd: dir });
  const html = fs.readFileSync(path.join(dir, "x.html"), "utf8");
  assert.ok(!html.includes("<details class=\"tool") && !html.includes('class="thinking"') && !html.includes("<img"));
});

test("--redact reports what it did on standard error and writes a clean file", async () => {
  const dir = tmpDir("cr-out-");
  const r = await run(["export", "aaaaaa", "--redact", "--out", "r.html"], w, { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.err, /^claude-replay: redaction: replaced \d+ secrets \(.*github-token.*\); dropped 1 thinking block and 1 image; rewrote \d+ paths\n$/);
  const html = fs.readFileSync(path.join(dir, "r.html"), "utf8");
  for (const secret of Object.values(SECRETS)) assert.ok(!html.includes(secret));
});

test("without --redact a likely secret is a warning, and a clean session says nothing", async () => {
  const dir = tmpDir("cr-out-");
  const r = await run(["export", "aaaaaa", "--out", "p.html"], w, { cwd: dir });
  assert.match(r.err, /^claude-replay: warning: this export contains \d+ likely secrets \(.*\)\. Export again with --redact before sharing it\.\n$/);
  const clean = await run(["export", "bbbbbb", "--all", "--out", "c.html"], w, { cwd: dir });
  assert.equal(clean.err, "");
});

test("the command the plugin's skill runs writes one line and one file", async () => {
  const projectDir = tmpDir("cr-proj-");
  const out = path.join(projectDir, "claude-session-replay.html");
  const r = await run(["export", rich.id, "--redact", "--out", out], w, { cwd: projectDir });
  assert.equal(r.code, 0);
  assert.equal(r.out.split("\n").filter(Boolean).length, 1);
  assert.match(r.out, /^Wrote .*claude-session-replay\.html \(\d+ KB, 12 turns, 15 tool calls\)\n$/);
  assert.ok(fs.existsSync(out));
});

test("--out with a folder (existing, or ending in a slash) puts the default file name in it", async () => {
  const dir = tmpDir("cr-out-");
  fs.mkdirSync(path.join(dir, "exists"));
  const a = await run(["export", "aaaaaa", "--out", "exists"], w, { cwd: dir });
  assert.equal(a.code, 0, a.err);
  assert.ok(fs.existsSync(path.join(dir, "exists", "claude-session-aaaaaaaa.html")));
  const b = await run(["export", "aaaaaa", "--md", "--out", `new-folder${path.sep}`], w, { cwd: dir });
  assert.equal(b.code, 0, b.err);
  assert.ok(fs.existsSync(path.join(dir, "new-folder", "claude-session-aaaaaaaa.md")));
  const c = await run(["export", "aaaaaa", "--out", "docs/nested/"], w, { cwd: dir });
  assert.ok(fs.existsSync(path.join(dir, "docs", "nested", "claude-session-aaaaaaaa.html")), c.err);
});

test("export never overwrites the session it reads", async () => {
  const before = fs.readFileSync(rich.file, "utf8");
  const r = await run(["export", "aaaaaa", "--out", rich.file], w, { cwd: w.base });
  assert.equal(r.code, 1);
  assert.match(r.err, /--out is the session's own transcript/);
  assert.equal(fs.readFileSync(rich.file, "utf8"), before);
});

test("a file name with spaces and a folder that does not exist yet are fine", async () => {
  const dir = tmpDir("cr-out-");
  const r = await run(["export", "aaaaaa", "--out", path.join(dir, "a b", "my replay.html")], w, { cwd: dir });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(dir, "a b", "my replay.html")));
});

// --- open -----------------------------------------------------------------------------------------

test("openCommand builds the right command for each platform", () => {
  const file = "C:\\Users\\me\\AppData\\Local\\Temp\\claude-replay\\claude-session-aaaaaaaa.html";
  assert.deepEqual(openCommand("win32", file), { cmd: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${file}"`], options: { windowsVerbatimArguments: true } });
  assert.deepEqual(openCommand("darwin", "/tmp/a.html"), { cmd: "open", args: ["/tmp/a.html"], options: {} });
  assert.deepEqual(openCommand("linux", "/tmp/a.html"), { cmd: "xdg-open", args: ["/tmp/a.html"], options: {} });
  assert.equal(openCommand("freebsd", "/tmp/a.html").cmd, "xdg-open");
});

// The one file open wrote, in the fresh claude-replay-* folder it made inside `tmp`.
function openedFile(tmp) {
  const dirs = fs.readdirSync(tmp).filter((n) => n.startsWith("claude-replay-"));
  assert.equal(dirs.length, 1, "one new folder in the temp folder");
  const files = fs.readdirSync(path.join(tmp, dirs[0]));
  assert.deepEqual(files, ["claude-session-aaaaaaaa.html"]);
  return path.join(tmp, dirs[0], files[0]);
}

test("open --dry-run exports to a fresh folder in the temp folder and shows the command without running it", async () => {
  for (const [platform, shows] of [["win32", 'cmd.exe /d /s /c start "" "'], ["darwin", "open "], ["linux", "xdg-open "]]) {
    const tmp = tmpDir("cr-tmp-");
    const r = await run(["open", "aaaaaa", "--dry-run"], w, { cwd: w.base, platform, tmpdir: tmp });
    assert.equal(r.code, 0, platform);
    const file = openedFile(tmp);
    assert.ok(fs.existsSync(file), platform);
    assert.ok(r.out.includes(`Would run: ${shows}`), `${platform}: ${r.out}`);
    assert.ok(r.out.includes(file));
    assert.ok(fs.readFileSync(file, "utf8").startsWith("<!doctype html>"));
  }
});

test("open accepts the same options as export, and warns about secrets", async () => {
  const tmp = tmpDir("cr-tmp-");
  const r = await run(["open", "aaaaaa", "--dry-run", "--redact", "--theme", "light"], w, { cwd: w.base, tmpdir: tmp });
  assert.equal(r.code, 0);
  assert.match(r.err, /redaction: replaced/);
  assert.match(fs.readFileSync(openedFile(tmp), "utf8"), /data-theme="light"/);
  const plain = await run(["open", "aaaaaa", "--dry-run"], w, { cwd: w.base, tmpdir: tmpDir("cr-tmp-") });
  assert.match(plain.err, /warning: this export contains/);
});

test("each open gets its own folder, so a name another user planted in a shared temp folder is never written through", async () => {
  const tmp = tmpDir("cr-tmp-");
  fs.mkdirSync(path.join(tmp, "claude-replay"), { recursive: true }); // what an older version, or an attacker, may have left
  await run(["open", "aaaaaa", "--dry-run"], w, { cwd: w.base, tmpdir: tmp });
  await run(["open", "aaaaaa", "--dry-run"], w, { cwd: w.base, tmpdir: tmp });
  const dirs = fs.readdirSync(tmp).filter((n) => n.startsWith("claude-replay-"));
  assert.equal(dirs.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "claude-replay")), [], "the old folder is left alone");
});

// --- the real program -----------------------------------------------------------------------------

test("the installed command runs: version, list, export", () => {
  assert.equal(runCli(["--version"], { env: w.env, cwd: w.base }).out.trim(), pkg.version);
  const list = runCli(["list"], { env: w.env, cwd: rich.root });
  assert.equal(list.code, 0);
  assert.match(list.out, /aaaaaaaa/);
  const dir = tmpDir("cr-out-");
  const exp = runCli(["export", "aaaaaa", "--redact"], { env: w.env, cwd: dir });
  assert.equal(exp.code, 0, exp.err);
  assert.ok(fs.existsSync(path.join(dir, "claude-session-aaaaaaaa.html")));
});

test("with no CLAUDE_CONFIG_DIR the sessions are read from .claude in the home folder", () => {
  const w2 = world("cli");
  simpleSession(w2, { id: "99999999-0000-4000-8000-000000000009", prompt: "from the home folder" });
  const r = runCli(["list", "--all"], { env: { ...w2.env, CLAUDE_CONFIG_DIR: "" }, cwd: w2.base });
  assert.match(r.out, /99999999/);
});

test("an unexpected failure is exit code 2 with the details, a user error is exit code 1 without a stack", async () => {
  const unexpected = [];
  const code = await main(["--version"], { cwd: w.base, env: w.env, out() { throw new Error("boom"); }, err: (s) => unexpected.push(s) });
  assert.equal(code, 2);
  assert.match(unexpected.join(""), /unexpected error: Error: boom/);
  const user = [];
  assert.equal(await main(["export", "zz"], { cwd: w.base, env: w.env, out() {}, err: (s) => user.push(s) }), 1);
  assert.ok(!user.join("").includes("    at "), "no stack trace for a user error");
});

test("closing the pipe early (| head) is not an error", async () => {
  const w2 = world("cli");
  const t = new Transcript({ cwd: w2.project("big"), seed: "epipe" });
  t.prompt("go");
  for (let i = 0; i < 40; i++) t.run("Bash", { command: `echo ${i}` }, "line\n".repeat(20000));
  const { id } = t.write(w2.claude);
  const env = { ...process.env, ...w2.env };
  const child = spawn(process.execPath, [CLI, "export", id.slice(0, 8), "--md", "--max-output", "0", "--out", "-"], { env, cwd: w2.base, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.once("data", () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.ok(!/EPIPE|at \w+ \(/.test(stderr), `a stack trace on a closed pipe: ${stderr.slice(0, 300)}`);
  assert.ok(code === 0 || code === null, `exit code ${code}`);
});

test("the test helpers refuse an environment that points at a real Claude folder", () => {
  const real = path.join(path.parse(os.tmpdir()).root, "Users", "someone");
  assert.throws(() => runCli(["--version"], { env: { CLAUDE_CONFIG_DIR: path.join(real, ".claude"), HOME: real, USERPROFILE: real } }), /temporary/);
});

test("the same session id found in two project folders is one session: the newer file wins", () => {
  const w2 = world("cli");
  const id = "f00dbabe-0000-4000-8000-000000000001";
  const old = simpleSession(w2, { id, project: "before-move", prompt: "old copy", title: "Old copy" });
  const fresh = simpleSession(w2, { id, project: "after-move", prompt: "new copy", title: "New copy" });
  fs.utimesSync(old.file, new Date("2026-01-01"), new Date("2026-01-01"));
  fs.utimesSync(fresh.file, new Date("2026-06-01"), new Date("2026-06-01"));
  const ctx = { cwd: w2.base, env: w2.env, warn() {}, c: { cyan: (s) => s, dim: (s) => s } };
  assert.equal(resolveSession("f00dbabe", {}, ctx).file, fresh.file);
});

test("a very large export says how to make it smaller", async () => {
  const w2 = world("cli");
  const t = new Transcript({ cwd: w2.project("huge"), seed: "large" });
  t.prompt("go");
  for (let i = 0; i < 9; i++) t.run("Bash", { command: `make ${i}` }, `${"x".repeat(79)}\n`.repeat(25000)); // 9 outputs of 2 MB
  const { id } = t.write(w2.claude);
  const big = await run(["export", id.slice(0, 8), "--md", "--max-output", "0", "--out", "-"], w2);
  assert.match(big.err, /claude-replay: note: the file is \d+\.\d MB\. --max-output 4 or --no-tools makes it much smaller\./);
  const capped = await run(["export", id.slice(0, 8), "--md", "--out", "-"], w2);
  assert.ok(!capped.err.includes("note:"), "a normal export says nothing");
});
