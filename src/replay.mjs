// One call from a session file to a finished export. The command line, the example builder and the
// tests all go through this.
import { loadSession } from "./session.mjs";
import { renderHtml } from "./html.mjs";
import { renderMarkdown } from "./markdown.mjs";

// replayFile(file, options) -> { text, session, display }
//   format     "html" (default) or "md"
//   redact     replace secrets, shorten paths, drop thinking and images
//   tools      false leaves tool calls out;  thinking, images  false leaves those out
//   maxOutput  characters kept of each tool output (default 20 KB, 0 = all)
//   theme      "auto" (default), "light" or "dark" (HTML only)
//   home, env, patterns  see loadSession
export function replayFile(file, options = {}) {
  const { session, display } = loadSession(file, options);
  const tools = options.tools !== false;
  const thinking = options.thinking !== false && !options.redact;
  const view = { tools, thinking, redacted: !!options.redact };
  const text = options.format === "md"
    ? renderMarkdown(session, view)
    : renderHtml(session, { ...view, theme: options.theme || "auto" });
  return { text, session, display };
}
