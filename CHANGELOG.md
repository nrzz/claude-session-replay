# Changelog

All notable changes to Claude session replay are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-04

- `--redact` now replaces the whole value of any tool input field named like a secret (`password`, `token`, `api_key`, `client_secret`, `authorization` ...). Before, the name and value rows the HTML shows for MCP, Skill, Read, Grep and web tools kept such values readable. A key named just `token` and a URL password with no user name are caught too.
- Control codes and text-direction overrides are removed from the header's project, model and version names, and from the titles and snippets that `list` and `search` print.
- README: what `--redact` covers, images over about 768 KB, the print layout, `FORCE_COLOR`, the folder-name rule, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: list and search across sessions, HTML and Markdown exports with diffs, collapsible tool calls, compactions and per-turn tokens, safe against hostile text, `--redact`, `open`; a plugin.

[1.0.1]: https://github.com/nrzz/claude-session-replay/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-session-replay/releases/tag/v1.0.0
