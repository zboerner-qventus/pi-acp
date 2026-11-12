import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

let agentDir: string
let previousAgentDir: string | undefined

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-usage-notices-'))
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
})

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  rmSync(agentDir, { recursive: true, force: true })
})

function enableNotices(enabled: boolean) {
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ showCacheMissNotices: enabled }))
}

const PER_M = { input: 3, cacheRead: 0.3, cacheWrite: 3.75 }

function assistant(timestamp: number, t: { input: number; cacheRead: number; cacheWrite: number }, extra = {}) {
  return {
    role: 'assistant',
    provider: 'anthropic',
    model: 'claude',
    timestamp,
    stopReason: 'stop',
    usage: {
      ...t,
      output: 10,
      cost: {
        input: (t.input * PER_M.input) / 1e6,
        output: 0,
        cacheRead: (t.cacheRead * PER_M.cacheRead) / 1e6,
        cacheWrite: (t.cacheWrite * PER_M.cacheWrite) / 1e6,
        total: 0
      }
    },
    ...extra
  }
}

function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [{ provider: 'anthropic', id: 'claude', cost: { ...PER_M, output: 15 } }]
  })
  new PiAcpSession({
    sessionId: 's1',
    cwd: agentDir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let n = 0
  const end = async (message: ReturnType<typeof assistant>, persistFirst = false) => {
    const entry = { type: 'message', id: `e${++n}`, parentId: proc.entries.at(-1)?.id ?? null, message }
    if (persistFirst) proc.entries.push(entry)
    proc.emit({ type: 'message_end', message })
    if (!persistFirst) proc.entries.push(entry)
    await new Promise(r => setTimeout(r, 10))
  }
  const notices = () =>
    conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate === 'agent_message_chunk' && u._meta)

  return { proc, end, notices }
}

const T0 = 1_700_000_000_000

test('usage notices: cache miss after idle is reported; first turn and cache hits are not', async () => {
  enableNotices(true)
  const { proc, end, notices } = setup()

  await end(assistant(T0, { input: 100, cacheRead: 0, cacheWrite: 50_000 }))
  await end(assistant(T0 + 60_000, { input: 200, cacheRead: 50_000, cacheWrite: 100 }))
  assert.deepEqual(notices(), [])

  await end(assistant(T0 + 60_000 + 10 * 60_000, { input: 100, cacheRead: 0, cacheWrite: 50_500 }), true)

  assert.deepEqual(notices(), [
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Cache miss after 10m idle: 50k tokens re-billed (~$0.17)' },
      _meta: { piAcp: { notify: { level: 'warning', source: 'cacheMiss' } } }
    }
  ])
  assert.deepEqual(proc.getEntriesCalls, [undefined, 'e1', 'e2'])
})

test('usage notices: small misses, compaction resets, model switches and aborted turns', async () => {
  enableNotices(true)
  const { proc, end, notices } = setup()

  await end(assistant(T0, { input: 100, cacheRead: 0, cacheWrite: 50_000 }))
  await end(assistant(T0 + 1000, { input: 100, cacheRead: 40_000, cacheWrite: 10_100 }))
  proc.entries.push({ type: 'compaction', id: 'c1', parentId: proc.entries.at(-1)!.id })
  await end(assistant(T0 + 2000, { input: 100, cacheRead: 0, cacheWrite: 50_000 }))
  await end(assistant(T0 + 3000, { input: 100, cacheRead: 0, cacheWrite: 50_000 }, { stopReason: 'aborted' }))
  assert.deepEqual(notices(), [])

  await end(assistant(T0 + 4000, { input: 100, cacheRead: 0, cacheWrite: 50_000 }, { model: 'other' }))
  assert.deepEqual(
    notices().map(u => u.content.text),
    ['Cache miss after model switch: 50k tokens re-billed (~$0.19)']
  )
})

test('usage notices: nothing is emitted or fetched when showCacheMissNotices is off', async () => {
  enableNotices(false)
  const { proc, end, notices } = setup()

  await end(assistant(T0, { input: 100, cacheRead: 0, cacheWrite: 50_000 }))
  await end(assistant(T0 + 10 * 60_000, { input: 100, cacheRead: 0, cacheWrite: 50_000 }))
  proc.emit({
    type: 'compaction_end',
    aborted: false,
    result: { usage: assistant(0, { input: 1, cacheRead: 0, cacheWrite: 0 }).usage }
  })
  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(notices(), [])
  assert.deepEqual(proc.getEntriesCalls, [])
})

test('usage notices: thinking drops and compaction cost', async () => {
  enableNotices(true)
  const { proc, end, notices } = setup()
  const drops = (k: number) => ({
    diagnostics: [
      {
        type: 'anthropic_input_transformations',
        details: { transformations: Array.from({ length: k }, () => ({ type: 'thinking_dropped' })) }
      }
    ]
  })
  const hit = { input: 100, cacheRead: 0, cacheWrite: 0 }

  await end(assistant(T0, hit, drops(1)))
  await end(assistant(T0 + 1, hit, drops(1)))
  await end(assistant(T0 + 2, hit, drops(3)), true)
  proc.emit({
    type: 'compaction_end',
    aborted: false,
    result: {
      usage: {
        ...assistant(0, { input: 40_000, cacheRead: 0, cacheWrite: 0 }).usage,
        cost: { input: 0.12, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.125 }
      }
    }
  })
  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(
    notices().map(u => [u._meta.piAcp.notify.source, u.content.text]),
    [
      ['thinkingDropped', 'Anthropic dropped 1 thinking block (details in session)'],
      ['thinkingDropped', 'Anthropic dropped 3 thinking blocks (details in session)'],
      ['compactionCost', 'Compaction: 40k tokens billed (~$0.13)']
    ]
  )
})
