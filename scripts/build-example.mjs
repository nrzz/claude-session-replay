#!/usr/bin/env node
// Builds docs/example.html: the replay of a made-up session, for the README.
//
//   node scripts/build-example.mjs          write docs/example.html
//   node scripts/build-example.mjs --check  exit 1 when the checked-in file is out of date
//
// Nothing here reads a real Claude folder. The session is written as a transcript into a throwaway
// folder, exported with the same code the claude-replay command uses, and the folder is deleted.
// Fixed ids, times and paths make the output identical on every machine, which the tests rely on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transcript } from "../test/synthetic.mjs";
import { replayFile } from "../src/replay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = path.join(HERE, "..", "docs", "example.html");

const HOME = "/home/dev";
const ROOT = `${HOME}/projects/webapp`;

// A 240x140 picture of a browser showing an error page: a real PNG, 332 bytes.
const SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAMAAAB1a9QaAAAAG1BMVEX////l5+uco6/cJiYfKTf+4uI7gvYixV7qswgBCkUeAAAA7ElEQVR42u3c2wqCQBRA0Ukr+/8vDgeCCObF5qjjWfvJQIQFXma8VG7JKsDAicHTKYsElxO2FTzX1qVXbV1aasDZwP8cb8B2aeAocLrLkoGHoSUw8BDgKVlFkiRJkiRJl24etO3gx5ABAwMDAwMDAwMDAx8Nbs1Ovte57xwwMDAw8C+49fuylyVgYGBgYOBBZkuR7zoDAwPHg9OdtICBgYGHuhG/1xdmwMDAHqYBAwMDG2kFTfKBgYGdtICBgYGBgYGBgYGBu4GzfTAtSZKkqJ6d+myv259iAwMDAwMDAwMDAwMDHwqWJEmS1OwN6kEEiETlY4wAAAAASUVORK5CYII=";

const SESSION_TS = `import type { NextFunction, Request, Response } from "express";
import { sessions } from "./store";

const COOKIE = "sid";

export function readSession(req: Request) {
  const id = req.cookies?.[COOKIE];
  if (!id) return null;
  return sessions.get(id) ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = readSession(req);
  if (!session || session.expiresAt <= Date.now()) return res.redirect("/login");
  next();
}
`;
const LOGIN_TS = `import { Router } from "express";

export const router = Router();

router.get("/login", (req, res) => {
  if (req.cookies.sid) return res.redirect("/");
  res.render("login");
});
`;

// The conversation. Returns the transcript; write() puts it on disk.
export function demoTranscript() {
  const t = new Transcript({ id: "7be317ee-0b1d-4c2a-9a63-5f1d2c9e8a40", seed: "demo", cwd: ROOT, branch: "fix/login-redirect", model: "claude-sonnet-4-5", start: "2026-10-01T09:12:04.000Z", stepMs: 7000 });
  t.usage = (n) => ({ input_tokens: 90 + n * 4, output_tokens: 180 + n * 35, cache_creation_input_tokens: 1400, cache_read_input_tokens: 13000 + n * 3200 });
  const at = (p) => `${ROOT}/${p}`;

  t.bookkeeping();
  t.prompt("Users get stuck in a redirect loop after logging in when their session cookie has expired. Can you find the cause and fix it? Start in src/auth.");

  // Looking around
  t.say("I'll start by finding where the redirect to the login page is decided.", { stop: null });
  t.assistant([{ type: "thinking", thinking: "A loop between two routes usually means each one sends the user to the other. /login probably redirects to / when it sees a cookie, and / is protected by something that redirects back to /login when the session is not valid. I need to look at both ends and at how the cookie is checked.", signature: "demo" }], { stop: null });
  t.run("Grep", { pattern: "redirect\\(", path: at("src") }, "src/routes/login.ts:6:  if (req.cookies.sid) return res.redirect(\"/\");\nsrc/auth/session.ts:14:  if (!session || session.expiresAt <= Date.now()) return res.redirect(\"/login\");\nsrc/routes/logout.ts:5:  res.redirect(\"/login\");");
  t.run("Read", { file_path: at("src/auth/session.ts") }, numbered(SESSION_TS));
  t.run("Read", { file_path: at("src/routes/login.ts") }, numbered(LOGIN_TS));
  t.say("Found it. The two checks disagree about what \"logged in\" means:\n\n- `/login` sends you to `/` whenever a `sid` cookie **exists**.\n- `requireAuth` treats the same cookie as **no session** once `expiresAt` has passed, and sends you back to `/login`.\n\nAn expired cookie is never cleared, so the two routes redirect to each other forever. I'll make `readSession` the single place that decides, and have `/login` clear a stale cookie.");

  // The fix
  t.run("Edit", { file_path: at("src/auth/session.ts"), old_string: "  return sessions.get(id) ?? null;\n}", new_string: "  const session = sessions.get(id);\n  if (!session || session.expiresAt <= Date.now()) return null;\n  return session;\n}" }, "The file src/auth/session.ts has been updated.");
  t.run("Edit", { file_path: at("src/auth/session.ts"), old_string: "  if (!session || session.expiresAt <= Date.now()) return res.redirect(\"/login\");", new_string: "  if (!session) return res.redirect(\"/login\");" }, "The file src/auth/session.ts has been updated.");
  t.run("Edit", { file_path: at("src/routes/login.ts"), old_string: "import { Router } from \"express\";\n\nexport const router = Router();\n\nrouter.get(\"/login\", (req, res) => {\n  if (req.cookies.sid) return res.redirect(\"/\");\n  res.render(\"login\");", new_string: "import { Router } from \"express\";\nimport { readSession } from \"../auth/session\";\n\nexport const router = Router();\n\nrouter.get(\"/login\", (req, res) => {\n  if (readSession(req)) return res.redirect(\"/\");\n  res.clearCookie(\"sid\"); // an expired or unknown cookie must not survive the login page\n  res.render(\"login\");" }, "The file src/routes/login.ts has been updated.");
  t.run("Bash", { command: "npm test -- auth", description: "Run the auth tests" }, TEST_FAIL, { isError: true });
  t.say("One existing test still assumes that any cookie counts as logged in. That is the old behaviour, so the test needs to change, not the code.");
  t.run("Read", { file_path: at("tests/auth/login.test.ts") }, numbered("import request from \"supertest\";\nimport { app } from \"../../src/app\";\n\ndescribe(\"login\", () => {\n  it(\"redirects home when a cookie is present\", async () => {\n    const res = await request(app).get(\"/login\").set(\"Cookie\", \"sid=abc\");\n    expect(res.status).toBe(302);\n    expect(res.headers.location).toBe(\"/\");\n  });\n});\n"));
  t.run("Edit", { file_path: at("tests/auth/login.test.ts"), old_string: "  it(\"redirects home when a cookie is present\", async () => {\n    const res = await request(app).get(\"/login\").set(\"Cookie\", \"sid=abc\");", new_string: "  it(\"redirects home when the session is valid\", async () => {\n    const sid = createSession({ userId: 1, ttlMs: 60_000 });\n    const res = await request(app).get(\"/login\").set(\"Cookie\", `sid=${sid}`);" }, "The file tests/auth/login.test.ts has been updated.");
  t.run("Bash", { command: "npm test", description: "Run the whole suite" }, TEST_PASS);
  t.say("All 19 tests pass. What changed:\n\n| File | Change |\n| --- | --- |\n| `src/auth/session.ts` | `readSession` returns `null` for an expired session; `requireAuth` relies on it |\n| `src/routes/login.ts` | uses `readSession`, and clears a stale cookie before showing the form |\n| `tests/auth/login.test.ts` | the redirect test now logs in with a real session |\n\nThe check is now in one place:\n\n```ts\nexport function readSession(req: Request) {\n  const id = req.cookies?.[COOKIE];\n  if (!id) return null;\n  const session = sessions.get(id);\n  if (!session || session.expiresAt <= Date.now()) return null; // expired counts as none\n  return session;\n}\n```");

  // A screenshot, a regression test, a subagent, a to-do list
  t.skip(12 * 60_000);
  t.image("This is what a user saw before the fix, in case it helps to write the regression test.", "image/png", SCREENSHOT);
  t.say("That is the browser's `ERR_TOO_MANY_REDIRECTS` page, which matches the loop. I'll add a regression test that reproduces it with an expired session, and ask a subagent to review the change while I do.");
  t.run("TodoWrite", { todos: [{ content: "Add a regression test for an expired session", status: "in_progress", activeForm: "Adding a regression test" }, { content: "Review the change for security problems", status: "pending", activeForm: "Reviewing the change" }, { content: "Update the changelog", status: "pending", activeForm: "Updating the changelog" }] }, "Todos have been modified successfully.");
  t.run("Write", { file_path: at("tests/auth/expired-session.test.ts"), content: EXPIRED_TEST }, "File created successfully at: tests/auth/expired-session.test.ts");
  t.run("Bash", { command: "npm test -- expired-session", description: "Run the new test" }, TEST_ONE_PASS);
  const task = t.tool("Task", { description: "Review the change for security problems", prompt: "Review the uncommitted changes in src/auth and src/routes/login.ts for security problems: session fixation, open redirects, cookie flags. Report only real findings, in under 150 words.", subagent_type: "general-purpose" });
  t.subagent("a91f0c2", "Review the uncommitted changes in src/auth and src/routes/login.ts for security problems: session fixation, open redirects, cookie flags. Report only real findings, in under 150 words.", (s) => {
    s.say("I'll read the changed files and check how the cookie is set and cleared.");
    s.run("Read", { file_path: at("src/routes/login.ts") }, numbered(LOGIN_TS.replace('if (req.cookies.sid) return res.redirect("/");', 'if (readSession(req)) return res.redirect("/");')));
    s.run("Grep", { pattern: "cookie\\(|clearCookie\\(", path: at("src") }, "src/routes/login.ts:7:  res.clearCookie(\"sid\");\nsrc/routes/auth.ts:22:  res.cookie(\"sid\", id, { httpOnly: true, sameSite: \"lax\", secure: true });");
    s.say("The cookie is set with httpOnly, sameSite and secure, and `/` is a fixed redirect target, so there is no open redirect.");
  });
  t.result(task, "No security problems found.\n\nTwo notes, neither blocking:\n- `clearCookie(\"sid\")` in login.ts should pass the same `path` and `domain` options the cookie was set with, or some browsers will keep it.\n- The redirect on a valid session is a fixed `/`, so there is no open redirect.", { toolUseResult: { status: "completed", agentId: "a91f0c2", totalToolUseCount: 2 } });
  t.say("The review found nothing blocking, with one note I'll apply: `clearCookie` should repeat the options the cookie was set with.");
  t.run("Edit", { file_path: at("src/routes/login.ts"), old_string: "  res.clearCookie(\"sid\"); // an expired or unknown cookie must not survive the login page", new_string: "  res.clearCookie(\"sid\", { path: \"/\", httpOnly: true, sameSite: \"lax\", secure: true });" }, "The file src/routes/login.ts has been updated.");
  t.run("Bash", { command: "npm run build", description: "Build the app" }, buildLog());

  // Compaction, a slash command, a shell command
  t.compact({ trigger: "auto", preTokens: 162000, summary: "The user reported a login redirect loop for users with an expired session cookie. Cause: /login redirected on the mere presence of a cookie while requireAuth rejected expired sessions. Fixed by making readSession return null for expired sessions, having /login use it and clear the stale cookie. Updated tests/auth/login.test.ts, added tests/auth/expired-session.test.ts, applied the security review's note on clearCookie options. All tests pass and the build is green. Remaining: changelog entry and a draft PR." });
  t.command("cost");
  t.caveat();
  t.commandOutput("Total cost:            $0.84\nTotal duration (API):  3m 41s\nTotal duration (wall): 21m 9s\nTotal code changes:    61 lines added, 9 lines removed");
  t.bashInput("git status --short");
  t.bashOutput(" M src/auth/session.ts\n M src/routes/login.ts\n M tests/auth/login.test.ts\n?? tests/auth/expired-session.test.ts");

  // The next morning
  t.skip(23 * 3600_000);
  t.prompt("Morning. Please add a changelog entry and open a draft PR with a short description.");
  t.assistant([{ type: "thinking", thinking: "The summary says the changelog entry and the PR are what is left. Keep the entry to one line under Fixed, and put the cause in the PR body since reviewers will ask.", signature: "demo" }], { stop: null });
  t.run("Edit", { file_path: at("CHANGELOG.md"), old_string: "## Unreleased\n\n### Fixed\n", new_string: "## Unreleased\n\n### Fixed\n- Login no longer loops for users whose session cookie has expired (#482)." }, "The file CHANGELOG.md has been updated.");
  t.run("mcp__github__create_pull_request", { owner: "acme", repo: "webapp", title: "Fix login redirect loop for expired sessions", head: "fix/login-redirect", base: "main", draft: true, body: "`/login` redirected on the presence of a cookie while `requireAuth` rejected expired sessions, so they redirected to each other.\n\n`readSession` now decides, and `/login` clears the stale cookie." }, "Created draft pull request #482: https://example.com/acme/webapp/pull/482");
  t.say("Done. The changelog has a one-line entry, and the draft PR is up: [PR #482](https://example.com/acme/webapp/pull/482). Its description gives the cause in two sentences and says that `readSession` is now the only place that decides whether a session is valid.");
  t.customTitle("Fix the login redirect loop");
  return t;
}

const numbered = (text) => text.replace(/\n$/, "").split("\n").map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");

const TEST_FAIL = ` FAIL  tests/auth/login.test.ts
  login
    ✕ redirects home when a cookie is present (24 ms)

  ● login › redirects home when a cookie is present

    expect(received).toBe(expected) // Object.is equality

    Expected: 302
    Received: 200

      6 |     const res = await request(app).get("/login").set("Cookie", "sid=abc");
      7 |     expect(res.status).toBe(302);
        |                        ^

Test Suites: 1 failed, 4 passed, 5 total
Tests:       1 failed, 18 passed, 19 total
Time:        2.481 s
Exit code 1`;
const TEST_PASS = ` PASS  tests/auth/session.test.ts
 PASS  tests/auth/login.test.ts
 PASS  tests/routes/logout.test.ts
 PASS  tests/routes/home.test.ts
 PASS  tests/app.test.ts

Test Suites: 5 passed, 5 total
Tests:       19 passed, 19 total
Time:        2.612 s`;
const TEST_ONE_PASS = ` PASS  tests/auth/expired-session.test.ts
  expired session
    ✓ shows the login form instead of looping (31 ms)
    ✓ clears the stale cookie (9 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Time:        1.204 s`;
const EXPIRED_TEST = `import request from "supertest";
import { app } from "../../src/app";
import { createSession } from "../../src/auth/store";

// Regression test: an expired session cookie used to make /login and / redirect to each other.
describe("expired session", () => {
  const expired = () => createSession({ userId: 1, ttlMs: -1 });

  it("shows the login form instead of looping", async () => {
    const res = await request(app).get("/login").set("Cookie", \`sid=\${expired()}\`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<form");
  });

  it("clears the stale cookie", async () => {
    const res = await request(app).get("/login").set("Cookie", \`sid=\${expired()}\`);
    expect(res.headers["set-cookie"].join(";")).toMatch(/sid=;/);
  });
});
`;

// A long build log, so the example also shows how big output is cut.
function buildLog() {
  const lines = ["> webapp@2.4.0 build", "> tsc -p tsconfig.build.json && node scripts/bundle.mjs", ""];
  for (let i = 1; i <= 700; i++) lines.push(`bundle  dist/chunks/chunk-${String(i).padStart(4, "0")}.js  ${(12 + (i * 7) % 90).toFixed(1)} kB  ok`);
  lines.push("", "Build finished in 18.2 s: 700 chunks, 4.6 MB total.");
  return lines.join("\n");
}

// The page: the demo session exported by the same code the command line uses.
export function buildExample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-example-"));
  try {
    const { file } = demoTranscript().write(path.join(dir, "claude"));
    return replayFile(file, { home: HOME, theme: "auto" }).text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const html = buildExample();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, "utf8") : "";
    if (current !== html) { console.error("docs/example.html is out of date. Run: npm run build:example"); process.exitCode = 1; } else console.log("docs/example.html is up to date.");
  } else {
    fs.mkdirSync(path.dirname(EXAMPLE), { recursive: true });
    fs.writeFileSync(EXAMPLE, html);
    console.log(`Wrote ${EXAMPLE} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
  }
}
