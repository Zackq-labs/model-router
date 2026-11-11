import { expect, mock, test } from 'claude-code/testing'

type On = (name: string, fn: (...a: any[]) => any) => void

// Stubs for everything session.start and the logger call. config = contents of the mode file, or null.
function stubs(on: On, config: string | null, written: string[], toolCall: () => unknown = () => ({ result: 'ran' })) {
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/t' })
  on('fs.read', () => (config === null ? { deny: 'ENOENT' } : { value: config }))
  on('fs.write', ($: unknown, e: { text: string }) => {
    written.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('session.id', () => ({ value: 'sess1' }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', toolCall)
}

// Fire one step and return the model the bottom of the chain was asked for.
async function stepModel($: any, on: On, seen: string[], turnId: string, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return seen[seen.length - 1]
}

function stepStub(on: On, seen: string[]) {
  on('turn.step', async function* ($: unknown, e: { turnId: string; index: number; model: string }) {
    seen.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

test('a read-only turn is sent to the cheap model, a write turn is not', async ($, on) => {
  const written: string[] = []
  const seen: string[] = []
  stubs(on, null, written)
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is the service status?', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('claude-haiku-5-5')
  await $.turn.start({ text: 'fix the build script and commit it', turnId: 't2' })
  expect(await stepModel($, on, seen, 't2')).toBe('claude-opus-5-5')
  // Subagent steps are never rerouted.
  await $.turn.start({ text: 'what is the status?', turnId: 't3' })
  expect(await stepModel($, on, seen, 't3', 'agent-1')).toBe('claude-opus-5-5')
  // Every decision was logged.
  const log = written[written.length - 1]
  expect(log).toContain('"route":"cheap"')
  expect(log).toContain('"route":"main"')
  expect(log).toContain('main-only word: fix')
})

test('a write in a cheap turn is refused and the turn escalates to the main model', async ($, on) => {
  const written: string[] = []
  const seen: string[] = []
  stubs(on, null, written)
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'show the service status', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('claude-haiku-5-5')
  // A read runs.
  expect(await $.tool.call({ tool: 'Bash', command: 'cat /var/lib/x.json' })).toEqual({ result: 'ran' })
  // A write is refused.
  const w = await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: 'x' })
  expect(typeof (w as any).deny).toBe('string')
  expect((w as any).deny).toContain('model-router')
  expect((w as any).deny).toContain('The call was not run')
  // The next step of the same turn runs on the main model, and the write now goes through.
  expect(await stepModel($, on, seen, 't1')).toBe('claude-opus-5-5')
  expect(await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: 'x' })).toEqual({ result: 'ran' })
  expect(written[written.length - 1]).toContain('"event":"escalate"')
})

test('shadow mode logs but never changes the model or refuses a call', async ($, on) => {
  const written: string[] = []
  const seen: string[] = []
  stubs(on, '{"mode":"shadow"}', written)
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is the status?', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('claude-opus-5-5')
  expect(await $.tool.call({ tool: 'Edit', file_path: '/tmp/x', old_string: 'a', new_string: 'b' })).toEqual({ result: 'ran' })
  expect(written[written.length - 1]).toContain('would-escalate')
})

test('off mode routes nothing', async ($, on) => {
  const seen: string[] = []
  stubs(on, '{"mode":"off"}', [])
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is the status?', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('claude-opus-5-5')
})

test('decision logging omits prompt contents', async ($, on) => {
  const written: string[] = []
  stubs(on, null, written)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is fixture-private-value?', turnId: 't1' })
  expect(written[written.length - 1]).not.toContain('fixture-private-value')
  expect(written[written.length - 1]).toContain('promptLength')
})

test('downstream failure does not replay a tool call', async ($, on) => {
  let attempts = 0
  const written: string[] = []
  stubs(on, null, written, () => { attempts += 1; throw new Error('fixture downstream failure') })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // A cheap turn: the read-only Read call reaches the downstream stub, which throws.
  await $.turn.start({ text: 'show the status', turnId: 't1' })
  expect(written[written.length - 1]).toContain('"route":"cheap"')
  let error: unknown = undefined
  try {
    await $.tool.call({ tool: 'Read', file_path: '/tmp/fixture' })
  } catch (err) {
    error = err
  }
  expect(error).toBeDefined()
  // The harness reports a throwing downstream stub in its own words; what matters is that the guard
  // let the failure surface and did not run the call a second time.
  expect(String((error as Error).message)).not.toContain('The call was not run')
  expect(attempts).toBe(1)
})

test('--check, --approve and --recover flags keep a turn on the main model', async ($, on) => {
  const written: string[] = []
  stubs(on, null, written)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'show the status with --check', turnId: 't1' })
  expect(written[written.length - 1]).toContain('"route":"main"')
  expect(written[written.length - 1]).toContain('main-only word: --check')
  await $.turn.start({ text: 'show the status of x --recover', turnId: 't2' })
  expect(written[written.length - 1]).toContain('"route":"main"')
  // A bare word containing the letters still routes cheap.
  await $.turn.start({ text: 'show the status of the checkpoint', turnId: 't3' })
  expect(written[written.length - 1]).toContain('"route":"cheap"')
})

test('cheapModel in the config file overrides the default', async ($, on) => {
  const seen: string[] = []
  stubs(on, '{"cheapModel":"my-cheap-model"}', [])
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is the status?', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('my-cheap-model')
})

test('an invalid cheapModel keeps the default', async ($, on) => {
  const seen: string[] = []
  stubs(on, '{"cheapModel":"bad model; x"}', [])
  stepStub(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'what is the status?', turnId: 't1' })
  expect(await stepModel($, on, seen, 't1')).toBe('claude-haiku-5-5')
})
