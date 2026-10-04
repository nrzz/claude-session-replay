// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders),
// a rich synthetic session, ways to run the CLI, and a small HTML parser for structure checks.
//
// SAFETY: nothing here reads or writes the real Claude folder. Importing this file points HOME,
// USERPROFILE and CLAUDE_CONFIG_DIR of the test process at an empty temporary folder, so even a
// test that forgets to pass its own environment cannot reach ~/.claude. Every child process gets a
// world's environment, and runCli refuses to run with a config folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Transcript, PNG_1PX, uuid } from "./synthetic.mjs";
import { main } from "../src/cli.mjs";
import { projectSlug } from "../src/claude.mjs";

export { Transcript, PNG_1PX, uuid };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-replay.mjs");

const made = [];
export function tmpDir(prefix = "cr-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/**
 * Runs fn and returns { result, ms }, where ms is the CPU time (user and system) it used. Speed tests use it
 * instead of the wall clock: a busy CI machine running other test files makes the clock jump by seconds, but
 * not the CPU time of the work itself, which is what a slow algorithm drives up.
 */
export function cpuMs(fn) {
  const start = process.cpuUsage();
  const result = fn();
  const used = process.cpuUsage(start);
  return { result, ms: (used.user + used.system) / 1000 };
}

// The guard: an empty home and config folder for this process.
const guard = tmpDir("cr-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
delete process.env.CLAUDE_CODE_SESSION_ID;

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
// The folder Claude Code's data would be read from for this environment.
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

// A throwaway world: base/home/.claude is the config folder, base/work/<name> are project folders.
export function world(name = "w") {
  const base = tmpDir(`cr-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  fs.mkdirSync(claude, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    base, home, claude, env,
    project(n) { const d = path.join(base, "work", n); fs.mkdirSync(d, { recursive: true }); return d; },
  };
}

// Runs the real CLI in a child process.
export function runCli(args, { cwd, env, input } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

// Runs main() in this process and captures what it prints.
export async function run(args, w, { cwd, tty = false, columns = 120, env = {}, platform, tmpdir } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { cwd: cwd || w.base, env: { ...w.env, ...env }, tty, columns, platform, tmpdir, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join(""), all: out.join("") + err.join("") };
}

// Fake secrets, built from pieces so no complete token sits in the source for scanners to flag.
const j = (...parts) => parts.join("");
export const SECRETS = {
  anthropic: j("sk-", "ant-", "api03-", "A1b2C3d4".repeat(6)),
  dbPassword: "hunter2secret",
  github: j("gh", "p_", "c".repeat(36)),
  githubThinking: j("gh", "p_", "b".repeat(36)),
  aws: j("AKIA", "IOSFODNN7", "EXAMPLE"),
  slack: j("xo", "xb-", "123456789012-abcdefghij"),
  stripe: j("sk_", "live_", "a1B2c3D4e5F6g7H8i9"),
};

// Text that must never become markup, tried everywhere text can go.
export const PAYLOADS = [
  "<script>alert(1)</script>",
  "</script><script>alert(2)</script>",
  "</details>",
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(3)>",
  "javascript:alert(1)",
  "<iframe src=javascript:alert(4)></iframe>",
];

// --- a rich session: every kind of record and content the tool has to handle -------------------

// Builds the session, writes it, and returns { ...written, root, authFile, trFile, home }.
// extra: text to put into prompts, answers, tool inputs and outputs, titles and file names.
export function richSession(w, { id, project = "webapp", title = "Fix login redirect loop", start = "2026-10-01T12:00:00.000Z", extra = "" } = {}) {
  const root = w.project(project);
  const t = new Transcript({ id, seed: id || `rich-${project}`, cwd: root, branch: "fix/login", start });
  const authFile = path.join(root, "src", `auth${extra ? ` ${extra}` : ""}.ts`);
  const trFile = path.join(w.claude, "projects", projectSlug(root), t.id, "tool-results", "big-1.txt");
  const notes = path.join(w.home, "notes.txt");

  t.bookkeeping();
  t.prompt(`Fix the login redirect loop in ${authFile}. Staging key ${SECRETS.anthropic} and db postgres://app:${SECRETS.dbPassword}@db.internal:5432/app ${extra}`);
  t.hookContext();
  t.systemReminder("remember to be careful");
  t.assistant([{ type: "thinking", thinking: `the token ${SECRETS.githubThinking} is in the env ${extra}`, signature: "SIG123" }], { stop: null });
  const read = t.tool("Read", { file_path: authFile });
  t.result(read, `export const GITHUB_TOKEN = "${SECRETS.github}";\nredirect(callbackUrl) ${extra}`);
  const edit = t.tool("Edit", { file_path: authFile, old_string: `redirect(callbackUrl) ${extra}`, new_string: `redirect(safe(callbackUrl)) ${extra}` });
  t.result(edit, `The file ${authFile} has been updated. Full build output saved to ${trFile}`);
  t.run("Bash", { command: `grep -rn "a\\|b" ${path.join(root, "src")} ${extra}`, description: `search ${extra}` }, `src/auth.ts:3: a ${extra}\n${notes}\nfull output: ${trFile}`);
  t.image(`Here is the screenshot of the loop ${extra}`);
  t.say(`Fixed: the callback is validated now. The route regex is ^/app\\/[a-z]+$ and my notes are in ${notes}. Next: add a test for /callback. ${extra}`);

  t.skip(26 * 3600 * 1000); // the next day
  t.prompt(`Now add tests, and update the docs ${extra}`);
  t.assistant([{ type: "text", text: "I'll write the tests and check the docs." }], { stop: null });
  const write = t.tool("Write", { file_path: path.join(root, "test", "auth.test.ts"), content: Array.from({ length: 250 }, (_, i) => `test("case ${i}", () => { expect(${i}).toBe(${i}); });`).join("\n") });
  t.result(write, "File created successfully");
  const multi = t.tool("MultiEdit", { file_path: path.join(root, "README.md"), edits: [{ old_string: "# App", new_string: "# App (fixed)" }, { old_string: "login", new_string: "sign in" }] });
  t.result(multi, "Applied 2 edits");
  t.run("Bash", { command: "npm test", description: "Run the tests" }, "FAIL test/auth.test.ts\n  expected 1 received 2\nExit code 1", { isError: true });
  t.run("Bash", { command: "npm run build" }, `${"build line\n".repeat(6000)}done ${SECRETS.slack}`); // a huge output
  t.run("Grep", { pattern: "redirect", path: path.join(root, "src") }, "src/auth.ts:3:redirect(callbackUrl)");
  t.run("Glob", { pattern: "**/*.ts" }, "src/auth.ts\nsrc/app.ts");
  t.run("WebFetch", { url: "https://example.com/docs", prompt: "summarise" }, "Example Domain");
  t.run("WebSearch", { query: "express redirect loop fix" }, "Results: ...");
  t.run("TodoWrite", { todos: [{ content: "write tests", status: "completed", activeForm: "writing tests" }, { content: "update docs", status: "in_progress", activeForm: "updating docs" }, { content: "release", status: "pending", activeForm: "releasing" }] }, "Todos updated");
  t.run("mcp__github__create_issue", { title: "Follow up", repo: "acme/webapp" }, "Created issue #12");
  t.run("Skill", { skill: "commit" }, "Launching skill: commit");
  const agentId = "a1b2c3d4";
  const task = t.tool("Task", { description: "Review the change", prompt: `Review the diff for security problems ${extra}`, subagent_type: "general-purpose" });
  t.subagent(agentId, `Review the diff for security problems ${extra}`, (s) => {
    s.run("Read", { file_path: authFile }, "export function login() {}");
    s.say("Looks fine, one nit about logging.");
  });
  t.result(task, "No security problems found.", { toolUseResult: { status: "completed", agentId, totalToolUseCount: 1 } });
  t.interrupt();
  t.compact({ trigger: "auto", preTokens: 167000, summary: `The user fixed a login loop and added tests ${extra}` });
  t.command("review", "src");
  t.caveat();
  t.expansion("Review the code in src carefully.");
  t.commandOutput("Review done: 2 comments");
  t.bashInput("git status --short");
  t.bashOutput(" M src/auth.ts", "warning: nothing");
  t.say(`## Summary\n\nDone. The fix:\n\n- validates the **callback** with \`safe()\`\n- adds *tests*\n  - nested item\n- see [the docs](https://example.com/docs?a=1&b=2) and [bad](javascript:alert(1))\n\n1. first\n2. second\n\n\`\`\`ts\nconst x: number = 1; // note\nexport function safe(u: string) { return u.startsWith("/") ? u : "/"; }\n\`\`\`\n\n| file | change |\n| --- | --- |\n| src/auth.ts | fixed |\n\n> quoted line\n\n${extra}`);
  t.customTitle(title);
  t.aiTitle("AI title that loses to the custom one");
  const written = t.write(w.claude);
  return { ...written, root, authFile, trFile, notes, agentId };
}

// A plain session: a prompt and an answer, for listing and searching.
export function simpleSession(w, { id, project = "webapp", title, prompt = "hello there", answer = "hi", start = "2026-10-01T12:00:00.000Z", branch = "main", extraRecords } = {}) {
  const root = w.project(project);
  const t = new Transcript({ id, seed: id || `${project}-${prompt}-${start}`, cwd: root, branch, start });
  t.prompt(prompt);
  t.say(answer);
  if (extraRecords) extraRecords(t);
  if (title) t.customTitle(title);
  return { ...t.write(w.claude), root };
}

// --- a small HTML parser, for structure checks ------------------------------------------------

const VOID = new Set(["meta", "br", "hr", "img", "input", "link", "base", "col", "area", "wbr", "source", "track", "embed", "param"]);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Tokenizes our own output. Anywhere outside <script> and <style>, a "<" must start a real tag
// (transcript text is escaped, so a stray one means something got through). Returns
// { tags: [{ name, attrs, close }], errors, scripts, styles }; errors lists stray "<" characters
// and tags that do not balance.
export function parseHtml(html) {
  const tags = [];
  const errors = [];
  const stack = [];
  const scripts = [];
  const styles = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) { errors.push("unterminated comment"); break; }
      i = end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) { i = html.indexOf(">", lt) + 1; continue; }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) { errors.push(`stray "<" at ${lt}: ${html.slice(lt, lt + 60)}`); i = lt + 1; continue; }
    const name = m[2].toLowerCase();
    i = lt + m[0].length;
    if (m[1]) {
      tags.push({ name, close: true, attrs: {} });
      const top = stack.pop();
      if (top !== name) errors.push(`</${name}> found where <${top}> was open`);
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(ATTR)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    tags.push({ name, close: false, attrs });
    if (name === "script" || name === "style") {
      const end = html.indexOf(`</${name}`, i);
      (name === "script" ? scripts : styles).push(html.slice(i, end < 0 ? html.length : end));
      stack.push(name);
      i = end < 0 ? html.length : end;
      continue;
    }
    if (!VOID.has(name)) stack.push(name);
  }
  if (stack.length) errors.push(`never closed: ${stack.join(", ")}`);
  return { tags, errors, scripts, styles };
}

// The text of an HTML page without its tags, with the common entities decoded.
export function textOf(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export const countOf = (s, sub) => s.split(sub).length - 1;
