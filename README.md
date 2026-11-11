# model-router

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that sends simple, read-only turns (status questions, summaries, lookups) to a cheaper model and keeps everything else on your main model. In those cheap turns it refuses any tool call that is not a plain read, so a cheap model cannot change local state through its tools. This is a guard, not a sandbox: see the Safety model for what it does not stop.

Not affiliated with Anthropic.

## Why

Many turns in a long session are "what is the status of X?" or "summarize this file". A smaller model answers those well and costs less. Anything that writes, runs commands that change state, or is ambiguous should stay on the model you chose. This mod does the split with explicit, readable rules instead of a classifier.

## Install

```sh
claude plugin marketplace add Zackq-labs/model-router
claude plugin install model-router@zackq-labs --scope user
```

The default cheap model id is `claude-haiku-5-5`. Check that this id exists for your account before relying on it, or set `cheapModel` (see below). These steps were written against Claude Code 2.1.322; if a command differs on your version, check `claude plugin --help`.

New sessions load it; in an open session run `/reload-plugins`.

## Routing rules

All rules live in `plugins/model-router/hooks/rules.ts`. A turn routes to the cheap model only if all of these hold:

- the prompt shows read-only intent: it starts with what / how many / how much / is / are / does / did / was / were / show / list / summarize / status / check / look up / find / where / which / when / who / explain / tell me / give me, or contains status / summary / summarize;
- it is under 400 characters;
- it contains no code fence;
- it is not a slash command and not empty;
- it contains none of the main-only words: write, edit, modify, change, fix, patch, commit, push, pull request, pr, merge, rebase, deploy, install, uninstall, build, package, stage, staging, approve, sudo, root, owner, restart, start, stop, enable, disable, reset, recover, rollback, delete, remove, rm, create, add, rename, move, mv, copy, cp, apply, run, execute, kill, update, upgrade, configure, set, release, implement, refactor, generate, scaffold, production, prod, ssh, reboot, mount, chmod, chown, --check, --approve, --recover.

If unsure, the turn stays on the main model. Subagent requests are never rerouted.

## Safety model: cheap turns can only read

In a cheap turn, every tool call goes through a guard:

- Allowed: `Read`, `Grep`, `Glob`, `LS`, `ToolSearch`, `ListAgents`, `WebFetch`, `WebSearch`, and a `Bash` command that is a single allowlisted read command with literal words only (`cat ls head tail wc grep stat date uptime hostname whoami echo ps free ss pwd cut`, plus `systemctl` with `status show is-active is-enabled is-failed list-units list-timers`).
- Anything else is refused before it runs, and the rest of that turn moves to the main model, which decides again and re-issues the call itself.
- Shell expansion, quotes, newlines, pipes, redirection, `git`, `curl`, `journalctl`, output-file arguments, recursive `grep` (any `-r`, `-R`, `-d`, `--directories` or abbreviated long form) and `ls -R`, `date` with arguments, `ss` kill flags, remote `systemctl`, and any path under `/srv` or `/mnt` all escalate.
- In `route` mode, if the guard itself breaks during a cheap turn that has not escalated yet, the call is refused and the turn escalates. Once a turn is on the main model, calls pass through as usual. If a call the guard already let through then fails, the guard reports the failure and does not run the call again (covered by a test). In `shadow` and `off` modes the guard does nothing (shadow only logs).
- The guard tracks one current turn at a time. It is written for a normal single-conversation session; subagent calls are never touched.

What this does not protect against. It is not a sandbox:

- `WebFetch` and `WebSearch` are allowed, so a cheap turn can send data out through a URL or a search query.
- `Read`, `cat`, `grep` and similar can read sensitive files (for example `~/.ssh` or `.env` files) into the cheaper model's context.
- `tail -f` and similar commands can hang a cheap turn.

## Modes and config file

Config file: `~/.claude/mod-config/model-router.json`, read at session start.

```json
{ "mode": "route", "cheapModel": "claude-haiku-5-5" }
```

- `mode`: `"route"` (default) switches cheap turns; `"shadow"` only logs what it would do and never switches or refuses; `"off"` does nothing.
- `cheapModel`: the model id for cheap turns. Optional; default `claude-haiku-5-5`. Must look like a model id (letters, digits, `.`, `_`, `:`, `-`); anything else is ignored and the default is used.

A missing or unreadable file means the defaults.

## Log

Each decision is appended to `~/.claude/mod-logs/model-router/<session-id>.jsonl` (the last 500 lines per session are kept). Each line has a timestamp, the mode, an event (`decision`, `escalate`, or `would-escalate` in shadow mode), the turn id, the route, the reason, and the prompt length. For escalations it also records the tool name.

The log directory and file are created with your default permissions (umask), and they contain the session id and tool names of escalations. Restrict access yourself if that matters.

Not logged: prompt text, model answers, tool arguments, file contents, command lines.

## Test

```sh
claude plugin validate .
claude plugin validate plugins/model-router
claude plugin test plugins/model-router
```

## Uninstall

```sh
claude plugin uninstall model-router@zackq-labs
claude plugin marketplace remove zackq-labs
```

Softer options: set `{"mode": "off"}` (or `"shadow"`) in the config file and start a new session; `claude plugin disable model-router@zackq-labs`; or `claude --safe-mode` to disable all mods for one session. Optionally delete `~/.claude/mod-config/model-router.json` and `~/.claude/mod-logs/model-router/`.

## Limitations

- Tested against one Claude Code version (2.1.322). The mods API is new and may change.
- Routing is keyword based. It will sometimes keep a read-only question on the main model (by design) and cannot understand intent beyond the rules above.
- The Bash allowlist is deliberately narrow; many harmless commands will escalate.
- The cheap model must exist for your account; a wrong `cheapModel` id will make cheap turns fail.

## License

MIT, see [LICENSE](LICENSE).
