// The page's own style sheet and script, and its Content-Security-Policy. All of it is fixed text
// written here: no transcript content is ever put into the style sheet or the script.

// Nothing may be loaded from anywhere: scripts and styles only from this page, images only from
// data: URLs (the transcript's own pasted images), no fetches, no frames, no forms.
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

const LIGHT = {
  bg: "#ffffff", fg: "#1f2328", muted: "#59636e", line: "#d1d9e0", soft: "#f6f8fa", soft2: "#eaeef2",
  "you-bg": "#eff6ff", "you-line": "#3b82f6", accent: "#cc785c", link: "#0969da",
  "inline-bg": "#eff1f3", "code-bg": "#f6f8fa",
  "add-bg": "#e6ffed", "add-fg": "#1a7f37", "del-bg": "#ffebe9", "del-fg": "#cf222e", "hunk-bg": "#ddf4ff",
  err: "#cf222e", "err-bg": "#fff0ee", ok: "#1a7f37",
  kw: "#cf222e", str: "#0a3069", com: "#6e7781", num: "#0550ae", shadow: "0 1px 2px rgba(31,35,40,.08)",
};
const DARK = {
  bg: "#0d1117", fg: "#e6edf3", muted: "#8d96a0", line: "#30363d", soft: "#151b23", soft2: "#212830",
  "you-bg": "#101b2e", "you-line": "#4493f8", accent: "#e0896b", link: "#58a6ff",
  "inline-bg": "#262c36", "code-bg": "#151b23",
  "add-bg": "#10281d", "add-fg": "#56d364", "del-bg": "#2d1618", "del-fg": "#ff7b72", "hunk-bg": "#0d2238",
  err: "#ff7b72", "err-bg": "#2b1517", ok: "#56d364",
  kw: "#ff7b72", str: "#a5d6ff", com: "#8d96a0", num: "#79c0ff", shadow: "0 1px 2px rgba(0,0,0,.4)",
};
const vars = (o, important = "") => Object.entries(o).map(([k, v]) => `--${k}:${v}${important}`).join(";");

export const CSS = `
:root{${vars(LIGHT)};--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(DARK)};color-scheme:dark}}
:root[data-theme="dark"]{${vars(DARK)};color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);-webkit-text-size-adjust:100%}
.wrap{max-width:54rem;margin:0 auto;padding:0 16px 4rem}
a{color:var(--link);overflow-wrap:anywhere}
code,pre{font-family:var(--mono)}
header{padding-top:2rem}
h1{font-size:1.65rem;line-height:1.25;margin:0 0 .35rem;overflow-wrap:anywhere}
.sub{margin:0 0 .8rem;color:var(--muted);font-size:.9rem}
.meta{display:flex;flex-wrap:wrap;gap:.4rem}
.pill{background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:.1rem .65rem;font-size:.8rem;color:var(--muted);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.pill b{color:var(--fg);font-weight:600}
.bar{display:none;position:sticky;top:0;z-index:5;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.6rem 0;margin:1rem 0 .5rem;background:var(--bg);border-bottom:1px solid var(--line)}
.js .bar{display:flex}
.bar input{flex:1 1 10rem;min-width:0;padding:.4rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--soft);color:var(--fg);font:inherit;font-size:.9rem}
.bar input:focus{outline:2px solid var(--link);outline-offset:-1px}
.bar button{padding:.35rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--soft);color:var(--fg);font:inherit;font-size:.82rem;cursor:pointer}
.bar button:hover{background:var(--soft2)}
.bar button[aria-pressed="true"]{border-color:var(--link);color:var(--link)}
#count{color:var(--muted);font-size:.82rem;min-width:5rem}
.turn{margin:1.1rem 0}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem .7rem;margin-bottom:.25rem;font-size:.78rem;color:var(--muted)}
.who .name{font-size:.88rem;font-weight:600;color:var(--fg)}
.who .mdl{font:11.5px var(--mono)}
.turn.claude .name::before{content:"";display:inline-block;width:.55rem;height:.55rem;margin-right:.4rem;border-radius:50%;background:var(--accent)}
.turn.you .body{background:var(--you-bg);border-left:3px solid var(--you-line);border-radius:0 8px 8px 0;padding:.55rem .9rem}
.turn.you .name::before{content:"";display:inline-block;width:.55rem;height:.55rem;margin-right:.4rem;border-radius:50%;background:var(--you-line)}
.plain{white-space:pre-wrap;overflow-wrap:anywhere}
.plain+.fence,.fence+.plain{margin-top:.5rem}
.md>:first-child{margin-top:0}
.md>:last-child{margin-bottom:0}
.md p{margin:.55rem 0}
.md h3,.md h4,.md h5,.md h6{margin:1.1rem 0 .4rem;line-height:1.3}
.md h3{font-size:1.2rem}.md h4{font-size:1.05rem}.md h5,.md h6{font-size:.95rem}
.md ul,.md ol{margin:.5rem 0;padding-left:1.5rem}
.md li{margin:.15rem 0}
.md li>ul,.md li>ol{margin:.15rem 0}
.md hr{border:0;border-top:1px solid var(--line);margin:1rem 0}
.md blockquote{margin:.6rem 0;padding:.05rem .9rem;border-left:3px solid var(--line);color:var(--muted)}
.md.apierr{color:var(--err)}
.dim{color:var(--muted)}
:not(pre)>code{font-size:.88em;background:var(--inline-bg);padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
.tablewrap{overflow-x:auto;margin:.6rem 0}
table{border-collapse:collapse;font-size:.9rem}
th,td{border:1px solid var(--line);padding:.3rem .65rem;text-align:left;vertical-align:top}
th{background:var(--soft)}
td.right,th.right{text-align:right}td.center,th.center{text-align:center}
.fence{position:relative;margin:.6rem 0}
.lang{position:absolute;top:.2rem;right:.55rem;font:11px var(--mono);color:var(--muted);pointer-events:none}
pre{margin:0;padding:.6rem .85rem;overflow:auto;max-height:30rem;background:var(--code-bg);border:1px solid var(--line);border-radius:6px;font-size:12.5px;line-height:1.5;tab-size:4}
.k{color:var(--kw)}.s{color:var(--str)}.c{color:var(--com);font-style:italic}.n{color:var(--num)}
.dl{display:block;min-width:max-content}
.dl.add{background:var(--add-bg);color:var(--add-fg)}
.dl.del{background:var(--del-bg);color:var(--del-fg)}
.dl.hunk,.dl.fold{background:var(--hunk-bg);color:var(--muted)}
.dl.meta{color:var(--muted)}
pre.diff{padding-left:0;padding-right:0}
pre.diff .dl{padding:0 .85rem}
details.tool{margin:.4rem 0;border:1px solid var(--line);border-left:3px solid var(--k,var(--muted));border-radius:6px;background:var(--soft);box-shadow:var(--shadow)}
details.tool>summary{display:flex;align-items:baseline;gap:.55rem;padding:.32rem .65rem;cursor:pointer;list-style:none;font-size:.85rem;min-width:0}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"\\25B8";flex:none;color:var(--muted);font-size:.8em}
details.tool[open]>summary::before{content:"\\25BE"}
details.tool>summary:hover{background:var(--soft2)}
.tn{flex:none;font-weight:600;color:var(--k,var(--fg))}
.td{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none!important;padding:0!important;font-size:12.5px!important;color:var(--fg)}
.ts{flex:none;color:var(--muted);font-size:.76rem;white-space:nowrap}
.badge{flex:none;padding:0 .45rem;border-radius:999px;font-size:.72rem;font-weight:600;border:1px solid currentColor}
.badge.err{color:var(--err)}
details.tool.failed{border-left-color:var(--err);background:var(--err-bg)}
.tb{padding:.45rem .7rem .7rem;border-top:1px solid var(--line)}
.tb>*+*{margin-top:.5rem}
.path{font:12.5px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.desc{color:var(--muted);font-size:.85rem}
.kind-read{--k:#4c8dff}.kind-edit{--k:#e0883a}.kind-write{--k:#2fa66a}.kind-bash{--k:#9a6dd7}.kind-search{--k:#1aa6a6}
.kind-web{--k:#d4538f}.kind-agent{--k:#6d78e8}.kind-todo{--k:#8a94a0}.kind-mcp{--k:#12a5c9}.kind-plan{--k:#c9a227}.kind-other{--k:#8a94a0}
details.out{border:1px solid var(--line);border-radius:6px;background:var(--bg)}
details.out>summary{padding:.2rem .6rem;cursor:pointer;color:var(--muted);font-size:.78rem}
details.out.err>summary{color:var(--err)}
details.out>pre{border:0;border-top:1px solid var(--line);border-radius:0 0 6px 6px}
.trunc,.noout,.more{margin:0;padding:.3rem .65rem;color:var(--muted);font-size:.78rem}
.trunc{border-top:1px dashed var(--line);font-style:italic}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.1rem .9rem;margin:0;font:12.5px var(--mono)}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.todos{list-style:none;margin:0;padding:0;font-size:.88rem}
.todos li{margin:.1rem 0}
.todos .done{color:var(--muted);text-decoration:line-through}
img.shot{display:block;max-width:100%;height:auto;margin:.45rem 0;border:1px solid var(--line);border-radius:6px}
.imgnote{display:inline-block;margin:.3rem 0;padding:.1rem .6rem;border:1px dashed var(--line);border-radius:6px;color:var(--muted);font-size:.8rem}
.cmd{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem}
.chip{display:inline-block;padding:.05rem .6rem;border:1px solid var(--line);border-radius:999px;background:var(--bg);font:600 12.5px var(--mono)}
.args{overflow-wrap:anywhere}
.cmd+details.out,.cmd+.plain{margin-top:.5rem}
.thinking{display:none;margin:.45rem 0;padding:.45rem .8rem;border-left:3px dashed var(--line);color:var(--muted);font-size:.9rem;font-style:italic;white-space:pre-wrap;overflow-wrap:anywhere}
.show-thinking .thinking{display:block}
.turn.only-think{display:none}
.show-thinking .turn.only-think{display:block}
.hide-tools details.tool{display:none}
.note{display:flex;align-items:center;gap:.8rem;margin:1.6rem 0;color:var(--muted);font-size:.82rem}
.note::before,.note::after{content:"";flex:1;border-top:1px dashed var(--line)}
.note.has-out{display:block;text-align:center}.note.has-out::before,.note.has-out::after{display:none}
details.sum{border:1px solid var(--line);border-radius:6px;background:var(--soft)}
details.sum>summary{padding:.35rem .7rem;cursor:pointer;font-size:.85rem;color:var(--muted)}
details.sum>.md{padding:.2rem .9rem .8rem;font-size:.9rem}
details.subsession{margin-top:.4rem}
details.subsession>summary{cursor:pointer;color:var(--muted);font-size:.8rem}
.subitems{margin-top:.4rem;padding-left:.7rem;border-left:2px solid var(--line)}
.subitems>.md{font-size:.9rem}
.empty{margin:3rem 0;text-align:center;color:var(--muted)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}
@media (max-width:600px){body{font-size:14px}.wrap{padding:0 12px 3rem}h1{font-size:1.4rem}.bar button{padding:.3rem .55rem}}
@media print{
:root,:root[data-theme="dark"],:root:not([data-theme="light"]){${vars(LIGHT, "!important")};color-scheme:light}
body{font-size:11pt;max-width:none}
.wrap{max-width:none;padding:0}
.bar,.noprint{display:none!important}
header{padding-top:0}
pre{max-height:none!important;overflow:visible!important;white-space:pre-wrap;overflow-wrap:anywhere;font-size:9pt}
.turn{break-inside:avoid-page}
details.tool,details.out,.fence,.tablewrap,img.shot{break-inside:avoid}
details.tool{box-shadow:none}
.td{white-space:normal!important}
.thinking,.show-thinking .thinking{display:none!important}
.turn.only-think,.show-thinking .turn.only-think{display:none!important}
a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em;color:#555;overflow-wrap:anywhere}
.dl.add,.dl.del,.dl.hunk,.dl.fold,.pill,.chip,.turn.you .body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`.trim();

// The script: a filter box, switches, and the print and time helpers. It reads the page's own text
// and only ever writes fixed strings, class names and attributes (never HTML), and it has no
// access to the network (the CSP above forbids it).
export const CLIENT_JS = String.raw`(function () {
  "use strict";
  var doc = document, root = doc.documentElement, body = doc.body;
  root.className = "js";
  var q = doc.getElementById("q");
  var count = doc.getElementById("count");
  var turns = Array.prototype.slice.call(doc.querySelectorAll("#turns > .turn"));
  var cache = new WeakMap();
  var opened = new WeakMap();
  var timer = 0;

  function all(sel, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(sel)); }

  // The lower-cased text of an element, with or without the thinking blocks, computed once.
  function textOf(el, thinking) {
    var c = cache.get(el);
    if (!c) { c = {}; cache.set(el, c); }
    var key = thinking ? "t" : "p";
    if (c[key] === undefined) {
      var out = [], node, walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      while ((node = walker.nextNode())) {
        var parent = node.parentNode;
        if (!thinking && parent && parent.closest && parent.closest(".thinking")) continue;
        out.push(node.nodeValue);
      }
      c[key] = out.join("").toLowerCase();
    }
    return c[key];
  }

  // Show only the turns that contain every word; open the tool calls that hold a match.
  function filter() {
    var terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    var thinking = body.classList.contains("show-thinking");
    var shown = 0;
    turns.forEach(function (turn) {
      var text = textOf(turn, thinking);
      var ok = terms.every(function (w) { return text.indexOf(w) !== -1; });
      turn.hidden = !ok;
      if (ok) shown++;
      all("details", turn).forEach(function (d) {
        if (terms.length && ok) {
          if (!opened.has(d)) opened.set(d, d.open);
          var t = textOf(d, thinking);
          if (terms.some(function (w) { return t.indexOf(w) !== -1; })) d.open = true;
        } else if (opened.has(d)) {
          d.open = opened.get(d);
          opened.delete(d);
        }
      });
    });
    count.textContent = terms.length ? shown + " of " + turns.length + " turns" : "";
  }

  q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(filter, 100); });

  var themes = ["auto", "light", "dark"];
  function setTheme(name) {
    if (name === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", name);
    var b = doc.querySelector('[data-act="theme"]');
    if (b) b.textContent = "Theme: " + name;
  }
  setTheme(root.getAttribute("data-theme") || "auto");

  var bar = doc.querySelector(".bar");
  if (bar) bar.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!b) return;
    var act = b.getAttribute("data-act");
    if (act === "tools") {
      b.setAttribute("aria-pressed", body.classList.toggle("hide-tools") ? "false" : "true");
    } else if (act === "thinking") {
      b.setAttribute("aria-pressed", body.classList.toggle("show-thinking") ? "true" : "false");
      filter();
    } else if (act === "expand") {
      var open = b.getAttribute("data-open") !== "1";
      all("#turns details").forEach(function (d) { d.open = open; });
      b.setAttribute("data-open", open ? "1" : "0");
      b.textContent = open ? "Collapse all" : "Expand all";
    } else if (act === "theme") {
      var cur = root.getAttribute("data-theme") || "auto";
      setTheme(themes[(themes.indexOf(cur) + 1) % themes.length]);
    }
  });

  doc.addEventListener("keydown", function (e) {
    if (e.key === "/" && doc.activeElement !== q && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); q.focus(); q.select();
    } else if (e.key === "Escape" && doc.activeElement === q) {
      q.value = ""; filter(); q.blur();
    }
  });

  // Printing: edits are printed in full, every other tool call as its one line.
  var printed = [];
  window.addEventListener("beforeprint", function () {
    printed = all("details.tool.kind-edit, details.tool.kind-write, details.sum").map(function (d) { var was = d.open; d.open = true; return [d, was]; });
  });
  window.addEventListener("afterprint", function () {
    printed.forEach(function (p) { p[0].open = p[1]; });
    printed = [];
  });
})();`;
