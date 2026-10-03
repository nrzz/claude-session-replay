#!/usr/bin/env node
// claude-replay: search past Claude Code sessions and export one as an HTML replay or Markdown.
// All the work is in src/cli.mjs; run `claude-replay --help` for the commands.
import { main } from "../src/cli.mjs";

// `claude-replay export x --out - | head` closes the pipe early: that is not an error.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
