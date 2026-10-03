import test from "node:test";
import assert from "node:assert/strict";
import { countOf, parseHtml } from "./helpers.mjs";
import { codeBlock, highlight, inline, languageOf, markdownToHtml, plainToHtml, readFence } from "../src/markdown-lite.mjs";

const md = (s) => markdownToHtml(s).html;

test("paragraphs are separated by blank lines, and a single newline is a line break", () => {
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
  assert.equal(md(""), "");
  assert.equal(md("   \n\n  "), "");
});

test("inline: code, bold, italic, strike", () => {
  assert.equal(md("a `code` b"), "<p>a <code>code</code> b</p>");
  assert.equal(md("**bold** and __bold__"), "<p><strong>bold</strong> and <strong>bold</strong></p>");
  assert.equal(md("*it* and _it_"), "<p><em>it</em> and <em>it</em></p>");
  assert.equal(md("~~gone~~"), "<p><del>gone</del></p>");
  assert.equal(md("**bold with *em* inside**"), "<p><strong>bold with <em>em</em> inside</strong></p>");
});

test("inline: markers that are not emphasis stay as typed", () => {
  assert.equal(md("snake_case_name stays"), "<p>snake_case_name stays</p>");
  assert.equal(md("a * b * c"), "<p>a * b * c</p>");
  assert.equal(md("5 * 3"), "<p>5 * 3</p>");
  assert.equal(md("unclosed **bold"), "<p>unclosed **bold</p>");
  assert.equal(md("~tilde~"), "<p>~tilde~</p>");
});

test("inline code protects what is inside it, and double backticks can hold a backtick", () => {
  assert.equal(md("`<b>*x*</b>`"), "<p><code>&lt;b&gt;*x*&lt;/b&gt;</code></p>");
  assert.equal(md("`` a`b ``"), "<p><code>a`b</code></p>");
  assert.equal(md("an `unclosed span"), "<p>an `unclosed span</p>");
});

test("text is HTML-escaped", () => {
  assert.equal(md("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(md('"><img src=x onerror=alert(1)>'), "<p>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</p>");
  assert.equal(md("a & b < c"), "<p>a &amp; b &lt; c</p>");
});

test("links: only http and https become links, with rel noopener noreferrer", () => {
  const html = md("see [the docs](https://example.com/a?x=1&y=2) now");
  assert.equal(html, '<p>see <a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer" target="_blank">the docs</a> now</p>');
  assert.match(md("[plain](http://example.com)"), /<a href="http:\/\/example\.com" rel="noopener noreferrer"/);
});

test("links: javascript:, data: and file: addresses are shown as text and cannot be clicked", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:x", "//evil.example/x"]) {
    const html = md(`[click me](${url})`);
    assert.ok(!html.includes("<a "), `${url} became a link: ${html}`);
    assert.ok(!/href=/.test(html), url);
    assert.ok(html.includes("click me"));
  }
  assert.equal(md("[a](javascript:alert(1))"), '<p>a <span class="dim">(javascript:alert(1))</span></p>');
});

test("links: a relative path shows its label only", () => {
  assert.equal(md("[auth.ts](src/auth.ts)"), "<p>auth.ts</p>");
});

test("links: a title is allowed, and parentheses inside an address are kept", () => {
  assert.match(md('[x](https://example.com/a "the title")'), /href="https:\/\/example\.com\/a"/);
  assert.match(md("[x](https://en.wikipedia.org/wiki/A_(b))"), /href="https:\/\/en\.wikipedia\.org\/wiki\/A_\(b\)"/);
});

test("a web address in prose becomes a link without the punctuation after it", () => {
  assert.equal(md("go to https://example.com/x, then (https://example.org)."), '<p>go to <a href="https://example.com/x" rel="noopener noreferrer" target="_blank">https://example.com/x</a>, then (<a href="https://example.org" rel="noopener noreferrer" target="_blank">https://example.org</a>).</p>');
  assert.ok(!md("xhttps://example.com").includes("<a "), "only when it starts a word");
  assert.ok(!md("ftp://example.com").includes("<a "));
});

test("an address in angle brackets is a link, and a link label never holds another link", () => {
  assert.match(md("see <https://example.com/a> now"), /see &lt;<a href="https:\/\/example\.com\/a" rel="noopener noreferrer" target="_blank">https:\/\/example\.com\/a<\/a>&gt; now/);
  for (const text of ["[https://a.example](https://b.example)", "[see [inner](https://c.example) here](https://d.example)", "[**https://e.example**](https://f.example)"]) {
    const html = md(text);
    assert.equal(countOf(html, "<a "), 1, `${text} -> ${html}`);
    assert.deepEqual(parseHtml(html).errors, []);
  }
});

test("a quote in an address cannot break out of the href attribute", () => {
  const html = md('see https://example.com/"onmouseover="alert(1)');
  const { tags, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  for (const t of tags) assert.ok(!Object.keys(t.attrs).some((k) => k.startsWith("on")), JSON.stringify(t));
});

test("headings start at h3, so the page title stays the only h1", () => {
  assert.equal(md("# A\n## B\n### C\n#### D\n###### E"), "<h3>A</h3><h4>B</h4><h5>C</h5><h6>D</h6><h6>E</h6>");
  assert.equal(md("#nospace"), "<p>#nospace</p>");
  assert.equal(md("## Closed ##"), "<h4>Closed</h4>");
});

test("lists: bullets, numbers, nesting, a start number, and tick boxes", () => {
  assert.equal(md("- a\n- b\n  - c\n- d"), "<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>");
  assert.equal(md("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(md("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md("- [ ] todo\n- [x] done"), "<ul><li>☐ todo</li><li>☑ done</li></ul>");
  assert.equal(md("* star\n+ plus"), "<ul><li>star</li><li>plus</li></ul>");
});

test("lists: a list can follow a paragraph directly, and a loose list keeps paragraphs", () => {
  assert.equal(md("Changes:\n- a\n- b"), "<p>Changes:</p><ul><li>a</li><li>b</li></ul>");
  assert.equal(md("- a\n\n  more\n\n- b"), "<ul><li><p>a</p><p>more</p></li><li><p>b</p></li></ul>");
});

test("lists: an empty item does not make the list loose", () => {
  assert.equal(md("- \n- x"), "<ul><li></li><li>x</li></ul>");
});

test("lists: a code block inside an item stays inside it", () => {
  const html = md("1. run:\n   ```sh\n   npm test\n   ```\n2. done");
  assert.match(html, /<li>run:<div class="fence">.*npm test.*<\/div><\/li><li>done<\/li>/);
});

test("block quotes nest", () => {
  assert.equal(md("> a\n> b\n>\n> > c"), "<blockquote><p>a<br>b</p><blockquote><p>c</p></blockquote></blockquote>");
});

test("a very deep quote does not overflow the stack", () => {
  assert.doesNotThrow(() => md(`${">".repeat(5000)} deep`));
  assert.doesNotThrow(() => md(Array.from({ length: 3000 }, (_, i) => `${" ".repeat((i % 30) * 2)}- item`).join("\n")));
});

test("rules", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
  assert.equal(md("***"), "<hr>");
  assert.equal(md("- - -"), "<hr>");
});

test("tables: header, alignment, escaped pipes, inline markup in cells", () => {
  const html = md("| a | b |\n|---|--:|\n| **1** | x \\| y |\n| 2 | `c` |");
  assert.equal(html, '<div class="tablewrap"><table><thead><tr><th>a</th><th class="right">b</th></tr></thead><tbody><tr><td><strong>1</strong></td><td class="right">x | y</td></tr><tr><td>2</td><td class="right"><code>c</code></td></tr></tbody></table></div>');
  assert.equal(md("not | a table\nreally"), "<p>not | a table<br>really</p>");
});

test("fenced code: the language is a label, the code is escaped and highlighted", () => {
  const html = md("```ts\nconst a = '<b>'; // note\n```");
  assert.match(html, /<span class="lang">ts<\/span>/);
  assert.match(html, /<span class="k">const<\/span> a = <span class="s">&#39;&lt;b&gt;&#39;<\/span>; <span class="c">\/\/ note<\/span>/);
});

test("fenced code: tildes, an unclosed fence, backticks inside a longer fence", () => {
  assert.match(md("~~~\nplain ``` inside\n~~~"), /<pre class="code">plain ``` inside<\/pre>/);
  assert.match(md("```py\ndef f():\n    return 1"), /def<\/span> f\(\):\n    <span class="k">return/);
  assert.match(md("````\n```\nx\n```\n````"), /<pre class="code">```\nx\n```<\/pre>/);
});

test("fenced code is not interpreted as Markdown or HTML", () => {
  const html = md("```\n# not a heading\n- not a list\n</pre><script>alert(1)</script>\n```");
  assert.ok(!html.includes("<h3>") && !html.includes("<li>") && !html.includes("<script>"));
  assert.ok(html.includes("&lt;/pre&gt;&lt;script&gt;"));
});

test("readFence finds the end of a block and strips the indent", () => {
  const lines = ["  ```js", "  a", "   b", "  ```", "after"];
  assert.deepEqual(readFence(lines, 0), { end: 4, lang: "js", code: "a\n b" });
  assert.equal(readFence(["no fence"], 0), null);
});

test("a diff fence colours added and removed lines", () => {
  const html = md("```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n```");
  for (const cls of ["meta", "hunk", "del", "add", "ctx"]) assert.ok(html.includes(`class="dl ${cls}"`), cls);
});

test("highlighting: keywords, strings, comments and numbers in several languages", () => {
  assert.equal(highlight("if (x) return 0x1F;", "js").html, '<span class="k">if</span> (x) <span class="k">return</span> <span class="n">0x1F</span>;');
  assert.match(highlight("def f(): # hi\n  return None", "python").html, /<span class="k">def<\/span> f\(\): <span class="c"># hi<\/span>\n {2}<span class="k">return<\/span> <span class="k">None<\/span>/);
  assert.match(highlight('echo "hi" # c', "bash").html, /echo <span class="s">&quot;hi&quot;<\/span> <span class="c"># c<\/span>/);
  assert.match(highlight("select * from t -- c", "sql").html, /<span class="k">select<\/span> \* <span class="k">from<\/span> t <span class="c">-- c<\/span>/);
  assert.match(highlight('{"a": [1, true, null]}', "json").html, /<span class="s">&quot;a&quot;<\/span>: \[<span class="n">1<\/span>, <span class="k">true<\/span>, <span class="k">null<\/span>\]/);
  assert.match(highlight("fn main() { let x = 1; }", "rust").html, /<span class="k">fn<\/span> main\(\) \{ <span class="k">let<\/span>/);
  assert.match(highlight("/* a */ int x;", "c").html, /<span class="c">\/\* a \*\/<\/span> <span class="k">int<\/span>/);
});

test("highlighting: an unknown or missing language is just escaped text", () => {
  assert.equal(highlight("<b>x</b> if", "").html, "&lt;b&gt;x&lt;/b&gt; if");
  assert.equal(highlight("<b>x</b>", "brainfuck").html, "&lt;b&gt;x&lt;/b&gt;");
});

test("highlighting: unterminated strings and comments cannot swallow markup, and big code is left plain", () => {
  assert.match(highlight('const s = "never closed\nnext', "js").html, /<span class="s">&quot;never closed<\/span>\nnext/);
  assert.match(highlight("/* never closed <b>", "js").html, /<span class="c">\/\* never closed &lt;b&gt;<\/span>/);
  const big = "x ".repeat(150000);
  assert.ok(!highlight(big, "js").html.includes("<span"));
});

test("languageOf maps fence labels and file extensions", () => {
  assert.equal(languageOf("TypeScript"), "js");
  assert.equal(languageOf("src/app.tsx"), "js");
  assert.equal(languageOf("script.ps1"), "ps");
  assert.equal(languageOf("README.md"), "");
  assert.equal(languageOf(""), "");
});

test("codeBlock shows a clean language label only", () => {
  assert.match(codeBlock("x", "js").html, /<span class="lang">js<\/span>/);
  assert.ok(!codeBlock("x", '"><b>').html.includes("lang"), "an odd label is dropped");
});

test("plain text keeps its spacing, shows fenced code as code, and links web addresses", () => {
  const html = plainToHtml("hello  <b>x</b>\n  indented\n```sh\nls <dir>\n```\nsee https://example.com/a.").html;
  assert.equal(html, '<div class="plain">hello  &lt;b&gt;x&lt;/b&gt;\n  indented</div><div class="fence"><span class="lang">sh</span><pre class="code">ls &lt;dir&gt;</pre></div><div class="plain">see <a href="https://example.com/a" rel="noopener noreferrer" target="_blank">https://example.com/a</a>.</div>');
  assert.equal(plainToHtml("**not bold** _x_ [a](http://b)").html, '<div class="plain">**not bold** _x_ [a](<a href="http://b" rel="noopener noreferrer" target="_blank">http://b</a>)</div>');
});

test("inline() on its own returns safe HTML for one paragraph", () => {
  assert.equal(inline("a <b> `c`").html, "a &lt;b&gt; <code>c</code>");
});

test("pathological input finishes quickly", () => {
  const cases = {
    stars: "*a ".repeat(40000), brackets: "[".repeat(40000), ticks: "`".repeat(40000), bullets: "- ".repeat(20000),
    pipes: "| a ".repeat(20000), lines: "a\n".repeat(100000), emphasis: "**".repeat(40000), underscores: "_a".repeat(40000),
    parens: `${"(".repeat(40000)}https://x.y/${")".repeat(40000)}`, links: "[a](b ".repeat(20000), words: "word ".repeat(200000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = Date.now();
    markdownToHtml(text);
    assert.ok(Date.now() - t0 < 5000, `${name} took ${Date.now() - t0} ms`);
  }
  for (const [name, text, lang] of [["quotes", '"'.repeat(100000), "js"], ["comments", "/*".repeat(50000), "js"], ["ticks", "`".repeat(100000), "js"], ["apostrophes", "'".repeat(100000), "py"]]) {
    const t0 = Date.now();
    highlight(text, lang);
    assert.ok(Date.now() - t0 < 5000, `${name} took ${Date.now() - t0} ms`);
  }
});

test("random Markdown-looking text always produces balanced HTML with no event handlers or scripts", () => {
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const bits = ["<", ">", '"', "'", "&", "`", "```", "~~~", "*", "**", "_", "[", "](", ")", "[x](", "http://", "https://a.b/", "javascript:", "\n", "\n\n", "- ", "1. ", "> ", "# ", "| ", "|---|", "<script>", "</script>", "<img src=x onerror=alert(1)>", "word", " ", "\\", "{{", "$"];
  for (let i = 0; i < 400; i++) {
    const text = Array.from({ length: 5 + Math.floor(rnd() * 60) }, () => bits[Math.floor(rnd() * bits.length)]).join("");
    for (const html of [md(text), plainToHtml(text).html]) {
      const { tags, errors } = parseHtml(html);
      assert.deepEqual(errors, [], `unbalanced for ${JSON.stringify(text)}: ${html}`);
      for (const t of tags) {
        assert.ok(!["script", "img", "iframe", "svg", "style", "object", "embed", "link", "meta", "form"].includes(t.name), `${t.name} from ${JSON.stringify(text)}`);
        for (const [k, v] of Object.entries(t.attrs)) {
          assert.ok(!k.startsWith("on"), `${k} from ${JSON.stringify(text)}`);
          if (k === "href") assert.match(v, /^https?:\/\//);
        }
      }
    }
  }
});
