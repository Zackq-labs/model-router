import { expect, test } from 'claude-code/testing'
import { bashIsReadOnly, classifyPrompt, toolIsReadOnly } from '../hooks/rules.ts'

test('read-only questions route cheap', async () => {
  for (const p of ['what is the service status?', 'summarize the last report', 'how many files in the folder', 'show service status']) {
    expect(classifyPrompt(p).route).toBe('cheap')
  }
})

test('anything that writes, runs owner steps, touches production, pushes or builds stays main', async () => {
  for (const p of [
    'fix the build script', 'commit and push this', 'status check then deploy it', 'build the package',
    'run sudo systemctl restart my-service', 'what does --reset do on production', 'show me then delete the old log',
    'open a pull request', 'stage the release package', 'ssh to my-server and check status',
  ]) {
    expect(classifyPrompt(p).route).toBe('main')
  }
})

test('unsure, empty, long, slash and code prompts default to main', async () => {
  expect(classifyPrompt('').route).toBe('main')
  expect(classifyPrompt('the thing from yesterday').route).toBe('main')
  expect(classifyPrompt('/status').route).toBe('main')
  expect(classifyPrompt('what is ' + 'x'.repeat(500)).route).toBe('main')
  expect(classifyPrompt('what does ```rm``` do').route).toBe('main')
})

test('bash read allowlist', async () => {
  for (const c of ['cat /var/lib/app/status.json', 'systemctl status my-service --no-pager',
    'ls /home/user', 'date', 'ss -lnt']) {
    expect(bashIsReadOnly(c)).toBe(true)
  }
  for (const c of ['rm -rf /tmp/x', 'sudo cat /etc/shadow', 'echo hi > file', 'cat a >> b', 'git push origin main',
    'systemctl restart my-service', 'curl -X POST http://x', 'curl -o out http://x', 'ls /srv/media', 'grep -r foo /',
    'cat $(ls)', 'ssh my-server ls', 'python3 -c "open(1)"', 'git commit -m x', 'cat x | tee y', 'git checkout -b z',
    'cat a\nrm b', 'cat a & rm b', 'cat a\n', 'git branch new-branch', 'git remote add x y', 'git diff --output=x',
    'curl --config x', 'curl -oout http://x', 'curl --output=out http://x', 'sort -o x y', 'uniq input output',
    'date --set=tomorrow', 'ss -K', 'ss --kill', 'journalctl --rotate', 'grep --recursive foo /', 'grep -d recurse foo .', 'grep --directories=recurse foo /', 'grep --dir=recurse foo /', 'grep --rec foo /', 'grep -rn foo /', 'ls -R /', 'ls --recursive /',
    'cat "$(rm x)"', 'systemctl --host=x status y', 'echo $HOME', 'cat a\\\nrm b']) {
    expect(bashIsReadOnly(c)).toBe(false)
  }
})

test('tool allowlist', async () => {
  expect(toolIsReadOnly('Read', {})).toBe(true)
  expect(toolIsReadOnly('Edit', {})).toBe(false)
  expect(toolIsReadOnly('Write', {})).toBe(false)
  expect(toolIsReadOnly('Agent', {})).toBe(false)
  expect(toolIsReadOnly('mcp__github__create_pull_request', {})).toBe(false)
  expect(toolIsReadOnly('Bash', { command: 'ls' })).toBe(true)
  expect(toolIsReadOnly('Bash', {})).toBe(false)
})
