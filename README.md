# Claude session replay

[![test](https://github.com/nrzz/claude-session-replay/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-session-replay/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Find anything you discussed in any past Claude Code session, and turn a session into a single-file HTML replay or a Markdown transcript for docs, demos, code reviews and bug reports. It runs outside Claude Code as one zero-dependency Node command, so it costs no tokens, and it never sends a transcript anywhere.

## What it costs in tokens

None, by design:

| Part | Tokens | |
| --- | --- | --- |
| `claude-replay list`, `search`, `export`, `open` | 0 | A separate Node process. Nothing is sent to the model |
| The skill in Claude's skill list | 0 | It is user-only (`disable-model-invocation`), so Claude Code leaves it out of the list it gives the model. Its description is 47 characters |
| `/replay:replay` | about 100, once | The skill is a one-line command plus one instruction. The command prints one line on standard output (and a line of redaction counts on standard error), and Claude replies with one line. This is an estimate from character counts, not a measurement |
| An export you paste into a conversation | your choice | Nothing reads an export unless you hand it over. `--md --no-tools` makes a long session far smaller first |

## Install

Needs Node 18 or newer. Run it without installing:

```bash
npx -y github:nrzz/claude-session-replay list
```

Or install it once and use the short name:

```bash
npm i -g github:nrzz/claude-session-replay
claude-replay --help
```

As a Claude Code plugin, which adds `/replay:replay` (it exports the session you are in, redacted, to `claude-session-replay.html` in the project folder):

```text
/plugin marketplace add nrzz/claude-session-replay
/plugin install replay@claude-session-replay
```

## Use

Sessions are the ones Claude Code kept under `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` when that is not set. By default a command looks at the sessions whose folder is the current project or inside it. `--all` looks at every project, and `--project <dir>` at another folder. Output has colour on a terminal; `NO_COLOR` turns it off, and `FORCE_COLOR` turns it on even in a pipe (it wins over `NO_COLOR`).

```bash
claude-replay list                          # this project's sessions, newest first
claude-replay list --all --limit 50
claude-replay search stripe webhook         # every word must match
claude-replay search ENOTFOUND --deep --all # also look inside tool output
claude-replay export 7be317ee               # ./claude-session-7be317ee.html
claude-replay export "login redirect" --md --out docs/login-bug.md
claude-replay export 7be317ee --redact --theme dark --out replay.html
claude-replay open 7be317ee                 # export to the temp folder and open it in your browser
```

`list` shows the id (first 8 characters), the last activity, the number of prompts you typed, the size and the title (the name you gave it with `/rename`, else Claude's title, else your first prompt):

```text
$ claude-replay list
Sessions in /home/dev/projects/webapp  (3, newest first)
  ID        LAST ACTIVITY     PROMPTS      SIZE  TITLE
  7be317ee  2026-10-02 14:00        5     77 KB  Fix the login redirect loop
  3f2a9c1d  2026-09-28 15:45        1      1 KB  Stripe webhook events
  c84e0b27  2026-09-25 22:10        1      1 KB  Stale cache after deploy
```

`search` finds sessions where every word appears, in the title, your prompts, Claude's text, or the commands and paths of tool calls. It prints the id, the date of the match, the title and one snippet, with the matches highlighted on a terminal:

```text
$ claude-replay search webhook --all
2 sessions in any project with all of: webhook
3f2a9c1d  2026-09-28  Stripe webhook events  webapp
    you    Which Stripe webhook events should the billing service handle?
5d0a7e19  2026-09-20  Webhook retries  api
    you    Add retry with backoff to the webhook sender
```

Everywhere a session is expected you can give its full id, the first 6 or more characters of it, or some words. Words pick the best matching session when it clearly beats the others (its score is at least 1.5 times the next one's). When it does not, the command lists the candidates and exits with code 1 so you can pick an id. Exit codes: 0 done, 1 for anything you can fix (no match, an ambiguous id, a bad option), 2 for an unexpected failure.

| Option | Applies to | What it does |
| --- | --- | --- |
| `--all` | list, search, export, open | Every project, not only the current one |
| `--project <dir>` | list, search, export, open | Another project folder |
| `--limit <n>` | list (default 20), search (default 10) | How many sessions to show |
| `--deep` | search | Also search tool output and the text of files tools read, wrote or edited |
| `--html`, `--md` | export | The format. HTML is the default; `--out notes.md` also means Markdown |
| `--out <file>` | export | Where to write. Default `./claude-session-<id8>.html` (or `.md`); a folder gets that name inside it. `--out -` writes to standard output |
| `--redact` | export, open | Replace secrets, show paths inside the project as `.` or relative paths (the header still names the project folder), leave out thinking and images, and report counts on standard error |
| `--no-tools` | export, open | Leave out tool calls and their output |
| `--no-thinking`, `--no-images` | export, open | Leave out thinking, or pasted images |
| `--theme dark\|light\|auto` | export, open | HTML colours. `auto` (the default) follows the system |
| `--max-output <KB>` | export, open | How much of each tool output to keep (default 20; `64k`, `1m` also work; `0` keeps everything, including images larger than about 768 KB, which is 1 MiB as base64) |
| `--dry-run` | open | Write the file and print the command that would open it, without running it |

An export prints where it went and how big it is:

```text
$ claude-replay export 7be317ee --out replay.html
Wrote /home/dev/projects/webapp/replay.html (60 KB, 10 turns, 18 tool calls)
```

## What the HTML replay shows

One file with no network use. [docs/example.html](docs/example.html) is a replay of a made-up session that shows most of it; download it and open it in a browser.

- **A header**: title, first and last time (UTC), project folder, branch, models, number of prompts, number of tool calls and total tokens. The total is the sum of the four usage counters Claude Code recorded (input, output, cache writes, cache reads). A request re-reads the cached conversation every time, so it is far larger than the conversation; hover it to see the counters.
- **The conversation as turns**: "You" and "Claude", each with its time (the date too when the day changes). A Claude turn shows its tokens in small text: new input, cached input and output.
- **Claude's text as Markdown**: paragraphs, lists, tables, quotes, inline code and fenced code with a small built-in highlighter. Only `http` and `https` links are clickable.
- **Tool calls as one line each**, which open on a click: an edit as a red and green line diff, a written file as its first 200 lines and how many more there are, a command with its output, searches and fetches with their results. A failed call is marked and its error opens with it. Output over the limit (20 KB by default) is cut in the middle, with a note saying so.
- **Thinking**, hidden until the Thinking switch is used. **Pasted images**, shown inline.
- **Slash commands** as chips, shell commands typed with `!`, interruptions, **compaction** (a divider and the summary it carried) and the steps of **subagents** under the call that started them.
- **A sticky filter box** that shows only the turns containing every word you type and opens the tool calls that hold a match (`/` focuses it, Escape clears it). Switches for tool calls, thinking, expanding everything, and the theme.
- **Light and dark** colours from the system, or forced with `--theme`. **Print styles**: no toolbar, wrapped code, light colours, edits, written files and the compaction summary printed in full, and other tool calls as one line.

`--md` writes the same conversation as Markdown: who said what, one line per tool call with paths relative to the project, and collapsible `<details>` blocks for diffs and output.

## Privacy and redaction

- Reading and exporting happen on your machine. The program makes no network requests. The HTML page has a Content-Security-Policy that forbids loading anything (`default-src 'none'`; inline style and script, and `data:` images only), so the page loads and fetches nothing.
- Your home folder is shown as `~` in every export. Control codes, colour sequences and text-direction overrides are removed from everything: the conversation, the header's names, and the titles and snippets that `list` and `search` print.
- Without `--redact` the export is the session as it happened. If it still contains something that looks like a secret, the command warns on standard error and tells you to use `--redact`.
- With `--redact`, secrets are replaced by `[REDACTED:kind]`: Anthropic, OpenAI, Stripe, GitHub, GitLab, Slack, Google, npm, Hugging Face and SendGrid keys, AWS access keys and secret keys, JWTs, bearer tokens, private keys, Slack and Teams webhooks, passwords in URLs and connection strings, `.env` style `*_SECRET=` and `*_TOKEN=` lines, quoted `password`, `secret`, `api_key`, `token` (and `access_token`, `auth_token`, `refresh_token`) values, and the whole value of any tool input field named like a secret (`password`, `db_password`, `token`, `api_key`, `client_secret`, `authorization` ...). The rules are the ones claude-code-team-sync uses. Paths inside the project become `.` or relative paths (the header still names the project folder), thinking and images are left out, and the counts go to standard error. Secrets are replaced before a long output is cut, so a cut cannot leave half of one behind.
- Redaction is best effort. Read an export before you share it.
- A transcript is arbitrary text, including text written by web pages and files Claude read. Every piece of it that goes into the HTML is escaped by a template function that cannot be bypassed by accident, no transcript data goes into the script, the script writes only fixed text and class names (never HTML), and the Markdown export neutralizes raw HTML outside code. The tests try `</script>`, `</details>`, `<img onerror>`, `javascript:` links and more in every place text can appear.

## How it works

- A session is a file, `projects/<folder>/<sessionId>.jsonl`, one JSON record per line. The folder name is the working directory with every character other than an ASCII letter or digit replaced by `-` (a name over 200 characters is cut and given a hash suffix). Subagents have their own files under `<sessionId>/subagents/`, and are not sessions of their own.
- `list` reads the end of each file to find its last activity, sorts, and reads in full only the sessions it shows. `search` streams every file line by line (no index, nothing written to disk) and only parses a line as JSON when a text test says it could hold one of the words, so a few hundred sessions take a fraction of a second.
- A word in the title counts most, then in a prompt, in Claude's text, in a tool call, and (with `--deep`) in output. Words found together in one message add a bonus, and equal scores go to the more recent session.
- An export reads the file once into a model of the conversation: your prompts, Claude's text, thinking and tool calls with their results, compactions, and subagent steps. Tokens come from the usage of each assistant message, counted once even though Claude Code writes one record per content block.
- Both exporters work from that model. Everything in it has already been through the redaction step, and every tool output already cut to the limit.
- Paths in the one-line summaries are relative to the project. Times in files are UTC; the terminal shows local time.
- Records are read in the order they were written. A conversation that was rewound shows both the abandoned turns and the kept ones.
- Claude Code stores very large tool outputs in separate `tool-results` files and keeps only a preview in the transcript. The export shows that preview; the files are not read.
- `open` writes the replay into a new `claude-replay-XXXXXX` folder inside your temp folder (a fresh folder each time, so a shared temp folder cannot be used to redirect the write) and starts your default browser: `start` on Windows, `open` on macOS, `xdg-open` on Linux.

## What was verified, and how

Checked on 2026-10-04 on Windows 11 with Node 24, against synthetic transcripts in the format of Claude Code 2.1.286. No real transcript was read: the build was not allowed to touch `~/.claude/projects`, and every test uses a throwaway Claude folder.

- **306 automated tests** (`npm test`, about 6 seconds): the transcript reader and the id and title rules, the search and its ranking, id and word resolution, the line diff, Markdown rendering and highlighting, redaction, both exporters, the command line, the plugin and repository files, and a fuzz test that feeds 120 randomly damaged transcripts through the export, listing and search code.
- **Hostile text.** Seven payloads (`<script>`, `</script><script>`, `</details>`, `"><img onerror>`, `'><svg onload>`, `javascript:`, `<iframe>`) are put into prompts, answers, thinking, tool inputs, tool output, titles and file names, in plain and redacted exports. For each, the page must be well formed, have exactly one script (ours), have no event-handler attribute and no link other than `http` or `https`, and have the same tags as the same session with harmless text.
- **Speed.** A search over 300 synthetic sessions of about 40 records each takes about 0.3 seconds, with `--deep` as well; the whole `claude-replay search` command, Node's start included, takes under a second. A 40 MB session is streamed, not loaded.
- **The example page** was opened once in a browser pane: the filter, the thinking and expand switches, the theme switch, a phone width of 375 pixels with no horizontal scroll, and no console errors.
- **The plugin**: `claude plugin validate .claude-plugin/plugin.json` and `claude plugin validate .` both pass with Claude Code 2.1.286 and 2.1.289, and on 2026-10-04 the plugin installed from GitHub with `/plugin marketplace add nrzz/claude-session-replay` and `/plugin install replay@claude-session-replay`.

Not verified yet: exports of real sessions. The linking of a subagent's transcript to its call follows the result's `agentId` and falls back to matching the first prompt, which is an assumption about the format. CI runs every test on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18, all green. The `open` command was not run, so a browser was never started by a test; the command it would run for each system is tested. The print layout was not looked at in a print preview, and `/replay:replay` was not run inside a live Claude Code session.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-replay.mjs` | The command |
| `src/cli.mjs` | The commands and options |
| `src/claude.mjs` | Where sessions are, what a record is, listing and finding sessions |
| `src/session.mjs` | Reads a session into the model both exporters use |
| `src/search.mjs` | Streaming search and ranking |
| `src/html.mjs`, `src/assets.mjs`, `src/safe.mjs` | The HTML page, its style sheet and script, and the escaping templates |
| `src/markdown-lite.mjs`, `src/diff.mjs` | Markdown and syntax highlighting for the page, and the line diff |
| `src/markdown.mjs` | The Markdown export |
| `src/redact.mjs` | Secret and path redaction |
| `src/replay.mjs`, `src/util.mjs`, `src/version.mjs` | One call from a file to an export, shared helpers, the version |
| `skills/replay/SKILL.md` | The user-only skill behind `/replay:replay` |
| `.claude-plugin/` | The plugin and marketplace manifests |
| `test/` | The tests (`npm test`), and the synthetic transcript writer they share |
| `scripts/build-example.mjs` | Builds `docs/example.html` from a made-up session (`npm run build:example`) |
| `docs/example.html` | The example replay |

Related: [claude-code-handover](https://github.com/nrzz/claude-code-handover) keeps your own sessions short, and [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) shares sessions with a team. A replay is what you attach when a session needs to be seen by someone who was not in it.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-session-replay/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-session-replay/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT
