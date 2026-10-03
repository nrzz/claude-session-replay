import test from "node:test";
import assert from "node:assert/strict";
import { SECRETS } from "./helpers.mjs";
import { describeCounts, findSecrets, makeDisplay, makeRedactor, pathMapper, relPath } from "../src/redact.mjs";

const j = (...parts) => parts.join(""); // fake secrets built from pieces, so scanners do not flag the source

test("redaction catches the common secret shapes", () => {
  const redact = makeRedactor();
  const cases = {
    "private-key": j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIabc\n-----END RSA ", "PRIVATE KEY-----"),
    "anthropic-key": `key ${SECRETS.anthropic}`,
    "openai-key": j("OPENAI sk-", "proj-", "x".repeat(40)),
    "stripe-key": `key ${SECRETS.stripe}`,
    "github-token": `token ${SECRETS.github}`,
    "gitlab-token": j("glp", "at-", "abcdefghijklmnopqrstu"),
    "slack-token": `token ${SECRETS.slack}`,
    "slack-webhook": j("https://hooks.sl", "ack.com/services/T000/B000/XXXXXXXX"),
    "teams-webhook": j("https://acme.web", "hook.office.com/webhookb2/abc@def/IncomingWebhook/123"),
    "aws-access-key": `id ${SECRETS.aws}`,
    "google-api-key": j("AI", "za", "B".repeat(35)),
    "google-oauth-secret": j("GOC", "SPX-", "abcdefghijklmnopqrstu"),
    "npm-token": j("np", "m_", "a".repeat(36)),
    "huggingface-token": j("h", "f_", "a".repeat(34)),
    "sendgrid-key": j("S", "G.", "abcdefghijklmnop", ".", "abcdefghijklmnopqrst"),
    jwt: j("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    "bearer-token": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "url-password": `postgres://app:${SECRETS.dbPassword}@db:5432/app`,
    "aws-secret": j("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    "azure-key": "DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCD==;",
    "connection-password": "Server=db;Database=app;User Id=sa;Password=S3cret!x;",
    "env-secret": "DATABASE_PASSWORD=correcthorse\nSTRIPE_SECRET_KEY=abcd1234",
    "assigned-secret": 'const config = { apiKey: "a1b2c3d4e5f6g7" }',
  };
  for (const [kind, text] of Object.entries(cases)) {
    const out = redact(text, {});
    assert.match(out, new RegExp(`\\[REDACTED:${kind}\\]`), `${kind} not redacted in: ${out}`);
  }
  assert.ok(redact(cases["url-password"], {}).startsWith("postgres://app:"), "the user name stays");
  assert.ok(!redact(cases["url-password"], {}).includes(SECRETS.dbPassword));
});

test("redaction leaves ordinary code and look-alikes alone", () => {
  const redact = makeRedactor();
  for (const b of [
    "function login(password: string, token: Token) {}",
    "const token = getToken(); const apiKey = process.env.API_KEY;",
    'api_key = "your-api-key-here"',
    "http://localhost:3000/callback?x=1",
    "https://example.com/a:b",
    "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 and id 0499592b-bf15-4d64-964f-37ee687597b6",
    "user.Password = model.Password;",
    "PASSWORD=${DB_PASSWORD}",
    'password: "changeme"',
    "Basic configuration of the application",
  ]) assert.equal(redact(b, {}), b, `false positive on: ${b}`);
});

test("redaction counts what it replaced, by kind", () => {
  const counts = {};
  const out = makeRedactor()(`${SECRETS.github} and ${SECRETS.github.replace("c", "d")} and ${SECRETS.aws}`, counts);
  assert.deepEqual(counts, { "github-token": 2, "aws-access-key": 1 });
  assert.equal((out.match(/\[REDACTED:/g) || []).length, 3);
});

test("custom redaction patterns apply, and a bad pattern is skipped", () => {
  assert.equal(makeRedactor(["ACME-[0-9]{6}", "("])("ticket ACME-123456 opened", {}), "ticket [REDACTED:custom] opened");
});

test("short strings and non-strings are returned unchanged", () => {
  const redact = makeRedactor();
  assert.equal(redact("short", {}), "short");
  assert.equal(redact(42, {}), 42);
});

// --- paths -----------------------------------------------------------------------------------

test("paths: the project becomes . or a relative path, the home folder ~, in any slash and letter case", () => {
  const counts = { paths: 0 };
  const map = pathMapper({ root: "D:\\Work\\webapp", home: "C:\\Users\\alice", slug: "D--Work-webapp", toolResults: "C:\\Users\\alice\\.claude\\projects\\D--Work-webapp\\abc\\tool-results" }, counts);
  assert.equal(map("open D:\\Work\\webapp\\src\\a.ts now"), "open src/a.ts now");
  assert.equal(map("d:/work/webapp/src/a.ts"), "src/a.ts");
  assert.equal(map("cd D:\\Work\\webapp && ls"), "cd . && ls");
  assert.equal(map("see D:\\Work\\webapp."), "see ..", "a full stop after the folder is still there after the folder became a dot");
  assert.equal(map("D:\\Work\\webapp-old\\x"), "D:\\Work\\webapp-old\\x", "a sibling folder is not the project");
  assert.equal(map("C:\\Users\\alice\\notes.txt"), "~/notes.txt");
  assert.equal(map("C:\\Users\\alice2\\notes.txt"), "C:\\Users\\alice2\\notes.txt");
  assert.equal(map("C:\\Users\\alice\\.claude\\projects\\D--Work-webapp\\abc\\tool-results\\b.txt"), "<tool-results>/b.txt");
  assert.equal(map("C:\\Users\\alice\\.claude\\projects\\D--Work-webapp\\memory\\m.md"), "~/.claude/projects/<project>/memory/m.md");
  assert.ok(counts.paths >= 8);
});

test("paths: a grep result keeps its line and column, and a regex with backslashes is not touched", () => {
  const map = pathMapper({ root: "D:\\Work\\webapp", home: "C:\\Users\\alice" });
  assert.equal(map("D:\\Work\\webapp\\src\\a.ts:12:3: error"), "src/a.ts:12:3: error");
  assert.equal(map("/^\\d+\\.\\w+$/ in D:\\Work\\webapp\\src"), "/^\\d+\\.\\w+$/ in src");
});

test("paths: Git Bash, WSL and Cygwin spellings of a Windows folder are recognised", () => {
  const map = pathMapper({ root: "C:\\Work\\webapp", home: "C:\\Users\\alice" });
  assert.equal(map("/c/Work/webapp/src/a.ts"), "src/a.ts");
  assert.equal(map("/mnt/c/Users/alice/notes.txt"), "~/notes.txt");
  assert.equal(map("/cygdrive/c/Work/webapp"), ".");
});

test("paths: on macOS and Linux paths match exactly, including case", () => {
  const map = pathMapper({ root: "/tmp/ct-L9eIpn/webapp", home: "/tmp/ct-L9eIpn", slug: "-tmp-ct-L9eIpn-webapp" });
  assert.equal(map("open /tmp/ct-L9eIpn/webapp/src/a.ts"), "open src/a.ts");
  assert.equal(map("/tmp/ct-l9eipn/webapp/src/a.ts"), "/tmp/ct-l9eipn/webapp/src/a.ts");
  assert.equal(map("/tmp/ct-L9eIpn/notes.txt"), "~/notes.txt");
  assert.equal(map("~/.claude/projects/-tmp-ct-L9eIpn-webapp/x"), "~/.claude/projects/<project>/x");
});

test("a literal placeholder in the text is left alone", () => {
  const map = pathMapper({ root: "/w/app", home: "/home/me" });
  assert.equal(map("template {{HOME}} and {{PROJECT_ROOT}}"), "template {{HOME}} and {{PROJECT_ROOT}}");
});

test("relPath: relative to the project when inside it, otherwise as given", () => {
  assert.equal(relPath("/w/app/src/a.ts", "/w/app"), "src/a.ts");
  assert.equal(relPath("/w/app", "/w/app"), ".");
  assert.equal(relPath("/etc/hosts", "/w/app"), "/etc/hosts");
  assert.equal(relPath("C:\\Work\\app\\src\\a.ts", "C:\\Work\\app"), "src/a.ts");
  assert.equal(relPath("c:/work/APP/src/a.ts", "C:\\Work\\app"), "src/a.ts");
  assert.equal(relPath("~\\notes.txt", ""), "~/notes.txt");
  assert.equal(relPath("", "/w"), ".");
});

// --- the display function ---------------------------------------------------------------------

test("without --redact only the home folder changes (and control codes go)", () => {
  const d = makeDisplay({ redact: false, root: "/w/app", home: "/home/dev", slug: "-w-app" });
  assert.equal(d.text("/home/dev/notes.txt and /w/app/src/a.ts"), "~/notes.txt and /w/app/src/a.ts");
  assert.equal(d.text(`key ${SECRETS.github}`), `key ${SECRETS.github}`);
  assert.equal(d.text("\x1b[31mred\x1b[0m"), "red");
  assert.equal(d.counts.paths, 1);
});

test("with --redact secrets, the project folder and the home folder are all dealt with", () => {
  const d = makeDisplay({ redact: true, root: "/w/app", home: "/home/dev", slug: "-w-app" });
  assert.equal(d.text(`cd /w/app && echo ${SECRETS.github} > /home/dev/x`), "cd . && echo [REDACTED:github-token] > ~/x");
  assert.deepEqual(d.counts.secrets, { "github-token": 1 });
});

test("deep maps every string inside an object and leaves the rest", () => {
  const d = makeDisplay({ redact: true, root: "/w/app", home: "/home/me" });
  const out = d.deep({ a: "/w/app/x", n: 3, ok: true, list: ["/home/me/y", { z: `k ${SECRETS.aws}` }], nothing: null });
  assert.deepEqual(out, { a: "x", n: 3, ok: true, list: ["~/y", { z: "k [REDACTED:aws-access-key]" }], nothing: null });
});

test("describeCounts reads as one line", () => {
  assert.equal(describeCounts({ secrets: {}, paths: 0, thinking: 0, images: 0 }), "no secrets found");
  assert.equal(
    describeCounts({ secrets: { "github-token": 2, "env-secret": 1 }, paths: 18, thinking: 2, images: 1 }),
    "replaced 3 secrets (github-token 2, env-secret 1); dropped 2 thinking blocks and 1 image; rewrote 18 paths",
  );
  assert.equal(describeCounts({ secrets: { jwt: 1 }, paths: 1, thinking: 1, images: 0 }), "replaced 1 secret (jwt 1); dropped 1 thinking block; rewrote 1 path");
});

test("findSecrets sees quoted values inside HTML-escaped text", () => {
  assert.deepEqual(findSecrets(`<pre>const c = { apiKey: &quot;a1b2c3d4e5f6g7&quot; }; ${SECRETS.github}</pre>`), { "assigned-secret": 1, "github-token": 1 });
  assert.deepEqual(findSecrets("nothing to see here"), {});
});
