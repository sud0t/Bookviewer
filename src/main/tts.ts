/**
 * Speech engines that run as local programs. (The renderer handles the Web
 * Speech API itself; Chromium on Linux only has voices there when
 * speech-dispatcher is set up, so these are the dependable ones.)
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { TtsVoice } from '@shared/types'

const MAX_TEXT = 8000
const TIMEOUT_MS = 60000

interface RunResult {
  stdout: Buffer
  stderr: string
}

function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out`))
    }, TIMEOUT_MS)
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr })
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * espeak-ng streams its WAV, leaving the length fields as placeholders;
 * fill them in so that decoders don't have to guess.
 */
export function fixWavHeader(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF') return wav
  wav.writeUInt32LE(wav.length - 8, 4)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    if (id === 'data') {
      wav.writeUInt32LE(wav.length - offset - 8, offset + 4)
      break
    }
    offset += 8 + wav.readUInt32LE(offset + 4)
  }
  return wav
}

let espeakBinary: string | null | undefined

async function findEspeak(): Promise<string | null> {
  if (espeakBinary !== undefined) return espeakBinary
  for (const candidate of ['espeak-ng', 'espeak']) {
    try {
      await run(candidate, ['--version'])
      return (espeakBinary = candidate)
    } catch {
      // try the next one
    }
  }
  return (espeakBinary = null)
}

export async function voices(engine: 'espeak' | 'piper', piperModel: string): Promise<TtsVoice[]> {
  if (engine === 'piper') {
    if (!piperModel) return []
    try {
      const dir = dirname(piperModel)
      const models = (await readdir(dir)).filter(name => name.endsWith('.onnx')).sort()
      return models.map(name => ({
        id: join(dir, name),
        name: basename(name, '.onnx'),
        language: name.split('-')[0].replace('_', '-'),
      }))
    } catch {
      return []
    }
  }
  const binary = await findEspeak()
  if (!binary) return []
  try {
    const { stdout } = await run(binary, ['--voices'])
    // Pty Language Age/Gender VoiceName File Other Languages
    return stdout
      .toString('utf8')
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/))
      .filter(columns => columns.length >= 5)
      // The voice file is the one unambiguous name: several voices can share a language.
      .map(columns => ({ id: columns[4], name: columns[3].replace(/_/g, ' '), language: columns[1] }))
  } catch {
    return []
  }
}

export async function speak(
  engine: 'espeak' | 'piper',
  text: string,
  opts: { voice: string; rate: number },
  piper: { path: string; model: string },
): Promise<Uint8Array> {
  const input = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!input) return new Uint8Array()
  const rate = Math.min(3, Math.max(0.3, Number(opts.rate) || 1))

  if (engine === 'piper') {
    const named = opts.voice || piper.model
    if (!named) throw new Error('No Piper voice model is configured')
    // A model is a file: as a full path it cannot be read as one of Piper's options.
    const model = resolve(named)
    // (an unguessable name: /tmp is shared with every other program)
    const out = join(tmpdir(), `bookviewer-tts-${randomUUID()}.wav`)
    try {
      await run(
        piper.path || 'piper',
        ['--model', model, '--output_file', out, '--length_scale', (1 / rate).toFixed(3)],
        input,
      )
      return new Uint8Array(await readFile(out))
    } finally {
      await rm(out, { force: true })
    }
  }

  const binary = await findEspeak()
  if (!binary) throw new Error('espeak-ng is not installed')
  const args = ['--stdout', '--stdin', '-s', String(Math.round(175 * rate))]
  // Voice names come from `--voices`; refuse anything that could be read as an option.
  if (opts.voice && /^[\w+/-]+$/.test(opts.voice) && !opts.voice.startsWith('-'))
    args.push('-v', opts.voice)
  const { stdout } = await run(binary, args, input)
  return new Uint8Array(fixWavHeader(stdout))
}
