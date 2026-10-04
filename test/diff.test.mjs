import test from "node:test";
import assert from "node:assert/strict";
import { cpuMs } from "./helpers.mjs";
import { diffLines, diffStats } from "../src/diff.mjs";

// Rebuilds both texts from a diff made without folding.
const rebuild = (ops) => ({
  before: ops.filter((o) => o.t === " " || o.t === "-").map((o) => o.s).join("\n"),
  after: ops.filter((o) => o.t === " " || o.t === "+").map((o) => o.s).join("\n"),
});

test("a one-line change is one removed and one added line", () => {
  const ops = diffLines("redirect(callbackUrl)", "redirect(safe(callbackUrl))");
  assert.deepEqual(ops, [{ t: "-", s: "redirect(callbackUrl)" }, { t: "+", s: "redirect(safe(callbackUrl))" }]);
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1 });
});

test("lines that stay are shown as context around the change", () => {
  const ops = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(ops.map((o) => o.t + o.s), [" a", "-b", "+B", " c"]);
});

test("pure insertions and pure deletions", () => {
  assert.deepEqual(diffLines("", "x\ny"), [{ t: "+", s: "x" }, { t: "+", s: "y" }]);
  assert.deepEqual(diffLines("x\ny", ""), [{ t: "-", s: "x" }, { t: "-", s: "y" }]);
  assert.deepEqual(diffLines("", ""), []);
  assert.deepEqual(diffStats(diffLines("a\nb", "a\nb\nc")), { added: 1, removed: 0 });
});

test("identical text has no changes, only a folded run of context", () => {
  const ops = diffLines("a\nb\nc", "a\nb\nc");
  assert.deepEqual(ops, [{ t: "…", n: 3 }]);
  assert.deepEqual(diffStats(ops), { added: 0, removed: 0 });
});

test("unchanged lines far from a change are folded, with their count", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 10", "LINE 10");
  const ops = diffLines(before, after, { context: 2 });
  assert.deepEqual(ops[0], { t: "…", n: 8 });
  assert.deepEqual(ops.filter((o) => o.t !== "…").map((o) => o.t + o.s), [" line 8", " line 9", "-line 10", "+LINE 10", " line 11", " line 12"]);
  assert.deepEqual(ops.at(-1), { t: "…", n: 7 });
});

test("the diff is minimal: the classic example needs five edits", () => {
  const ops = diffLines("A\nB\nC\nA\nB\nB\nA", "C\nB\nA\nB\nA\nC", { context: 100 });
  const s = diffStats(ops);
  assert.equal(s.added + s.removed, 5);
  const { before, after } = rebuild(ops);
  assert.equal(before, "A\nB\nC\nA\nB\nB\nA");
  assert.equal(after, "C\nB\nA\nB\nA\nC");
});

test("random edits: removed and unchanged lines rebuild the old text, added and unchanged the new", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lines = (n) => Array.from({ length: n }, () => "abcde"[Math.floor(rnd() * 5)]);
  for (let i = 0; i < 400; i++) {
    const a = lines(Math.floor(rnd() * 30)).join("\n");
    const b = lines(Math.floor(rnd() * 30)).join("\n");
    if (a === b) continue;
    const { before, after } = rebuild(diffLines(a, b, { context: 1000 }));
    assert.equal(before, a, `old text not rebuilt for ${JSON.stringify([a, b])}`);
    assert.equal(after, b, `new text not rebuilt for ${JSON.stringify([a, b])}`);
  }
});

test("a large file with a few changes is diffed exactly and fast", () => {
  const a = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const b = Array.from({ length: 2000 }, (_, i) => (i % 50 === 0 ? `changed ${i}` : `line ${i}`)).join("\n");
  const { result: stats, ms } = cpuMs(() => diffStats(diffLines(a, b)));
  assert.deepEqual(stats, { added: 40, removed: 40 });
  assert.ok(ms < 1000, `${ms} ms of CPU`);
});

test("texts that share almost nothing fall back to remove-all, add-all instead of running away", () => {
  const a = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join("\n");
  const { result: ops, ms } = cpuMs(() => diffLines(a, b));
  assert.deepEqual(diffStats(ops), { added: 1500, removed: 1500 });
  assert.ok(ms < 2000, `${ms} ms of CPU`);
});

test("a trailing newline is a line like any other", () => {
  const { before, after } = rebuild(diffLines("a\n", "a", { context: 100 }));
  assert.equal(before, "a\n");
  assert.equal(after, "a");
});
