import test from 'node:test'
import assert from 'node:assert/strict'

import { PI_ACP_TITLE_MODEL, isRetitleTurn, parseTitle, titleModel, toTitlePrompt } from '../../src/acp/thread-title.js'

test('isRetitleTurn: fires on 1, 3, 6, 10, 15 and nowhere else', () => {
  const fired = Array.from({ length: 22 }, (_, i) => i + 1).filter(isRetitleTurn)

  assert.deepEqual(fired, [1, 3, 6, 10, 15, 21])
  assert.equal(isRetitleTurn(0), false)
  assert.equal(isRetitleTurn(-1), false)
  assert.equal(isRetitleTurn(1.5), false)
  // Guard the float path: 5050 is triangular (n=100), 5051 is not.
  assert.equal(isRetitleTurn(5050), true)
  assert.equal(isRetitleTurn(5051), false)
})

test('parseTitle: takes the last non-empty line and strips quoting', () => {
  assert.equal(parseTitle('Fix read tool title bug\n'), 'Fix read tool title bug')
  assert.equal(parseTitle('  "Fix the titler"  '), 'Fix the titler')
  assert.equal(parseTitle('Loading models...\nFix the titler.'), 'Fix the titler')
  assert.equal(parseTitle('Fix   the    titler'), 'Fix the titler')
})

test('parseTitle: rejects empty output and a chatty model', () => {
  assert.equal(parseTitle(''), null)
  assert.equal(parseTitle('   \n\n  '), null)
  assert.equal(
    parseTitle('Sure! Here is a title that summarises the session you described above for you:'),
    null,
    'a sentence is not a title'
  )
})

test('toTitlePrompt: keeps both ends of a long transcript', () => {
  const prompt = toTitlePrompt([
    { role: 'user', text: 'A'.repeat(3000) },
    { role: 'assistant', text: 'B'.repeat(3000) }
  ])

  assert.ok(prompt.includes('A'.repeat(200)), 'the opening ask survives')
  assert.ok(prompt.includes('B'.repeat(200)), 'the latest reply survives')
  assert.ok(prompt.includes('[...]'), 'the middle is elided')
  assert.ok(prompt.length < 4500, `stayed small, was ${prompt.length}`)
})

test('titleModel: unset, blank or whitespace means no titler', () => {
  const previous = process.env[PI_ACP_TITLE_MODEL]

  try {
    delete process.env[PI_ACP_TITLE_MODEL]
    assert.equal(titleModel(), null)

    process.env[PI_ACP_TITLE_MODEL] = '   '
    assert.equal(titleModel(), null)

    process.env[PI_ACP_TITLE_MODEL] = ' amazon-bedrock/us.anthropic.claude-haiku-4-5 '
    assert.equal(titleModel(), 'amazon-bedrock/us.anthropic.claude-haiku-4-5')
  } finally {
    if (previous === undefined) delete process.env[PI_ACP_TITLE_MODEL]
    else process.env[PI_ACP_TITLE_MODEL] = previous
  }
})
