import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { baseName, capText, cleanText, compact, forEachLine, kb, makeColors, num, oneLine, plural, utcDay, utcMinute, utcStamp, utcTime } from "../src/util.mjs";
import { parseArgs, parseMaxOutput } from "../src/cli.mjs";
import { UserError } from "../src/util.mjs";

test("numbers: thousands separators, compact token counts, sizes", () => {
  assert.equal(num(1234567), "1,234,567");
  assert.equal(num(12), "12");
  assert.equal(plural(1, "turn"), "1 turn");
  assert.equal(plural(1234, "turn"), "1,234 turns");
  assert.equal(compact(950), "950");
  assert.equal(compact(12345), "12.3K");
  assert.equal(compact(123456), "123K");
  assert.equal(compact(2000), "2K");
  assert.equal(compact(1234567), "1.2M");
  assert.equal(compact(999999), "1M");
  assert.equal(kb(512), "512 B");
  assert.equal(kb(2048), "2 KB");
  assert.equal(kb(5 * 1048576), "5.0 MB");
});

test("text: one line, base names in either spelling", () => {
  assert.equal(oneLine("a\n  b\t c", 50), "a b c");
  assert.equal(oneLine("x".repeat(30), 10), "xxxxxxxxx…");
  assert.equal(baseName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(baseName("/home/me/proj"), "proj");
  assert.equal(baseName(""), "");
});

test("dates are UTC and survive junk", () => {
  assert.equal(utcDay("2026-10-01T23:59:59.999Z"), "2026-10-01");
  assert.equal(utcTime("2026-10-01T09:05:07.000Z"), "09:05:07");
  assert.equal(utcStamp("2026-10-01T09:05:07.000Z"), "2026-10-01 09:05:07");
  assert.equal(utcMinute("2026-10-01T09:05:07.000Z"), "2026-10-01 09:05");
  assert.equal(utcStamp("not a date"), "");
  assert.equal(utcDay(undefined), "");
});

test("cleanText removes colour codes, bidi overrides and control characters, keeps tabs and newlines", () => {
  assert.equal(cleanText("\x1b[31mred\x1b[0m ok"), "red ok");
  assert.equal(cleanText("a\u202Eb\u2066c"), "abc");
  assert.equal(cleanText("a\x00b\x07c\x1fd"), "abcd");
  assert.equal(cleanText("a\tb\nc"), "a\tb\nc");
  assert.equal(cleanText("one\r\ntwo"), "one\ntwo");
  assert.equal(cleanText("10%\r20%\r30%\ndone"), "30%\ndone", "a progress bar keeps its last draw");
  assert.equal(cleanText("\x1b]0;title\x07text"), "text", "OSC sequences go");
  assert.equal(cleanText(null), "");
});

test("cleanText is fast on a huge line with carriage returns", () => {
  const big = "x".repeat(2_000_000) + "\r" + "y".repeat(2_000_000);
  const t0 = Date.now();
  assert.equal(cleanText(big).length, 2_000_000);
  assert.ok(Date.now() - t0 < 2000);
});

test("capText keeps the start and the end and says how much it dropped", () => {
  const s = "a".repeat(1000) + "b".repeat(1000);
  const r = capText(s, 100);
  assert.ok(r.omitted > 1800);
  assert.ok(r.text.startsWith("a".repeat(70)));
  assert.ok(r.text.endsWith("b".repeat(30)));
  assert.deepEqual(capText("short", 100), { text: "short", omitted: 0 });
  assert.equal(capText(s, 0).omitted, 0, "0 means no limit");
  assert.equal(capText(s, 0).text, s);
});

test("capText never splits a surrogate pair", () => {
  const s = "😀".repeat(500); // each is two UTF-16 units
  for (const max of [51, 52, 99, 101]) {
    const r = capText(s, max);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.text), `lone high surrogate at max ${max}`);
    assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(r.text), `lone low surrogate at max ${max}`);
  }
});

test("forEachLine reads lines with LF, CRLF, a BOM and no final newline", () => {
  const dir = tmpDir("cr-u-");
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, "\uFEFF{\"a\":1}\r\n\r\n{\"b\":2}\n{\"c\":3}");
  const seen = [];
  assert.equal(forEachLine(file, (l) => { seen.push(l); }), true);
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("forEachLine handles multi-byte characters across read boundaries and lines over 1 MB", () => {
  const dir = tmpDir("cr-u-");
  const file = path.join(dir, "b.jsonl");
  const long = "é€😀".repeat(400_000); // about 3.6 MB on one line
  fs.writeFileSync(file, `first\n${long}\nlast\n`);
  const seen = [];
  forEachLine(file, (l) => { seen.push(l.length); });
  assert.deepEqual(seen, [5, long.length, 4]);
  const lines = [];
  forEachLine(file, (l) => { lines.push(l); });
  assert.equal(lines[1], long, "no character was damaged at a chunk boundary");
});

test("forEachLine stops early when asked and reports a missing file", () => {
  const dir = tmpDir("cr-u-");
  const file = path.join(dir, "c.jsonl");
  fs.writeFileSync(file, "1\n2\n3\n");
  const seen = [];
  forEachLine(file, (l) => { seen.push(l); return l !== "2" ? undefined : false; });
  assert.deepEqual(seen, ["1", "2"]);
  assert.equal(forEachLine(path.join(dir, "missing"), () => {}), false);
});

test("colours: off for pipes and NO_COLOR, on for a terminal or FORCE_COLOR", () => {
  assert.equal(makeColors({}, false).bold("x"), "x");
  assert.equal(makeColors({}, true).bold("x"), "\x1b[1mx\x1b[0m");
  assert.equal(makeColors({ NO_COLOR: "1" }, true).bold("x"), "x");
  assert.equal(makeColors({ FORCE_COLOR: "1" }, false).bold("x"), "\x1b[1mx\x1b[0m");
  assert.equal(makeColors({ FORCE_COLOR: "0" }, false).on, false);
});

test("--max-output takes kilobytes with an optional unit, and 0 means everything", () => {
  assert.equal(parseMaxOutput(undefined), 20 * 1024);
  assert.equal(parseMaxOutput("64"), 64 * 1024);
  assert.equal(parseMaxOutput("64k"), 64 * 1024);
  assert.equal(parseMaxOutput("64KB"), 64 * 1024);
  assert.equal(parseMaxOutput("1m"), 1024 * 1024);
  assert.equal(parseMaxOutput("0.5"), 512);
  assert.equal(parseMaxOutput("0"), 0);
  assert.throws(() => parseMaxOutput("lots"), UserError);
  assert.throws(() => parseMaxOutput("-3"), UserError);
});

test("argument parsing: flags, values, = form, --, and clear errors", () => {
  const spec = { bool: ["all", "deep"], value: ["limit", "out"] };
  assert.deepEqual(parseArgs(["a", "--all", "b", "--limit", "5"], spec), { _: ["a", "b"], all: true, limit: "5" });
  assert.deepEqual(parseArgs(["--out=x.html", "w"], spec), { _: ["w"], out: "x.html" });
  assert.deepEqual(parseArgs(["--out", "-"], spec), { _: [], out: "-" });
  assert.deepEqual(parseArgs(["--", "--all"], spec), { _: ["--all"] });
  assert.equal(parseArgs(["-h"], spec).help, true);
  assert.throws(() => parseArgs(["--nope"], spec), /Unknown option --nope/);
  assert.throws(() => parseArgs(["--limit"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--limit", "--all"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--all=1"], spec), /does not take a value/);
});
