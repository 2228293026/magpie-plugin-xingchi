// All smoke subprocess traffic stays inside this mock.
let awaitingUaFallback = false
globalThis.fetch = async (url, init) => {
  const path = new URL(String(url)).pathname
  if (path.endsWith("/models")) {
    return Response.json({ data: [{ id: "smoke-test-model" }] })
  }
  if (path.endsWith("/usage")) {
    return Response.json({ balance: 100, remaining: 100, unit: "USD" })
  }
  if (!path.endsWith("/responses")) throw new Error(`Unexpected mock URL: ${url}`)
  const body = JSON.parse(String(init?.body))
  const headers = new Headers(init?.headers)
  if (headers.get("user-agent")?.startsWith("zzz/")) {
    awaitingUaFallback = true
    return Response.json({ error: { code: "client_not_allowed" } }, { status: 403 })
  }
  if (awaitingUaFallback) {
    awaitingUaFallback = false
    if (process.env.XINGCHI_SMOKE_TEST_FALLBACK_FAILED) {
      return Response.json({ error: { message: "Fallback upstream unavailable" } }, { status: 503 })
    }
  }
  // Capability probes succeed so the requested status exercises the smoke requests.
  if (body.input === "probe") return Response.json({ output: [{ type: "function_call" }] })
  const status = Number(process.env.XINGCHI_SMOKE_TEST_STATUS ?? 200)
  if (status !== 200) return Response.json({ error: { message: "Simulated upstream failure" } }, { status })
  if (body.stream) {
    const event = process.env.XINGCHI_SMOKE_TEST_STREAM_FAILED ? "response.failed" : "response.completed"
    return new Response(`event: ${event}\ndata: {}\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })
}
