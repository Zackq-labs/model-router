# model-router

Claude Code mod that routes simple read-only turns (status, summaries, lookups) to a cheaper model and refuses any non-read tool call in those turns, moving the rest of the turn to the main model. Modes: route, shadow, off. Config: `~/.claude/mod-config/model-router.json`. See the repository README for the exact rules, the log format, safety model and limitations. Not affiliated with Anthropic.
