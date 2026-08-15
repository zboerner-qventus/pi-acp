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

test('PiAcpSession: titles a fresh thread from its first prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  void session.prompt('Fix the flaky   test in\nsession-events.test.ts')
  await settle()

  assert.deepEqual(titles(conn), ['Fix the flaky test in session-events.test.ts'])
})

test('PiAcpSession: a later prompt does not rename the thread', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  void session.prompt('First question')
  await settle()
  proc.emit({ type: 'agent_settled' })
  await settle()
  void session.prompt('Second question')
  await settle()

  assert.deepEqual(titles(conn), ['First question'])
})

test("PiAcpSession: prefers pi's own session name over the prompt", async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium', sessionName: 'Refactor auth' })
  const session = makeSession(proc, conn)

  await session.publishSessionTitle()
  await settle()

  assert.deepEqual(titles(conn), ['Refactor auth'])
})

test('PiAcpSession: publishSessionTitle is a no-op for an unnamed session with no prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  await session.publishSessionTitle()
  await settle()

  assert.deepEqual(titles(conn), [])
})

test('PiAcpSession: truncates a long prompt title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  void session.prompt('x'.repeat(200))
  await settle()

  const [title] = titles(conn)
  assert.equal(title.length, 80)
  assert.match(title, /…$/)
})

test('PiAcpSession: an explicit pi rename wins over the derived title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  proc.emit({ type: 'session_info_changed', name: 'Named by an extension' })
  void session.prompt('Some prompt')
  await settle()

  assert.deepEqual(titles(conn), ['Named by an extension'])
})
