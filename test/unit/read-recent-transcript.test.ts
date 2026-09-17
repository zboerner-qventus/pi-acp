import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRecentTranscript } from '../../src/acp/pi-sessions.js'

function writeSessionFile(lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const dir = join(root, 'sessions', '--p--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 's.jsonl')
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}

test('readRecentTranscript: extracts user/assistant text, in order, skipping tool-only turns', () => {
  const file = writeSessionFile([
    { type: 'session', version: 3, id: 'sess-1', timestamp: 't0', cwd: '/tmp/project' },
    { type: 'message', id: '1', message: { role: 'user', content: 'Bump the title word limit' } },
    {
      type: 'message',
      id: '2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done, bumped to 12.' }] }
    },
    { type: 'message', id: '3', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'edit' }] } },
    { type: 'message', id: '4', message: { role: 'user', content: [{ type: 'text', text: 'Also add more context' }] } }
  ])

  const entries = readRecentTranscript(file)

  assert.deepEqual(entries, [
    { role: 'user', text: 'Bump the title word limit' },
    { role: 'assistant', text: 'Done, bumped to 12.' },
    { role: 'user', text: 'Also add more context' }
  ])
})

test('readRecentTranscript: returns empty for a missing file', () => {
  assert.deepEqual(readRecentTranscript('/nonexistent/path.jsonl'), [])
})
