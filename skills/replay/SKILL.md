---
name: replay
description: Export this session as a shareable HTML replay.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-replay.mjs" export ${CLAUDE_SESSION_ID} --redact --out "${CLAUDE_PROJECT_DIR}/claude-session-replay.html"`

Reply in one line with the path written.
