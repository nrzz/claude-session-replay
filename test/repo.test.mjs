import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { VERSION } from "../src/version.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const json = (...p) => JSON.parse(read(...p));
const pkg = json("package.json");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
const sources = ["bin", "src", "scripts", "test"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.m?js$/.test(f));

// The specifiers of the static imports at the top of a module. Our files keep their imports together
// before any code, so reading stops at the first other statement (this way text inside a template
// string that happens to look like an import is not mistaken for one).
function headerImports(code) {
  const out = [];
  let buf = "";
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (!buf) {
      if (!t || t.startsWith("//") || t.startsWith("#!")) continue;
      if (!/^import\b/.test(t) && !(/^export\b/.test(t) && /\bfrom\b/.test(t))) break;
    }
    buf += ` ${t}`;
    const m = /^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["'];?\s*$|^\s*import\s*["']([^"']+)["'];?\s*$/.exec(buf);
    if (m) { out.push(m[1] || m[2]); buf = ""; }
  }
  return out;
}

// --- package ------------------------------------------------------------------------------------

test("package.json: name, version, module type, bin, engines, scripts, links, license", () => {
  assert.equal(pkg.name, "claude-session-replay");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-replay": "bin/claude-replay.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.repository, "github:nrzz/claude-session-replay");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-session-replay#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-session-replay/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.description.length > 40);
  for (const k of ["claude-code", "session", "replay", "search"]) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["claude-replay"])));
});

test("the version is the same in the package, the code and the plugin", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(json(".claude-plugin", "plugin.json").version, pkg.version);
});

test("the published files exist, and nothing outside the package is listed", () => {
  for (const f of pkg.files) {
    assert.ok(!f.startsWith("/") && !f.includes(".."), f);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed in files but missing`);
  }
  for (const f of ["bin", "src", "skills", ".claude-plugin", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.files.includes("test") && !pkg.files.includes("scripts") && !pkg.files.includes("docs"));
});

test("zero dependencies: no dependency fields, no lockfile, no node_modules, only node: and relative imports", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) assert.equal(pkg[field], undefined, field);
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not exist`);
  assert.ok(sources.length >= 25);
  for (const file of sources) {
    const code = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(code, /\brequire\(/, `${rel(file)} is ESM`);
    const specifiers = [...headerImports(code), ...[...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])];
    for (const spec of specifiers) {
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${rel(file)} imports "${spec}": only node: built-ins and relative files are allowed`);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), spec)), `${rel(file)} -> ${spec} exists`);
    }
  }
});

test("headerImports reads multi-line imports and stops at the first code", () => {
  const code = '#!/usr/bin/env node\n// comment\nimport fs from "node:fs";\nimport {\n  a,\n  b,\n} from "./x.mjs";\nimport "./side.mjs";\nexport { c } from "./y.mjs";\nconst text = `\nimport z from "not-me";\n`;\n';
  assert.deepEqual(headerImports(code), ["node:fs", "./x.mjs", "./side.mjs", "./y.mjs"]);
});

test("the code stays within what Node 18 has", () => {
  const newer = [/\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /\.with\(\d/, /Object\.groupBy/, /Map\.groupBy/, /Array\.fromAsync/, /Promise\.withResolvers/, /\.isWellFormed\(/, /import\.meta\.(dirname|filename)/, /process\.getBuiltinModule/, /\.union\(|\.intersection\(|\.difference\(/, /fs\.glob\(/, /readdirSync\([^)]*recursive/];
  for (const file of sources.filter((f) => !rel(f).startsWith("test/repo.test"))) {
    const code = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    for (const re of newer) assert.doesNotMatch(code, re, `${rel(file)} uses ${re}`);
  }
});

test("every module in src is used by something", () => {
  const all = sources.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const f of fs.readdirSync(path.join(ROOT, "src"))) assert.ok(all.includes(`/${f}"`) || all.includes(`./${f}"`), `${f} is not imported anywhere`);
});

test("the command's entry file starts with a shebang and imports only the program", () => {
  const code = read("bin", "claude-replay.mjs");
  assert.ok(code.startsWith("#!/usr/bin/env node\n"));
  assert.match(code, /import \{ main \} from "\.\.\/src\/cli\.mjs";/);
});

test("repo housekeeping files", () => {
  assert.equal(read(".gitattributes"), "* text=auto eol=lf\n");
  assert.equal(read(".gitignore"), "node_modules/\n*.log\n.DS_Store\n");
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu\n/);
});

test("CI runs the tests on Linux, Windows and macOS with Node 20, 22 and 24", () => {
  const wf = read(".github", "workflows", "test.yml");
  for (const part of ["name: test", "ubuntu-latest", "windows-latest", "macos-latest", "node: [20, 22, 24]", "- run: npm test", "actions/checkout@v4", "actions/setup-node@v4", "fail-fast: false"]) assert.ok(wf.includes(part), part);
});

// --- the plugin -----------------------------------------------------------------------------------

test("plugin.json describes one plugin named replay", () => {
  const p = json(".claude-plugin", "plugin.json");
  assert.equal(p.name, "replay");
  assert.deepEqual(p.author, { name: "Naresh Prabu" });
  assert.equal(p.license, "MIT");
  assert.equal(p.homepage, "https://github.com/nrzz/claude-session-replay");
  assert.ok(p.description.length > 30);
});

test("marketplace.json offers the plugin from this repository", () => {
  const m = json(".claude-plugin", "marketplace.json");
  assert.equal(m.$schema, "https://anthropic.com/claude-code/marketplace.schema.json");
  assert.equal(m.name, "claude-session-replay");
  assert.deepEqual(m.owner, { name: "Naresh Prabu" });
  assert.equal(m.plugins.length, 1);
  assert.deepEqual({ ...m.plugins[0], description: "…" }, {
    name: "replay", description: "…", author: { name: "Naresh Prabu" }, category: "productivity", source: "./", homepage: "https://github.com/nrzz/claude-session-replay",
  });
  assert.equal(m.plugins[0].name, json(".claude-plugin", "plugin.json").name);
});

test("the skill is user-only, with a short description, one command and a one-line reply", () => {
  const text = read("skills", "replay", "SKILL.md");
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const fields = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  assert.equal(fields.name, "replay");
  assert.equal(fields["disable-model-invocation"], "true");
  assert.ok(fields.description.length < 60, `description is ${fields.description.length} characters`);
  assert.equal(fields["allowed-tools"], "Bash(node *)");
  assert.equal(body.trim(), '!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-replay.mjs" export ${CLAUDE_SESSION_ID} --redact --out "${CLAUDE_PROJECT_DIR}/claude-session-replay.html"`\n\nReply in one line with the path written.');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["replay"]);
  assert.ok(text.length < 600, "the skill stays tiny");
});

// --- the README -----------------------------------------------------------------------------------

const readme = read("README.md");

test("README follows the family template, in order", () => {
  const headings = [...readme.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings.slice(0, 9), ["What it costs in tokens", "Install", "Use", "What the HTML replay shows", "Privacy and redaction", "How it works", "What was verified, and how", "Files", "License"]);
  assert.match(readme, /^# Claude session replay\n\n\[!\[test\]\(https:\/\/github\.com\/nrzz\/claude-session-replay\/actions\/workflows\/test\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/nrzz\/claude-session-replay\/actions\/workflows\/test\.yml\)\n\n/);
});

test("README: two-sentence intro, install commands, a token table, no emoji", () => {
  const intro = readme.split("\n").slice(4).join("\n").split("\n## ")[0].trim();
  assert.equal((intro.match(/[.!?](\s|$)/g) || []).length, 2, `the intro should be two sentences:\n${intro}`);
  for (const cmd of ["npx -y github:nrzz/claude-session-replay", "/plugin marketplace add nrzz/claude-session-replay", "/plugin install replay@claude-session-replay"]) assert.ok(readme.includes(cmd), cmd);
  const tokens = readme.split("## What it costs in tokens")[1].split("\n## ")[0];
  assert.match(tokens, /\| Part \| Tokens \|/);
  assert.match(tokens, /\| 0 \|/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji in the README");
});

test("README names every command and option the program has", () => {
  for (const word of ["claude-replay list", "claude-replay search", "claude-replay export", "claude-replay open", "--all", "--project", "--limit", "--deep", "--html", "--md", "--out", "--redact", "--no-tools", "--no-thinking", "--no-images", "--theme", "--max-output", "--dry-run", "CLAUDE_CONFIG_DIR", "docs/example.html"]) assert.ok(readme.includes(word), `README does not mention ${word}`);
});

test("README's file table lists every top-level folder that holds code", () => {
  const files = readme.split("## Files")[1].split("\n## ")[0];
  for (const f of ["bin/claude-replay.mjs", "src/", "skills/replay/SKILL.md", ".claude-plugin/", "test/", "scripts/build-example.mjs", "docs/example.html"]) assert.ok(files.includes(f), `Files does not list ${f}`);
  for (const f of fs.readdirSync(path.join(ROOT, "src"))) assert.ok(files.includes(f.replace(/\.mjs$/, "")), `Files does not mention src/${f}`);
});
