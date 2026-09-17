import { spawn } from 'node:child_process'

import { getPiCommand, shouldUseShellForPiCommand } from '../pi-rpc/command.js'

export const PI_ACP_TITLE_MODEL = 'PI_ACP_TITLE_MODEL'

const TITLE_TIMEOUT_MS = 30_000
const TRANSCRIPT_MAX = 4000
const TITLE_MAX = 90
const TITLE_MAX_WORDS = 12

const INSTRUCTIONS =
  "Below is a coding session transcript (user asks and the assistant's replies), oldest first. Reply with only a title of at most 12 words naming what the session is about. No quotes, no trailing punctuation, no preamble."

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

/** Unset means no titler: clients keep the cheap first-prompt title. */
export function titleModel(): string | null {
  const model = process.env[PI_ACP_TITLE_MODEL]?.trim()
  return model ? model : null
}

export function toTitlePrompt(entries: TranscriptEntry[]): string {
  const joined = entries.map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`).join('\n---\n')
  // Both ends carry the topic: the opening ask, and whatever the session drifted into.
  const transcript =
    joined.length > TRANSCRIPT_MAX
      ? `${joined.slice(0, TRANSCRIPT_MAX / 2)}\n[...]\n${joined.slice(-TRANSCRIPT_MAX / 2)}`
      : joined

  return `${INSTRUCTIONS}\n\n${transcript}`
}

/** Retitle on turns 1, 3, 6, 10, 15... so a drifting thread is tracked without a subprocess per turn. */
export function isRetitleTurn(turnCount: number): boolean {
  if (!Number.isInteger(turnCount) || turnCount < 1) return false
  const n = Math.round((Math.sqrt(8 * turnCount + 1) - 1) / 2)
  return (n * (n + 1)) / 2 === turnCount
}

/** Take the last non-empty stdout line, so a banner or a chatty model cannot poison the title. */
export function parseTitle(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const last = lines.at(-1)
  if (!last) return null

  const title = last
    .replace(/^["'`]+|["'`.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title || title.length > TITLE_MAX || title.split(' ').length > TITLE_MAX_WORDS) return null
  return title
}

/** Best-effort: title a thread with a one-shot `pi --print`, reusing pi's auth and models. */
export async function generateThreadTitle(
  entries: TranscriptEntry[],
  cwd: string,
  piCommand?: string
): Promise<string | null> {
  const model = titleModel()
  if (!model || !entries.length) return null

  const cmd = getPiCommand(piCommand)
  // A titler must not gate on permissions or read the project, so no tools/extensions/skills.
  const args = ['-p', '--no-session', '-nt', '-ne', '-ns', '-nc', '--model', model, toTitlePrompt(entries)]

  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], shell: shouldUseShellForPiCommand(cmd) })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let done = false
    const finish = (title: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(title)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, TITLE_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', code => finish(code === 0 ? parseTitle(stdout) : null))
  })
}
