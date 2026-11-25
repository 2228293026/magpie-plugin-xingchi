import { parseTurnFeedback } from "./turn-limits.mjs"

const MAX_PREFIX_BYTES = 64 * 1024

class StreamLimits {
  decoder = new TextDecoder()
  text = ""
  started = false
  ended = false
  limit
  feedback
  errorCode

  push(chunk, final = false) {
    this.text += this.decoder.decode(chunk, { stream: !final })
    if (final) this.text += "\n\n"
    let boundary
    while ((boundary = this.text.match(/\r?\n\r?\n/))) {
      const block = this.text.slice(0, boundary.index)
      this.text = this.text.slice(boundary.index + boundary[0].length)
      if (block.length > MAX_PREFIX_BYTES) continue
      const lines = block.split(/\r?\n/)
      const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim()
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
      let payload
      try { payload = JSON.parse(data) } catch { continue }
      const type = payload?.type ?? event
      if (type === "response.failed" || type === "error") {
        const error = payload?.response?.error ?? payload?.error ?? payload
        if (typeof error?.code === "string") this.errorCode = error.code
        const feedback = parseTurnFeedback(payload)
        if (feedback !== undefined) {
          this.feedback = feedback
          this.limit = feedback.limit
        }
        this.ended = true
      } else if (type === "response.completed" || type === "response.incomplete") {
        this.ended = true
      } else if (type && type !== "response.created" && type !== "response.in_progress" && type !== "ping") {
        this.started = true
      }
      if (payload?.response?.output?.length) this.started = true
    }
    if (this.text.length > MAX_PREFIX_BYTES) this.text = ""
  }
}

// Only the short stream prelude is held. Once output is available, every byte is forwarded in order.
export async function inspectStreamTurnLimit(response, onLimit, { peek = true, startupTimeoutMs = 1000 } = {}) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return { response }
  }
  const reader = response.body.getReader()
  const scanner = new StreamLimits()
  const prefix = []
  let pending
  let finished = false
  let bytes = 0
  let observed
  const remember = async () => {
    if (scanner.feedback === undefined) return
    const signature = JSON.stringify(scanner.feedback)
    if (signature === observed) return
    observed = signature
    try { await onLimit?.(scanner.feedback.limit ?? scanner.feedback.rejectedAt, scanner.feedback) } catch {}
  }
  const release = () => { try { reader.releaseLock() } catch {} }
  try {
    if (peek) {
      const deadline = Date.now() + startupTimeoutMs
      while (!scanner.started && !scanner.ended && bytes < MAX_PREFIX_BYTES) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        pending = reader.read()
        pending.catch(() => {})
        let timer
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining) })
        let chunk
        try { chunk = await Promise.race([pending, timeout]) } finally { clearTimeout(timer) }
        if (chunk === null) break
        pending = undefined
        if (chunk.done) {
          finished = true
          scanner.push(undefined, true)
          break
        }
        const inspected = chunk.value.subarray(0, MAX_PREFIX_BYTES - bytes)
        const remainder = chunk.value.subarray(inspected.byteLength)
        prefix.push(inspected)
        bytes += inspected.byteLength
        scanner.push(inspected)
        if (remainder.byteLength) pending = Promise.resolve({ done: false, value: remainder })
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    release()
    throw error
  }

  const limit = peek && !scanner.started ? scanner.limit : undefined
  const feedback = peek && !scanner.started ? scanner.feedback : undefined
  const errorCode = peek && !scanner.started ? scanner.errorCode : undefined
  if (feedback !== undefined) observed = JSON.stringify(feedback) // The caller records this before deciding whether to retry.
  else await remember()
  let index = 0
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (index < prefix.length) {
          const value = prefix[index]
          prefix[index++] = undefined
          controller.enqueue(value)
          return
        }
        if (finished) {
          release()
          controller.close()
          return
        }
        const next = pending ?? reader.read()
        pending = undefined
        const chunk = await next
        if (chunk.done) {
          finished = true
          scanner.push(undefined, true)
          await remember()
          release()
          controller.close()
        } else {
          scanner.push(chunk.value)
          await remember()
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        controller.error(error)
        await reader.cancel(error).catch(() => {})
        release()
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
      release()
    },
  })
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const name of ["url", "redirected", "type"]) Object.defineProperty(wrapped, name, { value: response[name] })
  return { response: wrapped, limit, feedback, errorCode }
}
