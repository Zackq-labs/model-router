# Changelog

## 0.1.0

- First public release.
- Routes simple read-only turns to a cheaper model; refuses non-read tool calls in those turns and moves the rest of the turn to the main model.
- Modes: `route` (default), `shadow` (log only), `off`.
- Per-session decision log without prompt text or tool arguments.
- The cheap model id is configurable with `cheapModel` in the config file (default `claude-haiku-5-5`).
