// What may leave the machine. Every string that goes into an export passes through `display`:
//   always        control sequences removed, the home folder shown as ~
//   with --redact secrets replaced by [REDACTED:kind], the project folder shown as . or a relative
//                 path, the Claude projects folder name shown as <project>
// The secret rules are the ones claude-code-team-sync uses for shared sessions. Redaction is best
// effort: it catches the common key, token and password shapes, not every secret.
import path from "node:path";
import { cleanText, cmp, escapeRegExp } from "./util.mjs";
import { isInside } from "./claude.mjs";

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

// Whole-match rules: the match is replaced.
export const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g],
  ["teams-webhook", /https:\/\/[a-z0-9-]+\.webhook\.office\.com\/[^\s"'<>`]+/gi],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["google-oauth-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];
// Label-and-value rules: group 1 (the label) is kept, group 2 (the value) is replaced.
export const VALUE_RULES = [
  ["bearer-token", /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g],
  ["url-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]*:)([^\s@/"'`]+)(?=@)/gi],
  ["aws-secret", /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi],
  ["azure-key", /((?:AccountKey|SharedAccessKey)\s*=\s*)([A-Za-z0-9+/=]{20,})/gi],
  ["connection-password", /((?:^|[;"'])\s*(?:Password|Pwd)=)([^;'"\s]{2,})/gim],
  ["env-secret", /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?)([^\s"'#]{4,})/gm],
  ["assigned-secret", /(\b(?:password|passwd|secret|client_secret|api_?key|access_?token|auth_?token|refresh_?token|token)["']?\s*[:=]\s*["'])([^"'\s]{6,})(?=["'])/gi],
];
// A field whose name says it holds a secret: its whole value is replaced (tool inputs are shown as
// name and value, so the label-and-value rules above never see the two together).
export const SECRET_KEY = /^(?:.*[_-])?(?:password|passwd|pwd|secret|client_secret|secret_?key|token|api_?key|apikey|private_?key|access_?key|authorization|credentials?)$/i;
// Values that are obviously not secrets: placeholders, template references, type names.
export const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|changeme|change_me|password|secret|null|none|undefined|example[\w-]*|dummy[\w-]*|test\w{0,4}|your[\w-]*|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|%[A-Z_]+%|\[REDACTED[^\]]*\]?)$/i;

const bump = (counts, key, n = 1) => { counts[key] = (counts[key] || 0) + n; };

// Returns redact(text, counts): the text with secrets replaced, and counts[kind] raised for each.
export function makeRedactor(extraPatterns = []) {
  const extra = [];
  for (const p of extraPatterns) {
    try { extra.push(["custom", new RegExp(p, "g")]); } catch { /* an invalid pattern is skipped */ }
  }
  const rules = [...SECRET_RULES, ...extra];
  return function redact(s, counts = {}) {
    if (typeof s !== "string" || s.length < 8) return s;
    let out = s;
    for (const [kind, re] of rules) out = out.replace(re, () => { bump(counts, kind); return `[REDACTED:${kind}]`; });
    for (const [kind, re] of VALUE_RULES) {
      out = out.replace(re, (m, keep, value) => {
        if (PLACEHOLDER_VALUE.test(value)) return m;
        bump(counts, kind);
        return `${keep}[REDACTED:${kind}]`;
      });
    }
    return out;
  };
}

// Which secrets a finished export still contains: { kind: count }. HTML is unescaped first so that
// quoted values are seen as they were typed. Used to warn when an export was not redacted.
export function findSecrets(text) {
  const counts = {};
  const plain = String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  makeRedactor()(plain, counts);
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

// Every way a folder shows up in a transcript: both slashes, and for a Windows drive also the Git
// Bash, WSL and Cygwin spellings (C:\Users\me is /c/Users/me, /mnt/c/Users/me, /cygdrive/c/Users/me).
function pathVariants(p) {
  const base = String(p).replace(/[\\/]+$/, "");
  const set = new Set([base, base.replace(/\\/g, "/"), base.replace(/\//g, "\\")]);
  const drive = /^([a-zA-Z]):[\\/](.+)$/.exec(base);
  if (drive) {
    const rest = drive[2].replace(/\\/g, "/");
    const d = drive[1].toLowerCase();
    for (const prefix of [`/${d}/`, `/mnt/${d}/`, `/cygdrive/${d}/`]) set.add(prefix + rest);
  }
  return [...set].filter((v) => v.length > 2);
}

// After a known folder: the rest of the path, up to a space, quote, colon or other character a
// path cannot hold. Only this part has its backslashes turned into forward slashes, so a regex
// or an escape sequence elsewhere in the text survives.
const TAIL = "((?:[\\\\/][^\\\\/\\s\"'`<>|*?:]+)*)";

// Returns map(text): the project folder becomes "." or a relative path, the folder holding the
// session's tool results "<tool-results>", the home folder "~", and the Claude projects folder
// name for this project "<project>". Longest folder first, a sibling such as webapp-old is not the
// project, Windows paths match in any letter case, macOS and Linux paths match exactly.
// counts.paths is raised for every path rewritten.
export function pathMapper({ toolResults, root, roots = [], slug, home }, counts = {}) {
  const winish = [toolResults, root, ...roots, home].some((p) => /^[a-zA-Z]:|\\/.test(String(p || "")));
  const norm = (s) => (winish ? s.toLowerCase() : s);
  const table = new Map(); // normalized spelling -> what it stands for
  const spellings = [];
  const add = (p, kind) => {
    if (!p) return;
    for (const v of pathVariants(p)) if (!table.has(norm(v))) { table.set(norm(v), kind); spellings.push(v); }
  };
  add(toolResults, "tool");
  for (const r of [root, ...roots]) add(r, "root");
  add(home, "home");
  spellings.sort((a, b) => b.length - a.length);
  const re = spellings.length
    ? new RegExp(`(?:${spellings.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])${TAIL}`, winish ? "gi" : "g")
    : null;
  const slugRe = slug && slug.length > 3 ? new RegExp(`${escapeRegExp(slug)}(?![A-Za-z0-9_-])`, "g") : null;
  return (s) => {
    let out = s;
    if (re) {
      out = out.replace(re, (m, tail) => {
        const kind = table.get(norm(m.slice(0, m.length - tail.length)));
        const rest = tail.replace(/\\/g, "/");
        bump(counts, "paths");
        if (kind === "root") return rest ? rest.slice(1) : ".";
        if (kind === "tool") return `<tool-results>${rest}`;
        return `~${rest}`;
      });
    }
    if (slugRe) out = out.replace(slugRe, () => { bump(counts, "paths"); return "<project>"; });
    return out;
  };
}

// A path as a short line in the project: relative to its root when inside it, with forward slashes.
export function relPath(p, root) {
  const s = String(p ?? "");
  if (!s) return ".";
  if (root && isInside(root, s)) {
    const win = /^[a-zA-Z]:[\\/]|^\\\\/.test(root) || /^[a-zA-Z]:[\\/]|^\\\\/.test(s);
    const api = win ? path.win32 : path.posix;
    const rel = api.relative(api.normalize(root), api.normalize(s)).replace(/\\/g, "/");
    return rel || ".";
  }
  return /^~[\\/]/.test(s) ? s.replace(/\\/g, "/") : s;
}

// ---------------------------------------------------------------------------------------------
// The one function the exporters use
// ---------------------------------------------------------------------------------------------

// makeDisplay({ redact, root, home, slug, toolResults }) -> { text(s), deep(value), counts }
//   text(s)     one string, cleaned, with secrets and paths dealt with
//   deep(value) the same for every string inside an object or array (a copy)
//   counts      { secrets: { kind: n }, paths, thinking, images }, filled in as strings pass through
export function makeDisplay({ redact = false, root = "", home = "", slug = "", toolResults = "", patterns = [] } = {}) {
  const counts = { secrets: {}, paths: 0, thinking: 0, images: 0 };
  const redactor = redact ? makeRedactor(patterns) : null;
  const toPaths = pathMapper(redact ? { toolResults, root, slug, home } : { home }, counts);
  const text = (s) => {
    if (typeof s !== "string" || !s) return s;
    let out = cleanText(s);
    if (redactor) out = redactor(out, counts.secrets);
    return toPaths(out);
  };
  const deep = (v, key = "") => {
    if (typeof v === "string") {
      if (redactor && key && SECRET_KEY.test(key) && v.trim().length >= 4 && !PLACEHOLDER_VALUE.test(v.trim())) {
        bump(counts.secrets, "named-secret");
        return "[REDACTED:named-secret]";
      }
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x) => deep(x, key));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = deep(x, k);
      return o;
    }
    return v;
  };
  return { text, deep, counts, redact };
}

// "replaced 3 secrets (github-token 2, env-secret 1); dropped 2 thinking blocks and 1 image; rewrote 18 paths"
export function describeCounts(counts) {
  const secretKinds = Object.entries(counts.secrets).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const secrets = secretKinds.reduce((n, [, c]) => n + c, 0);
  const parts = [secrets
    ? `replaced ${secrets} secret${secrets === 1 ? "" : "s"} (${secretKinds.map(([k, c]) => `${k} ${c}`).join(", ")})`
    : "no secrets found"];
  const dropped = [];
  if (counts.thinking) dropped.push(`${counts.thinking} thinking block${counts.thinking === 1 ? "" : "s"}`);
  if (counts.images) dropped.push(`${counts.images} image${counts.images === 1 ? "" : "s"}`);
  if (dropped.length) parts.push(`dropped ${dropped.join(" and ")}`);
  if (counts.paths) parts.push(`rewrote ${counts.paths} path${counts.paths === 1 ? "" : "s"}`);
  return parts.join("; ");
}
