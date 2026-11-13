import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Between pi's `agent_settled` and the ACP turn resolving (usage stats are read first), pi is idle:
// a steer sent then would wait in pi's queue for the next prompt, so the turn must not count as running.
test('PiAcpSession: a turn that pi has settled no longer takes steering', async () => {
  const proc = new FakePiRpcProcess()
  let releaseStats!: () => void
  const stats = new Promise<void>(r => (releaseStats = r))
  ;(proc as any).getSessionStats = async () => {
    await stats
    return {}
  }
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: []
  })

  const turn = session.prompt('one')
  assert.equal(session.isTurnRunning(), true)
  proc.emit({ type: 'agent_start' })
  assert.equal(session.isTurnRunning(), true, 'pi is working')
  proc.emit({ type: 'agent_end' })
  assert.equal(session.isTurnRunning(), true, 'pi may still retry or continue before it settles')

  proc.emit({ type: 'agent_settled' })
  assert.equal(session.isTurnRunning(), false, 'settled: a steer would be stranded in pi')

  releaseStats()
  assert.equal(await turn, 'end_turn')
  assert.equal(session.isTurnRunning(), false)

  // The next turn takes steering again.
  void session.prompt('two')
  assert.equal(session.isTurnRunning(), true)
})
