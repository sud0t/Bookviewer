import type { Settings, TtsVoice } from '@shared/types'
import type { Engine, SpeechSegment } from '../engines/types'
import { ipc } from '../lib/ipc'

type Provider = 'system' | 'espeak' | 'piper'

/** Reads a book aloud, sentence by sentence, following along in the text. */
export class Speaker {
  state = $state<'idle' | 'loading' | 'playing' | 'paused'>('idle')
  error = $state('')
  provider = $state<Provider>('system')
  voices = $state<TtsVoice[]>([])

  private engine: Engine | null = null
  private batches: AsyncGenerator<SpeechSegment[]> | null = null
  private segments: SpeechSegment[] = []
  private position = 0
  private run = 0
  private audio: HTMLAudioElement | null = null
  private audioUrl: string | null = null
  private clips = new Map<SpeechSegment, Promise<Uint8Array>>()
  /** The batch being fetched; shared so that a restarted loop does not skip it. */
  private pending: Promise<IteratorResult<SpeechSegment[]>> | null = null

  constructor(private settings: () => Settings) {}

  get active(): boolean {
    return this.state !== 'idle'
  }

  private systemVoices(): SpeechSynthesisVoice[] {
    return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices()
  }

  /** Chromium fills in its voice list lazily: the first call may come back empty. */
  private async loadSystemVoices(): Promise<SpeechSynthesisVoice[]> {
    const voices = this.systemVoices()
    if (voices.length || typeof speechSynthesis === 'undefined') return voices
    await new Promise<void>(resolve => {
      const finish = () => {
        speechSynthesis.removeEventListener('voiceschanged', finish)
        resolve()
      }
      speechSynthesis.addEventListener('voiceschanged', finish)
      setTimeout(finish, 400)
    })
    return this.systemVoices()
  }

  /** Works out which engine can actually speak, preferring the configured one. */
  async prepare(): Promise<boolean> {
    const wanted = this.settings().ttsEngine
    const order: Provider[] = [wanted, 'system', 'espeak', 'piper']
    for (const provider of new Set(order)) {
      if (provider === 'system') {
        const voices = await this.loadSystemVoices()
        if (!voices.length) continue
        this.voices = voices.map(v => ({ id: v.voiceURI, name: v.name, language: v.lang }))
      } else {
        const voices = await ipc.invoke('tts:voices', provider).catch(() => [])
        if (!voices.length) continue
        this.voices = voices
      }
      this.provider = provider
      return true
    }
    this.error =
      'No speech engine was found. Install espeak-ng (or set up speech-dispatcher or Piper) to use read-aloud.'
    return false
  }

  async start(engine: Engine): Promise<void> {
    this.stop()
    this.error = ''
    this.state = 'loading'
    const run = ++this.run
    const ready = await this.prepare()
    // stopped (or started again) while looking for a voice
    if (run !== this.run) return
    if (!ready) {
      this.state = 'idle'
      return
    }
    this.engine = engine
    this.batches = engine.speech()
    this.segments = []
    this.position = 0
    void this.loop(++this.run)
  }

  private async loop(run: number): Promise<void> {
    try {
      while (run === this.run) {
        if (this.position >= this.segments.length) {
          if (!this.batches) break
          const fetching = (this.pending ??= this.batches.next())
          const next = await fetching
          // A loop that was superseded while waiting leaves the batch for its successor.
          if (run !== this.run) return
          if (this.pending === fetching) this.pending = null
          if (next.done) break
          // Earlier batches are dropped: "previous" stays within the section.
          this.segments = next.value
          this.position = 0
          this.clips.clear()
          continue
        }
        const segment = this.segments[this.position]
        segment.show()
        this.state = this.state === 'paused' ? 'paused' : 'playing'
        await this.speak(segment, run)
        if (run !== this.run) return
        this.position++
      }
    } catch (error) {
      if (run !== this.run) return
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (run === this.run) this.stop()
  }

  private voiceFor(language: string): string {
    const { ttsVoice } = this.settings()
    if (ttsVoice && this.voices.some(voice => voice.id === ttsVoice)) return ttsVoice
    if (this.provider === 'piper') return ''
    // No explicit choice: pick a voice for the book's language.
    const base = language.toLowerCase().split('-')[0]
    const match =
      this.voices.find(voice => voice.language.toLowerCase() === language.toLowerCase()) ??
      this.voices.find(voice => voice.language.toLowerCase().split('-')[0] === base)
    return match?.id ?? ''
  }

  private synthesize(segment: SpeechSegment): Promise<Uint8Array> {
    let clip = this.clips.get(segment)
    if (!clip) {
      clip = ipc.invoke('tts:speak', this.provider as 'espeak' | 'piper', segment.text, {
        voice: this.voiceFor(segment.language),
        rate: this.settings().ttsRate,
      })
      this.clips.set(segment, clip)
    }
    return clip
  }

  private speak(segment: SpeechSegment, run: number): Promise<void> {
    if (this.provider === 'system') {
      return new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(segment.text)
        const id = this.voiceFor(segment.language)
        const voice = this.systemVoices().find(v => v.voiceURI === id)
        if (voice) utterance.voice = voice
        utterance.lang = voice?.lang ?? segment.language
        utterance.rate = this.settings().ttsRate
        utterance.onend = () => resolve()
        utterance.onerror = event =>
          event.error === 'canceled' || event.error === 'interrupted'
            ? resolve()
            : reject(new Error(`Speech failed: ${event.error}`))
        speechSynthesis.speak(utterance)
      })
    }
    return (async () => {
      const bytes = await this.synthesize(segment)
      if (run !== this.run) return
      // Have the next sentence ready by the time this one ends.
      const upcoming = this.segments[this.position + 1]
      if (upcoming) void this.synthesize(upcoming).catch(() => {})
      this.clips.delete(segment)
      if (!bytes.length) return
      await new Promise<void>((resolve, reject) => {
        this.releaseAudio()
        this.audioUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }))
        const audio = new Audio(this.audioUrl)
        this.audio = audio
        audio.onended = () => {
          if (this.audio === audio) this.audio = null
          resolve()
        }
        audio.onerror = () => reject(new Error('Could not play the synthesized speech'))
        // `stop()` and `skip()` end playback by pausing with this flag set.
        audio.onpause = () => {
          if (audio.dataset.cancelled) resolve()
        }
        // Pausing before playback has begun rejects play() with an AbortError;
        // that is not a failure.
        if (this.state !== 'paused')
          void audio.play().catch(error => {
            if ((error as Error)?.name !== 'AbortError') reject(error)
          })
      })
    })()
  }

  private releaseAudio(): void {
    if (this.audio) {
      this.audio.dataset.cancelled = '1'
      this.audio.pause()
      this.audio = null
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl)
    this.audioUrl = null
  }

  private interrupt(): void {
    this.run++
    if (this.provider === 'system') speechSynthesis.cancel()
    this.releaseAudio()
  }

  pause(): void {
    if (this.state !== 'playing') return
    this.state = 'paused'
    // Web Speech cannot reliably pause mid-utterance on Linux; the sentence
    // is simply read again from its start on resume.
    if (this.provider === 'system') this.interrupt()
    else this.audio?.pause()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'playing'
    if (this.provider === 'system' || !this.audio) void this.loop(++this.run)
    else void this.audio.play()
  }

  toggle(): void {
    if (this.state === 'playing') this.pause()
    else if (this.state === 'paused') this.resume()
  }

  /** Moves to the next (1) or previous (-1) sentence. */
  skip(delta: 1 | -1): void {
    if (!this.active) return
    this.interrupt()
    this.position = Math.max(0, this.position + delta)
    if (this.state === 'paused') this.state = 'playing'
    void this.loop(this.run)
  }

  /** Restarts the current sentence, e.g. after the rate or voice changed. */
  refresh(): void {
    if (this.state !== 'playing') return
    this.clips.clear()
    this.interrupt()
    void this.loop(this.run)
  }

  stop(): void {
    this.interrupt()
    void this.batches?.return(undefined)
    this.batches = null
    this.pending = null
    this.segments = []
    this.clips.clear()
    this.engine?.clearSpeechMark()
    this.engine = null
    this.state = 'idle'
  }
}
