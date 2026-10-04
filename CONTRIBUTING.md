# Contributing to Claude session replay

Thanks for helping. Claude session replay is a CLI and a Claude Code plugin with one user-only skill, part of the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit). The bar for a change is the bar the code already meets: it works on Windows, macOS and Linux, it is tested, and it never wastes anyone's tokens.

## Start here

- **Good first issues:** [the issues labelled good first issue](https://github.com/nrzz/claude-session-replay/issues?q=is%3Aopen+label%3A%22good+first+issue%22), and the ideas in [ROADMAP.md](ROADMAP.md).
- **Questions and ideas:** [Discussions](https://github.com/nrzz/claude-session-replay/discussions).
- **Bugs:** [open an issue](https://github.com/nrzz/claude-session-replay/issues/new/choose) with the Claude Code version (`claude --version`), your OS, `node --version`, and the exact command and output.

## Set up

There is nothing to install: the project has no dependencies.

```bash
git clone https://github.com/nrzz/claude-session-replay
cd claude-session-replay
npm test
```

- The tests generate synthetic transcripts (`test/synthetic.mjs`); `node scripts/build-example.mjs` rebuilds `docs/example.html` from one.
- `node bin/claude-replay.mjs export <id> --out x.html` on a throwaway config.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/session.mjs`, `src/search.mjs` | reading transcripts and searching them |
| `src/html.mjs`, `src/assets.mjs` | the HTML replay, its style, script and Content-Security-Policy |
| `src/markdown.mjs`, `src/redact.mjs`, `src/diff.mjs` | Markdown export, redaction, line diffs |
| `test/` | hostile-text tests, a fuzz test, search speed |

## House rules

1. **No dependencies.** Node built-ins only, Node 18 or newer, ES modules (`.mjs`). A pull request that adds a package to `dependencies` will not be merged.
2. **Every change comes with a test**, and `npm test` passes. CI runs the suite on Windows, macOS and Linux with Node 20, 22 and 24, and on Linux with Node 18; a change that only works on one of them is not done.
3. **Token cost is a feature.** It runs outside Claude; the optional skill is user-only and replies in one line. If your change puts anything new in front of Claude, say how many tokens in the pull request and update the README's "What it costs in tokens".
4. **Never touch real user data in tests.** Use a temporary folder and point `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` at it. Tests never read `~/.claude/projects`; build synthetic transcripts instead. Build any fake secret from pieces (`"gh" + "p_" + ...`) so secret scanners do not flag the source.
5. **Settings files are the user's.** If your change writes one: change only your own keys or hook entries, leave a file that is not valid JSON alone, and back up a user-level file before writing it (a project's file is in git).
6. **Keep the README honest.** Its "What was verified, and how" section says what was checked and what was not. If your change affects either, update it in the same pull request.

## Pull requests

- One logical change per pull request, with its test. Commit messages in the imperative mood ("Add a rule for gem push").
- Fill in the pull request template; CI must be green on every job.
- Signed commits are welcome but not required.
- Plain, specific writing in docs, messages and comments.

## Releases (maintainers)

Bump the version in `package.json`, `.claude-plugin/plugin.json` and `src/version.mjs` (`npm test` fails until every copy agrees), run `npm run build:example` (the example page shows the version), add a section to [CHANGELOG.md](CHANGELOG.md), tag `vX.Y.Z` and publish a GitHub release with the changelog section as its notes.

## Conduct and security

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
