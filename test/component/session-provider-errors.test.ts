import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const billingError =
  '400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.'

function fixture() {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { proc, session }
}

function fail(proc: FakePiRpcProcess) {
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: billingError } })
}

const isBillingError = (error: unknown) =>
  error instanceof RequestError && error.code === -32603 && error.message.includes(billingError)

test('provider failure rejects at settlement with the actionable message and allows another prompt', async () => {
  const { proc, session } = fixture()
  const prompt = session.prompt('hello')
  const rejected = assert.rejects(prompt, isBillingError)
  let settled = false
  void prompt.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  fail(proc)
  proc.emit({ type: 'agent_end' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(settled, false)
  proc.emit({ type: 'agent_settled' })
  await rejected
  const next = session.prompt('try again')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await next, 'end_turn')
})

test('a successful retry clears the earlier provider error', async () => {
  const { proc, session } = fixture()
  const prompt = session.prompt('hello')
  fail(proc)
  proc.emit({ type: 'agent_end', willRetry: true })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  proc.emit({ type: 'auto_retry_end', success: true })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('exhausted retries preserve the final error', async () => {
  const { proc, session } = fixture()
  const rejected = assert.rejects(session.prompt('hello'), isBillingError)
  proc.emit({ type: 'auto_retry_end', success: false, finalError: billingError })
  proc.emit({ type: 'agent_settled' })
  await rejected
})

test('cancel takes precedence over a provider error', async () => {
  const { proc, session } = fixture()
  const prompt = session.prompt('hello')
  fail(proc)
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
})

test('non-auth prompt RPC failures reject instead of returning end_turn', async () => {
  const { proc, session } = fixture()
  proc.prompt = async () => {
    throw new Error(billingError)
  }
  await assert.rejects(session.prompt('hello'), isBillingError)
})

test('provider errors without a message still reject', async () => {
  const { proc, session } = fixture()
  const rejected = assert.rejects(session.prompt('hello'), /Pi request failed/)
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })
  proc.emit({ type: 'agent_settled' })
  await rejected
})
