// Explicit routing rules. Anything not clearly read-only stays on the main model.

export type Route = { route: 'cheap' | 'main'; reason: string }

// A prompt mentioning any of these never routes cheap (writes, owner steps, production, git, builds).
const MAIN_WORDS =
  /\b(write|edit|modify|change|fix|patch|commit|push|pull request|pr|merge|rebase|deploy|install|uninstall|build|package|stage|staging|approve|sudo|root|owner|restart|start|stop|enable|disable|reset|recover|rollback|delete|remove|rm|create|add|rename|move|mv|copy|cp|apply|run|execute|kill|update|upgrade|configure|set|release|implement|refactor|generate|scaffold|production|prod|ssh|reboot|mount|chmod|chown)\b|(?<!\S)--(?:check|approve|recover)\b/i

// The prompt has to look like a read-only request.
const READ_INTENT =
  /^\s*(what|what's|whats|how many|how much|is|are|does|did|was|were|show|list|summari[sz]e|status|check|look ?up|find|where|which|when|who|explain|tell me|give me)\b|\b(status|summary|summari[sz]e)\b/i

export const MAX_CHEAP_PROMPT = 400

export function classifyPrompt(text: string): Route {
  const t = (text ?? '').trim()
  if (t === '') return { route: 'main', reason: 'empty or continuation turn' }
  if (t.startsWith('/')) return { route: 'main', reason: 'slash command' }
  if (t.length > MAX_CHEAP_PROMPT) return { route: 'main', reason: 'long prompt' }
  if (t.includes('```')) return { route: 'main', reason: 'contains code' }
  const w = t.match(MAIN_WORDS)
  if (w) return { route: 'main', reason: 'main-only word: ' + w[0].toLowerCase() }
  if (!READ_INTENT.test(t)) return { route: 'main', reason: 'no read-only intent (default)' }
  return { route: 'cheap', reason: 'read-only request' }
}

// Tools a cheap turn may use. Every other tool escalates the turn to the main model.
export const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'ListAgents', 'WebFetch', 'WebSearch'])

const READ_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'wc', 'grep', 'stat', 'date', 'uptime', 'hostname', 'whoami', 'echo',
  'ps', 'free', 'ss', 'pwd', 'cut', 'systemctl',
])
const SYSTEMCTL_READ = /^(status|show|is-active|is-enabled|is-failed|list-units|list-timers)$/

// True only for a Bash command whose every segment is a plain local read.
export function bashIsReadOnly(command: string): boolean {
  const c = (command ?? '').trim()
  if (c === '') return false
  // A conservative shell subset: one command, literal words only. Quoting, expansion, newlines,
  // pipelines and redirections escalate rather than attempting to parse the shell with regexes.
  if (/[\r\n\x00-\x1f]/.test(command) || /[^a-zA-Z0-9_ ./,:@%+=-]/.test(c)) return false
  // /srv and /mnt commonly hold large data or mounted network/external disks, where even a plain read can be
  // slow or hang. Anything that touches them stays on the main model.
  if (/\/srv\b|\/mnt\b/.test(c)) return false
  const words = c.split(/\s+/), cmd = words[0] ?? ''
  if (!READ_COMMANDS.has(cmd)) return false
  if (cmd === 'systemctl' && (!SYSTEMCTL_READ.test(words[1] ?? '') || words.some(w => /^(-H|-M|--host|--machine)(=|$)/.test(w)))) return false
  if (cmd === 'date' && words.length !== 1) return false // date --set changes the host clock
  if (cmd === 'ss' && words.some(w => w === '--kill' || /^-[^-]*K/.test(w))) return false
  // grep: escalate -d/--directories, any recursion flag (including getopt long-option abbreviations
  // such as --rec or --dir) and the word "recurse".
  if (cmd === 'grep' && words.some(w => /^--(r|de|di)/.test(w) || /^-[^-]*[rRd]/.test(w) || /recurse/.test(w))) return false
  if (cmd === 'ls' && words.some(w => /^--r/.test(w) || /^-[^-]*R/.test(w))) return false
  return true
}

export function toolIsReadOnly(tool: string, input: { command?: unknown }): boolean {
  if (tool === 'Bash') return typeof input.command === 'string' && bashIsReadOnly(input.command)
  return READ_ONLY_TOOLS.has(tool)
}
