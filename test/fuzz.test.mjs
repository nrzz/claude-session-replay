import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { world, Transcript, parseHtml, PAYLOADS } from "./helpers.mjs";
import { replayFile } from "../src/replay.mjs";
import { lastTimestamp, quickMeta, scanSession, findSessions } from "../src/claude.mjs";
import { searchSessions } from "../src/search.mjs";

// A transcript as a real machine might produce it on a bad day: records with fields of the wrong
// type, missing fields, repeated ids, broken lines. Nothing here may crash a command, and what
// comes out must still be a well-formed, safe page.

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function makeValue(rnd, depth = 0) {
  const pick = rnd();
  if (pick < 0.12) return null;
  if (pick < 0.2) return Math.floor(rnd() * 1000) - 500;
  if (pick < 0.28) return rnd() < 0.5;
  if (pick < 0.55) return makeString(rnd);
  if (pick < 0.7 && depth < 3) return Array.from({ length: Math.floor(rnd() * 4) }, () => makeValue(rnd, depth + 1));
  if (depth < 3) {
    const o = {};
    for (const k of ["type", "text", "name", "id", "input", "content", "source", "data", "media_type", "file_path", "command", "is_error", "thinking", "edits", "todos", "usage"]) if (rnd() < 0.25) o[k] = makeValue(rnd, depth + 1);
    return o;
  }
  return "leaf";
}
function makeString(rnd) {
  const bits = ["hello", " ", "\n", "```", "<b>", ...PAYLOADS, "C:\\Users\\x\\y", "/home/x/y", "a".repeat(3000), "\u0000", "\x1b[31m", "😀", "\u202e", "[x](javascript:alert(1))", "| a | b |\n|---|---|\n| 1 | 2 |"];
  return Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => bits[Math.floor(rnd() * bits.length)]).join("");
}

function makeRecord(rnd, t) {
  const kinds = ["user", "user", "assistant", "assistant", "assistant", "assistant", "system", "attachment", "summary", "custom-title", "ai-title", "queue-operation", "mystery"];
  const type = kinds[Math.floor(rnd() * kinds.length)];
  const rec = { type, uuid: rnd() < 0.2 ? "dup" : `u${Math.floor(rnd() * 1e9)}`, parentUuid: null, sessionId: t.id, timestamp: rnd() < 0.7 ? new Date(Date.parse("2026-10-01T00:00:00Z") + rnd() * 86400000).toISOString() : makeValue(rnd), cwd: rnd() < 0.8 ? t.cwd : makeValue(rnd), gitBranch: rnd() < 0.5 ? "main" : makeValue(rnd), version: "2.1.286", isSidechain: rnd() < 0.1, isMeta: rnd() < 0.1 };
  if (type === "user" || type === "assistant") {
    const content = rnd() < 0.3 ? makeValue(rnd) : Array.from({ length: Math.floor(rnd() * 4) }, () => makeBlock(rnd));
    rec.message = rnd() < 0.9 ? { id: rnd() < 0.5 ? `m${Math.floor(rnd() * 5)}` : makeValue(rnd), role: type, model: rnd() < 0.8 ? "claude-x" : makeValue(rnd), content, usage: rnd() < 0.7 ? { input_tokens: makeValue(rnd), output_tokens: 5, cache_read_input_tokens: -1, cache_creation_input_tokens: "7" } : makeValue(rnd) } : makeValue(rnd);
  }
  if (type === "system") { rec.subtype = rnd() < 0.5 ? "compact_boundary" : makeValue(rnd); rec.compactMetadata = rnd() < 0.5 ? makeValue(rnd) : undefined; rec.content = makeValue(rnd); }
  if (type === "custom-title") rec.customTitle = makeValue(rnd);
  if (type === "ai-title") rec.aiTitle = makeValue(rnd);
  if (type === "summary") rec.summary = makeValue(rnd);
  if (rnd() < 0.15) rec.toolUseResult = makeValue(rnd);
  if (rnd() < 0.05) rec.isCompactSummary = true;
  return rec;
}
function makeBlock(rnd) {
  const types = ["text", "text", "tool_use", "tool_use", "tool_use", "tool_result", "tool_result", "thinking", "redacted_thinking", "image", "document", "mystery"];
  const type = types[Math.floor(rnd() * types.length)];
  const b = { type };
  if (type === "text") b.text = rnd() < 0.8 ? makeString(rnd) : makeValue(rnd);
  if (type === "tool_use") { b.id = rnd() < 0.7 ? `tu${Math.floor(rnd() * 4)}` : makeValue(rnd); b.name = rnd() < 0.6 ? ["Bash", "Read", "Edit", "Write", "MultiEdit", "TodoWrite", "Task", "Grep", "mcp__a__b", "ExitPlanMode"][Math.floor(rnd() * 10)] : makeValue(rnd); b.input = makeValue(rnd); }
  if (type === "tool_result") { b.tool_use_id = `tu${Math.floor(rnd() * 4)}`; b.content = makeValue(rnd); b.is_error = rnd() < 0.3; }
  if (type === "thinking") b.thinking = makeValue(rnd);
  if (type === "image" || type === "document") b.source = rnd() < 0.7 ? { type: "base64", media_type: rnd() < 0.5 ? "image/png" : makeValue(rnd), data: rnd() < 0.5 ? "iVBORw0KGgo=" : makeValue(rnd) } : makeValue(rnd);
  return b;
}

test("random malformed transcripts never crash any command, and pages stay well-formed", () => {
  const w = world("fuzz");
  const root = w.project("fz");
  const word = "hello";
  for (let n = 0; n < 120; n++) {
    const rnd = prng(1000 + n);
    const t = new Transcript({ cwd: root, seed: `fz${n}`, start: "2026-10-01T09:00:00.000Z" });
    const lines = [];
    const records = 5 + Math.floor(rnd() * 40);
    for (let i = 0; i < records; i++) {
      const r = rnd() < 0.15 ? t.chain({ type: "user", message: { role: "user", content: `normal prompt ${i}` } }) : makeRecord(rnd, t);
      lines.push(JSON.stringify(r));
      if (rnd() < 0.05) lines.push("{ this is not json");
      if (rnd() < 0.03) lines.push("");
      if (rnd() < 0.02) lines.push("[1,2,3]");
    }
    const dir = path.join(w.claude, "projects", path.basename(path.dirname(t.write(w.claude).file)));
    const file = path.join(dir, `${t.id}.jsonl`);
    fs.writeFileSync(file, `${rnd() < 0.2 ? "\uFEFF" : ""}${lines.join(rnd() < 0.3 ? "\r\n" : "\n")}${rnd() < 0.5 ? "\n" : ""}`);
    for (const options of [{}, { redact: true }, { tools: false }, { thinking: false, images: false, maxOutput: 100 }]) {
      for (const format of ["html", "md"]) {
        const { text } = replayFile(file, { home: w.home, format, ...options });
        if (format === "html") {
          const p = parseHtml(text);
          assert.deepEqual(p.errors, [], `seed ${n} ${JSON.stringify(options)}`);
          assert.equal(p.scripts.length, 1);
          for (const tag of p.tags) {
            assert.ok(!Object.keys(tag.attrs).some((k) => k.startsWith("on")));
            if (tag.attrs.href !== undefined) assert.match(tag.attrs.href, /^https?:\/\//);
            if (tag.attrs.src !== undefined) assert.match(tag.attrs.src, /^data:image\/(png|jpeg|gif|webp);base64,/);
          }
        } else assert.ok(typeof text === "string" && text.endsWith("\n"));
      }
    }
    assert.doesNotThrow(() => { scanSession(file); quickMeta(file); lastTimestamp(file); });
  }
  const entries = findSessions({ env: w.env, all: true });
  assert.doesNotThrow(() => { searchSessions(entries, [word]); searchSessions(entries, [word, "normal"], { deep: true }); });
});

test("a file that is not a transcript at all is handled", () => {
  const w = world("fuzz");
  const dir = path.join(w.claude, "projects", "x");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  for (const content of ["", "\n\n", "not json\nat all\n", "\u0000\u0000\u0000", "{}\n{}\n", Buffer.from([0xff, 0xfe, 0x00, 0x41])]) {
    fs.writeFileSync(file, content);
    assert.doesNotThrow(() => replayFile(file, { home: w.home }));
    assert.doesNotThrow(() => replayFile(file, { home: w.home, format: "md" }));
    assert.doesNotThrow(() => scanSession(file));
  }
  const html = replayFile(file, { home: w.home }).text;
  assert.match(html, /This session has no conversation to show/);
});
