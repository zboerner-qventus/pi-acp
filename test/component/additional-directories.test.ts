import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function mockSpawn(): { calls: any[]; restore: () => void } {
  const calls: any[] = []
  const original = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    calls.push(params)
    return new FakePiRpcProcess() as any
  }
  return { calls, restore: () => (PiRpcProcess.spawn = original) }
}

test('PiAcpAgent: advertises additionalDirectories', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(res.agentCapabilities?.sessionCapabilities?.additionalDirectories, {})
})

test('PiAcpAgent: newSession passes deduplicated additionalDirectories to pi, without cwd', async () => {
  const spawn = mockSpawn()
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    await agent.newSession({
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/other', '/tmp/project', '/tmp/other/', '/tmp/third']
    })
    assert.deepEqual(spawn.calls[0].additionalDirectories, ['/tmp/other', '/tmp/third'])
  } finally {
    spawn.restore()
  }
})

test('PiAcpAgent: newSession and loadSession reject relative additionalDirectories', async () => {
  const spawn = mockSpawn()
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const isInvalidParams = (e: any) => e?.code === -32602
    await assert.rejects(
      agent.newSession({ cwd: '/tmp/project', mcpServers: [], additionalDirectories: ['other'] }),
      isInvalidParams
    )
    await assert.rejects(
      agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [], additionalDirectories: ['../x'] }),
      isInvalidParams
    )
    assert.equal(spawn.calls.length, 0)
  } finally {
    spawn.restore()
  }
})

test('PiAcpAgent: loadSession passes additionalDirectories to pi and stores them for session/list', async () => {
  const spawn = mockSpawn()
  const upserts: any[] = []
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    ;(agent as any).store = {
      get: () => ({ sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: '' }),
      upsert: (entry: any) => upserts.push(entry)
    }
    await agent.loadSession({
      sessionId: 's1',
      cwd: '/tmp/project',
      mcpServers: [],
      additionalDirectories: ['/tmp/other']
    })
    assert.deepEqual(spawn.calls[0].additionalDirectories, ['/tmp/other'])
    assert.ok(upserts.length > 0)
    for (const entry of upserts) assert.deepEqual(entry.additionalDirectories, ['/tmp/other'])
  } finally {
    spawn.restore()
  }
})

test(
  'PiRpcProcess appends a system prompt naming the additional directories',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-dirs-'))
    const out = join(root, 'argv.json')
    const launcher = join(root, 'pi')
    writeFileSync(
      launcher,
      `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(out + '.tmp')}, JSON.stringify(process.argv.slice(2)))\nfs.renameSync(${JSON.stringify(out + '.tmp')}, ${JSON.stringify(out)})\n`
    )
    chmodSync(launcher, 0o755)
    try {
      const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, additionalDirectories: ['/a', '/b'] })
      for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise(r => setTimeout(r, 20))
      proc.dispose()
      const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
      const text = argv[argv.indexOf('--append-system-prompt') + 1]
      assert.equal(argv.filter(a => a === '--append-system-prompt').length, 1)
      assert.match(text, /\n\/a\n\/b\n/)
      assert.match(text, /AGENTS\.md/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
