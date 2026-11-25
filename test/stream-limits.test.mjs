import { expect, test } from "bun:test"
import { XingchiPlugin } from "../index.mjs"
import { inspectStreamTurnLimit } from "../stream-limits.mjs"

const encoder = new TextEncoder()
const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
const created = event("response.created", { response: { id: "rejected", status: "in_progress", output: [] } })
const completed = event("response.completed", { response: { id: "accepted", status: "completed", output: [] } })
const added = event("response.output_item.added", { item: { type: "message", id: "message" } })
const failure = (limit, code = "session_turn_limit_exceeded") => event("response.failed", {
  response: { status: "failed", error: { code, message: `当前会话已满 ${limit} 轮对话` } },
})
const response = (body, status = 200) => new Response(body, {
  status, headers: { "content-type": "text/event-stream", "x-request-id": "preserved" },
})

async function withFetch(transport, check) {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => transport(JSON.parse(String(init.body)), init)
  try { await check() } finally { globalThis.fetch = original }
}

async function client(options = {}) {
  const plugin = await XingchiPlugin({ client: {} }, options)
  return await plugin.auth.loader(async () => ({ type: "api", key: "sk-stream" }))
}

function send(loader, turns = 21, stream = true) {
  const input = Array.isArray(turns) ? turns : []
  if (!Array.isArray(turns)) {
    for (let turn = 1; turn <= turns; turn++) {
      input.push({ role: "user", content: `Question ${turn}` })
      if (turn < turns) input.push({ role: "assistant", content: `Answer ${turn}` })
    }
  }
  return loader.fetch("https://api.xingchiapi.com/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", input, stream }),
  })
}

function toolHistory(count = 105) {
  const input = [{ role: "user", content: "Continue this task without repeating completed tools." }]
  for (let turn = 1; turn <= count; turn++) {
    input.push({ type: "function_call", call_id: `call_${turn}`, name: "record", arguments: "{}" })
    input.push({ type: "function_call_output", call_id: `call_${turn}`, output: `Recorded ${turn}` })
  }
  return input
}

const modelFailure = count => event("response.failed", {
  response: { status: "failed", error: { code: "session_turn_limit_exceeded",
    message: `当前会话模型已回复 ${count} 轮，达到上限。This conversation has reached ${count} model turns.`,
  } },
})

test.each([200, 400])("SSE HTTP %s 的模型回复计数可重试，同一用户任务不会被漏过", async status => {
  const sent = []
  let cancelled = 0
  await withFetch(body => {
    sent.push(body.input.filter(item => item.type === "function_call").length)
    return sent.length > 1 ? response(added + completed) : response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(created + modelFailure(105))) },
      cancel() { cancelled++ },
    }), status)
  }, async () => {
    expect(await (await send(await client(), toolHistory())).text()).toBe(added + completed)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(105)
    expect(sent[1]).toBeLessThan(100)
    expect(cancelled).toBe(1)
  })
})

test("已经输出的模型超限流不重放，下一次请求使用模型预算", async () => {
  const first = created + added + modelFailure(105)
  const sent = []
  await withFetch(body => {
    sent.push(body.input.filter(item => item.type === "function_call").length)
    return response(sent.length === 1 ? first : added + completed)
  }, async () => {
    const loader = await client()
    expect(await (await send(loader, toolHistory())).text()).toBe(first)
    expect(sent).toEqual([105])
    expect(await (await send(loader, toolHistory())).text()).toBe(added + completed)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBeLessThan(100)
  })
})

test.each([200, 400])("SSE HTTP %s 开头的明确超限自动重试，拒绝帧不转发且原流被取消", async status => {
  const sent = []
  let cancelled = 0
  await withFetch(body => {
    sent.push(body.input.filter(item => item.role === "user").length)
    if (sent.length === 1) {
      return response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(created + failure(20))) },
        cancel() { cancelled++ },
      }), status)
    }
    return response(added + completed)
  }, async () => {
    const result = await send(await client())
    expect(result.status).toBe(200)
    expect(await result.text()).toBe(added + completed)
    expect(result.headers.get("x-request-id")).toBe("preserved")
    expect(sent).toEqual([21, 16])
    expect(cancelled).toBe(1)
  })
})

test("已输出的 SSE 不重放，晚到的上限用于下一次请求", async () => {
  const sent = []
  const first = created + added + event("response.output_text.delta", { delta: "partial" }) + failure(20)
  await withFetch(body => {
    sent.push(body.input.filter(item => item.role === "user").length)
    return response(sent.length === 1 ? first : added + completed)
  }, async () => {
    const loader = await client()
    expect(await (await send(loader)).text()).toBe(first)
    expect(sent).toEqual([21])
    expect(await (await send(loader)).text()).toBe(added + completed)
    expect(sent).toEqual([21, 16])
  })
})

test("后续块中的限轮错误也会被观察，不重新发送已经开始的工具调用", async () => {
  const sent = []
  const tool = event("response.output_item.added", { item: { type: "function_call", call_id: "tool" } })
  await withFetch(body => {
    sent.push(body.input.filter(item => item.role === "user").length)
    if (sent.length > 1) return response(completed)
    return response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(created + tool))
      controller.enqueue(encoder.encode(failure(20)))
      controller.close()
    } }))
  }, async () => {
    const loader = await client()
    expect(await (await send(loader)).text()).toBe(created + tool + failure(20))
    expect(sent).toEqual([21])
    await (await send(loader)).text()
    expect(sent).toEqual([21, 16])
  })
})

test("普通 SSE 上游错误及助手文本里的伪错误不会变成轮次上限", async () => {
  for (const first of [created + failure(20, "upstream_error"),
    added + event("response.output_text.delta", { delta: failure(20) }) + completed]) {
    const sent = []
    await withFetch(body => {
      sent.push(body.input.filter(item => item.role === "user").length)
      return response(sent.length === 1 ? first : completed)
    }, async () => {
      const loader = await client()
      expect(await (await send(loader)).text()).toBe(first)
      await (await send(loader)).text()
      expect(sent).toEqual([21, 21])
    })
  }
})

test("分块 UTF-8、CRLF 及多行 data 的失败帧可以解析，字节仍完整保留", async () => {
  const raw = "event: response.failed\r\ndata: {\"response\":\r\ndata: {\"error\":{\"code\":\"session_turn_limit_exceeded\",\"message\":\"已满 20 轮 中文😀\"}}}\r\n\r\n"
  const bytes = encoder.encode(raw)
  const original = response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7))
    controller.close()
  } }))
  const inspected = await inspectStreamTurnLimit(original)
  expect(inspected.limit).toBe(20)
  expect(await inspected.response.text()).toBe(raw)
  expect(inspected.response.url).toBe(original.url)
  expect(inspected.response.type).toBe(original.type)
})

test("输出条目开始后立即返回，不等整个模型流完成", async () => {
  let controller
  const original = response(new ReadableStream({ start(value) {
    controller = value
    controller.enqueue(encoder.encode(created + added))
  } }))
  const inspected = await inspectStreamTurnLimit(original)
  controller.enqueue(encoder.encode(completed))
  controller.close()
  expect(await inspected.response.text()).toBe(created + added + completed)
})

test("流开头长时间没有输出时有等待上限，未完成读取不会丢块", async () => {
  let controller
  const original = response(new ReadableStream({ start(value) {
    controller = value
    controller.enqueue(encoder.encode(created))
  } }))
  const started = Date.now()
  const inspected = await inspectStreamTurnLimit(original, undefined, { startupTimeoutMs: 25 })
  expect(Date.now() - started).toBeLessThan(500)
  controller.enqueue(encoder.encode(added + completed))
  controller.close()
  expect(await inspected.response.text()).toBe(created + added + completed)
})

test("等待上限到达后的客户端取消仍取消底层挂起读取并释放锁", async () => {
  let cancelled
  const original = response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(created)) },
    cancel(reason) { cancelled = reason },
  }))
  const inspected = await inspectStreamTurnLimit(original, undefined, { startupTimeoutMs: 10 })
  await inspected.response.body.cancel("client-cancelled")
  expect(cancelled).toBe("client-cancelled")
  expect(original.body.locked).toBe(false)
})

test("预读发生错误时释放底层锁，不吞掉错误", async () => {
  const error = new Error("upstream aborted")
  const original = response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(created))
    setTimeout(() => controller.error(error), 5)
  } }))
  await expect(inspectStreamTurnLimit(original)).rejects.toThrow("upstream aborted")
  expect(original.body.locked).toBe(false)
})

test("过大的开头受字节上限约束，正常内容仍逐字节透传", async () => {
  const raw = `event: ping\ndata: ${JSON.stringify({ note: "x".repeat(70000) })}\n\n` + added + completed
  const inspected = await inspectStreamTurnLimit(response(raw))
  expect(inspected.limit).toBeUndefined()
  expect(await inspected.response.text()).toBe(raw)
})

test.each([false, true])("HTTP 200 JSON 失败也学习上限，有输出时不重试=%s", async hasOutput => {
  const sent = []
  await withFetch(body => {
    sent.push(body.input.filter(item => item.role === "user").length)
    if (sent.length > 1) return Response.json({ status: "completed", output: [] })
    return Response.json({ status: "failed", error: {
      code: "session_turn_limit_exceeded", message: "已满 20 轮",
    }, output: hasOutput ? [{ type: "function_call", call_id: "already-produced" }] : [] })
  }, async () => {
    const loader = await client()
    const result = await send(loader, 21, false)
    expect((await result.json()).status).toBe(hasOutput ? "failed" : "completed")
    expect(sent).toEqual(hasOutput ? [21] : [21, 16])
    if (hasOutput) {
      await (await send(loader, 21, false)).json()
      expect(sent).toEqual([21, 16])
    }
  })
})

for (const [name, note] of [["ASCII", "x".repeat(70000)], ["UTF-8", "汉".repeat(24000)]]) {
  test(`64 KiB 之外同一块内的超限只用于下一次请求：${name}`, async () => {
    const raw = event("ping", { note }) + failure(20)
    const sent = []
    await withFetch(body => {
      sent.push(body.input.filter(item => item.role === "user").length)
      return response(sent.length === 1 ? raw : completed)
    }, async () => {
      const loader = await client()
      const text = await (await send(loader)).text()
      expect(sent).toEqual([21])
      expect(text).toBe(raw)
      await (await send(loader)).text()
      expect(sent).toEqual([21, 16])
    })
  })
}

test("HTTP 400 SSE 无可用轮数时不等待 EOF，失败帧保持完整", async () => {
  let controller
  const raw = created + event("response.failed", { response: { status: "failed", error: {
    code: "session_turn_limit_exceeded", message: "Please start a new session",
  } } })
  await withFetch(() => response(new ReadableStream({ start(value) {
    controller = value
    controller.enqueue(encoder.encode(raw))
  } }), 400), async () => {
    const pending = send(await client())
    let timer
    const returned = await Promise.race([
      pending.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 250) }),
    ])
    clearTimeout(timer)
    controller.close()
    const result = await pending
    const text = await result.text()
    expect(returned).toBe(true)
    expect(result.status).toBe(400)
    expect(text).toBe(raw)
  })
})

test("关闭封装时，明确的 HTTP 403 SSE UA 拒绝仍能回退一次", async () => {
  const uas = []
  await withFetch((_body, init) => {
    uas.push(new Headers(init.headers).get("user-agent"))
    return uas.length === 1 ? response(event("error", { error: { code: "client_not_allowed" } }), 403)
      : response(completed)
  }, async () => {
    const loader = await client({ historyPacking: false, userAgent: "claude" })
    expect(await (await send(loader, 2)).text()).toBe(completed)
    expect(uas).toHaveLength(2)
    expect(uas[0]).toStartWith("claude-cli/")
    expect(uas[1]).toStartWith("opencode/")
  })
})

test("HTTP 403 JSON 已有模型输出时不因 UA 拒绝重新发送", async () => {
  let calls = 0
  const output = [{ type: "function_call", call_id: "already-produced" }]
  await withFetch(() => {
    calls++
    return Response.json({ error: { code: "client_not_allowed" }, output }, { status: 403 })
  }, async () => {
    const result = await send(await client({ userAgent: "claude" }), 2)
    expect(result.status).toBe(403)
    expect((await result.json()).output).toEqual(output)
    expect(calls).toBe(1)
  })
})
