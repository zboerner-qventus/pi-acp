import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(r => setTimeout(r, 0))
}
const titles = (conn: FakeAgentSideConnection) =>
  conn.updates.filter(u => (u.update as any).title !== undefined).map(u => (u.update as any).title)

test('PiAcpSession: a title-model rename does not pin, so later prompts can still retitle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc, conn)

  // simulates the setSessionName echo pi sends back mid-regenerateTitle
  ;(session as any).settingGeneratedTitle = true
  proc.emit({ type: 'session_info_changed', name: 'Generated title' })
  ;(session as any).settingGeneratedTitle = false

  assert.equal((session as any).titlePinned, false)
})

test('PiAcpSession: an explicit pi rename pins the title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc, conn)

  proc.emit({ type: 'session_info_changed', name: 'Named by an extension' })
  await settle()

  assert.deepEqual(titles(conn), ['Named by an extension'])
  assert.equal((session as any).titlePinned, true)
})
