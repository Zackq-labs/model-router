import type { Register } from 'claude-code'
import { classifyPrompt, toolIsReadOnly } from './rules.ts'

// The cheaper model for read-only turns. The main model is whatever the session uses.
// Default; override with {"cheapModel": "<model id>"} in the config file.
const DEFAULT_CHEAP_MODEL = 'claude-haiku-5-5'
let cheapModel = DEFAULT_CHEAP_MODEL

// mode: 'route' switches cheap turns, 'shadow' only logs, 'off' does nothing.
// Read from ~/.claude/mod-config/model-router.json, {"mode": "shadow"}; missing file = 'route'.
type Mode = 'route' | 'shadow' | 'off'
let mode: Mode = 'route'
let logFile = ''
let logLines: string[] = []
let currentTurn = ''
const turns = new Map<string, { route: 'cheap' | 'main'; reason: string; escalated: boolean }>()

async function log($: any, entry: Record<string, unknown>) {
  if (logFile === '') return
  logLines = [...logLines, JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), mode, ...entry })].slice(-500)
  try {
    await $.fs.write(logFile, logLines.join('\n') + '\n')
  } catch {
    // Logging never blocks a turn.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    mode = 'route'
    cheapModel = DEFAULT_CHEAP_MODEL
    turns.clear()
    currentTurn = ''
    logLines = []
    logFile = ''
    try {
      const home = (await $.env.get('HOME')) ?? ''
      if (home !== '') {
        try {
          const cfg = JSON.parse(String(await $.fs.read(home + '/.claude/mod-config/model-router.json')))
          if (cfg.mode === 'route' || cfg.mode === 'shadow' || cfg.mode === 'off') mode = cfg.mode
          // Only a plain model-id-shaped string is accepted; anything else keeps the default.
          if (typeof cfg.cheapModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(cfg.cheapModel)) cheapModel = cfg.cheapModel
        } catch {
          // No config file: default mode.
        }
        const dir = home + '/.claude/mod-logs/model-router'
        await $.process.run(['mkdir', '-p', dir])
        logFile = dir + '/' + (await $.session.id()) + '.jsonl'
      }
    } catch {
      // Without a log path the router still runs; decisions show in the status line.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    currentTurn = e.turnId
    const d = mode === 'off' ? { route: 'main' as const, reason: 'router off' } : classifyPrompt(e.text)
    turns.set(e.turnId, { ...d, escalated: false })
    if (turns.size > 200) turns.delete(turns.keys().next().value as string)
    await log($, { event: 'decision', turnId: e.turnId, route: d.route, reason: d.reason, promptLength: e.text.length })
    if (mode === 'route') void $.ui.status(d.route === 'cheap' ? 'router: cheap model (' + d.reason + ')' : undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const d = turns.get(e.turnId)
    // Subagents, unknown turns, main turns and escalated turns keep the engine's model.
    if (mode !== 'route' || e.agentId !== undefined || d === undefined || d.route !== 'cheap' || d.escalated) {
      return yield* next(e)
    }
    return yield* next({ ...e, model: cheapModel })
  })

  // Guard: in a cheap turn, any tool call that is not a plain read is refused and the turn escalates,
  // so the next request (and the retried call) runs on the main model.
  on('tool.call', async ($, e, next) => {
    const d = turns.get(currentTurn)
    if (e.agentId !== undefined || d === undefined || d.route !== 'cheap' || d.escalated) return next(e)
    if (toolIsReadOnly(String(e.tool), e as { command?: unknown })) return next(e)
    if (mode === 'shadow') {
      await log($, { event: 'would-escalate', turnId: currentTurn, tool: String(e.tool) })
      return next(e)
    }
    d.escalated = true
    await log($, { event: 'escalate', turnId: currentTurn, tool: String(e.tool) })
    void $.ui.status('router: escalated to main model (' + String(e.tool) + ')')
    return {
      deny:
        'model-router: this turn was answered by the cheap model, which may only read. ' +
        'The call was not run. The turn is now on the main model: decide again and re-issue the call if it is still needed.',
    }
  }).catch(($, e, next) => {
    // Fail closed: if the guard breaks in a cheap turn, refuse and escalate.
    if (next.called) throw new Error('model-router: downstream tool failure; call was not replayed')
    const d = turns.get(currentTurn)
    if (d !== undefined && d.route === 'cheap' && !d.escalated && mode === 'route') {
      d.escalated = true
      return { deny: 'model-router: guard failed; call not run. Re-issue it now on the main model.' }
    }
    return next(e)
  })
}
