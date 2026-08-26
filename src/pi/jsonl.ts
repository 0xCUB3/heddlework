import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export class JsonlDecoder {
  readonly #decoder = new StringDecoder('utf8')
  #buffer = ''

  push(chunk: string | Uint8Array): string[] {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk))
    const lines: string[] = []
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      lines.push(stripCarriageReturn(this.#buffer.slice(0, newline)))
      this.#buffer = this.#buffer.slice(newline + 1)
    }
    return lines
  }

  finish(): string[] {
    this.#buffer += this.#decoder.end()
    if (!this.#buffer) return []
    const line = stripCarriageReturn(this.#buffer)
    this.#buffer = ''
    return [line]
  }
}

export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new JsonlDecoder()
  const onData = (chunk: string | Uint8Array) => {
    for (const line of decoder.push(chunk)) onLine(line)
  }
  const onEnd = () => {
    for (const line of decoder.finish()) onLine(line)
  }
  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
