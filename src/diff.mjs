// A line diff for the old and new text of an edit, shown as red and green lines.
//
// diffLines(old, new) returns lines as { t, s }: t is " " (unchanged), "-" (removed) or "+" (added);
// a stretch of unchanged lines far from any change becomes { t: "…", n } (n lines left out).

const MAX_MIDDLE = 40000; // lines (old + new) left after the shared start and end are trimmed
const MAX_EDITS = 600;   // give up on a minimal diff when the texts differ by more than this

const split = (s) => (s === "" ? [] : String(s).split("\n"));

// Myers' O(ND) algorithm. Returns the edit script, or null when the texts differ by more than maxD.
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const at = (k) => k + max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)]) ? v[at(k + 1)] : v[at(k - 1)] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[at(k)] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, at);
    }
  }
  return null;
}

function backtrack(trace, a, b, dEnd, at) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)]) ? k + 1 : k - 1;
    const prevX = v[at(prevK)];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: " ", s: a[x - 1] }); x--; y--; }
    if (x === prevX) { ops.push({ t: "+", s: b[y - 1] }); y--; } else { ops.push({ t: "-", s: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ t: " ", s: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

// Unchanged lines more than `context` away from a change are folded into one { t: "…", n } marker.
function fold(ops, context) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.t === " ") return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) { out.push(ops[i]); continue; }
    let j = i;
    while (j < ops.length && !keep[j]) j++;
    out.push({ t: "…", n: j - i });
    i = j - 1;
  }
  return out;
}

export function diffLines(oldText, newText, { context = 3 } = {}) {
  const a = split(oldText);
  const b = split(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle = null;
  if (!midA.length) middle = midB.map((s) => ({ t: "+", s }));
  else if (!midB.length) middle = midA.map((s) => ({ t: "-", s }));
  else if (midA.length + midB.length <= MAX_MIDDLE) middle = myers(midA, midB, MAX_EDITS);
  if (!middle) middle = [...midA.map((s) => ({ t: "-", s })), ...midB.map((s) => ({ t: "+", s }))];
  const ops = [
    ...a.slice(0, start).map((s) => ({ t: " ", s })),
    ...middle,
    ...a.slice(endA).map((s) => ({ t: " ", s })),
  ];
  return fold(ops, context);
}

// How many lines a diff adds and removes.
export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) { if (op.t === "+") added++; else if (op.t === "-") removed++; }
  return { added, removed };
}
