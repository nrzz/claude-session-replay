// HTML that cannot be built wrongly: everything put into a template is escaped unless it is
// itself the result of another template (or was marked with raw(), which only our own markup
// uses). Transcript text goes into the page only through this, so there is no way to forget to
// escape it.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export class Safe {
  constructor(html) { this.html = html; }
  toString() { return this.html; }
}
// Trusted markup written in this repository. Never pass transcript text to it.
export const raw = (html) => new Safe(html);

function part(v) {
  if (v instanceof Safe) return v.html;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false || v === true) return "";
  return esc(v);
}

// h`<p class="x">${text}</p>`: the literal parts are markup, the ${values} are escaped text.
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const join = (items, sep = "") => new Safe(items.map(part).join(sep));
