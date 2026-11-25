import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { XingchiPlugin, _internal } from "../index.mjs"
import { packResponsesHistory } from "../history.mjs"
import { createTurnLimitCache, turnLimitScope, TURN_LIMIT_TTL_MS } from "../turn-limits.mjs"

const base = "https://api.xingchiapi.com/v1"
const model = "gpt-6.1-sol"
const auth = { type: "api", key: "sk-adaptive" }
const userCount = input => input.filter(item => item?.role === "user").length
const exceeded = limit => Response.json({ error: {
  code: "session_turn_limit_exceeded", message: `This conversation has reached ${limit} turns.`,
} }, { status: 400 })

function conversation(turns) {
  const input = []
  for (let turn = 1; turn <= turns; turn++) {
    input.push({ role: "user", content: `Question ${turn} 原文` })
    if (turn < turns) input.push({ role: "assistant", content: `Answer ${turn}` })
  }
  return input
}

function toolConversation(turns) {
  const input = [{ role: "user", content: "Keep project=tool-heavy 原文 and retry_limit=7. All recorded tools completed." }]
  for (let turn = 1; turn <= turns; turn++) {
    input.push({ type: "function_call", id: `fc_tool_${turn}`, call_id: `call_tool_${turn}`,
      name: "record_step", arguments: JSON.stringify({ step: turn }) })
    input.push({ type: "function_call_output", call_id: `call_tool_${turn}`, output: `Completed step ${turn} 原文` })
  }
  input.push({ role: "user", content: "Continue the same task without repeating completed tools." })
  return input
}

function reconstruct(input) {
  return [...JSON.parse(input[0].content[1].text), ...input.slice(1)]
}

async function loader(options = {}, account = auth, directory) {
  const plugin = await XingchiPlugin({ client: {}, directory }, options)
  return await plugin.auth.loader(async () => account)
}

async function withFetch(transport, check) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => transport(url, init,
    JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)))
  try { await check() } finally { globalThis.fetch = original }
}

function send(client, turns, options = {}) {
  const text = JSON.stringify({ input: Array.isArray(turns) ? turns : conversation(turns),
    model: options.model ?? model, store: true, previous_response_id: "resp_removed", instructions: "original" })
  return client.fetch(options.url ?? `${base}/responses`, {
    method: "POST", headers: { "content-type": "application/json", ...options.headers },
    body: options.binary ? new TextEncoder().encode(text) : text,
  })
}

async function withDirectory(check) {
  const directory = await mkdtemp(join(tmpdir(), "xingchi-adaptive-"))
  try { await check(directory) } finally {
    const target = await realpath(directory)
    const within = relative(await realpath(tmpdir()), target)
    if (isAbsolute(within) || within.startsWith("..") || !within.startsWith("xingchi-adaptive-")) {
      throw new Error("Fixture cleanup escaped its temporary directory")
    }
    await rm(target, { recursive: true, force: true })
  }
}

test("未知上限保持原历史，封装接受动态上限及很小的上限", () => {
  const input = conversation(51)
  expect(packResponsesHistory(input)).toBe(input)
  expect(userCount(packResponsesHistory(input, 20))).toBe(16)
  expect(userCount(packResponsesHistory(input, 10))).toBe(6)
  expect(packResponsesHistory(input, 100)).toBe(input)
  expect(userCount(packResponsesHistory(conversation(3), 2))).toBe(2)
  const two = conversation(2)
  expect(packResponsesHistory(two, 1)).toBe(two)
  const normalized = JSON.parse(_internal.normalizeResponsesBody(JSON.stringify({ input })))
  expect(normalized.input).toEqual(input)
})

test("第一次超限学习上限并重试，下一次直接按已知上限封装", async () => {
  const sent = []
  await withFetch((_url, _init, body) => {
    sent.push(body)
    return userCount(body.input) > 20 ? exceeded(20) : Response.json({ output: [] })
  }, async () => {
    const client = await loader()
    const input = conversation(21)
    const before = structuredClone(input)
    expect((await send(client, input)).status).toBe(200)
    expect(sent.map(body => userCount(body.input))).toEqual([21, 16])
    expect(reconstruct(sent[1].input)).toEqual(input)
    expect(input).toEqual(before)
    expect(sent[1].instructions).toBe("original")
    expect(sent[1].store).toBe(false)
    expect(sent[1].previous_response_id).toBeUndefined()
    expect((await send(client, input)).status).toBe(200)
    expect(sent.map(body => userCount(body.input))).toEqual([21, 16, 16])
  })
})

test("只有两条用户消息的 105 次模型工具回复也能动态合并并保留全部原文", async () => {
  const sent = []
  const input = toolConversation(105)
  const before = structuredClone(input)
  await withFetch((_url, _init, body) => {
    sent.push(body.input)
    const replies = body.input.filter(item => item.type === "function_call").length
    return replies >= 100 ? Response.json({ error: { code: "session_turn_limit_exceeded",
      message: `当前会话模型已回复 ${replies} 轮，达到上限。This conversation has reached ${replies} model turns. Run /compact to continue.`,
    } }, { status: 400 }) : Response.json({ status: "completed", output: [] })
  }, async () => {
    const client = await loader()
    expect((await send(client, input)).status).toBe(200)
    expect(sent).toHaveLength(2)
    expect(sent[1].filter(item => item.type === "function_call").length).toBeLessThan(100)
    expect(reconstruct(sent[1])).toEqual(input)
    expect(input).toEqual(before)
    expect((await send(client, input)).status).toBe(200)
    expect(sent).toHaveLength(3)
  })
})

test("单个用户任务也能重试模型超限，二进制请求和重启后的预算均保留", async () => {
  await withDirectory(async directory => {
    const input = toolConversation(105).slice(0, -1)
    const sent = []
    await withFetch((_url, init, body) => {
      sent.push({ input: body.input, binary: init.body instanceof Uint8Array })
      const replies = body.input.filter(item => item.type === "function_call").length
      return replies >= 100 ? Response.json({ error: { code: "session_turn_limit_exceeded",
        message: "This conversation has reached 105 model turns. Run /compact.",
      } }, { status: 400 }) : Response.json({ status: "completed", output: [] })
    }, async () => {
      expect((await send(await loader({}, auth, directory), input, { binary: true })).status).toBe(200)
      expect(sent).toHaveLength(2)
      expect(sent.every(row => row.binary)).toBe(true)
      expect(reconstruct(sent[1].input)).toEqual(input)
      expect((await send(await loader({}, auth, directory), input)).status).toBe(200)
      expect(sent).toHaveLength(3)
      const cache = createTurnLimitCache(directory)
      expect(await cache.get(turnLimitScope(base, auth.key, model))).toBeUndefined()
      expect(await cache.get(turnLimitScope(base, auth.key, model, "model"))).toBeLessThan(100)
    })
  })
})

test("模型预算到期后恢复原生历史，成功请求不永久锁住较小预算", async () => {
  await withDirectory(async directory => {
    const scope = turnLimitScope(base, auth.key, model, "model")
    const old = createTurnLimitCache(directory, { now: () => Date.now() - TURN_LIMIT_TTL_MS - 1 })
    await old.remember(scope, 10, "model")
    const input = toolConversation(105)
    const sent = []
    await withFetch((_url, _init, body) => {
      sent.push(body.input)
      return Response.json({ status: "completed", output: [] })
    }, async () => {
      expect((await send(await loader({}, auth, directory), input)).status).toBe(200)
      expect(sent).toEqual([input])
      expect(await createTurnLimitCache(directory).get(scope)).toBeUndefined()
    })
  })
})

test("结构化模型上限可合并全部已完成模型历史，关闭合并时不重试", async () => {
  const input = toolConversation(5)
  for (const enabled of [true, false]) {
    const sent = []
    await withFetch((_url, _init, body) => {
      sent.push(body.input)
      return body.input.some(item => item.type === "function_call") ? Response.json({
        error: { code: "session_turn_limit_exceeded", max_model_turns: 1 },
      }, { status: 400 }) : Response.json({ status: "completed", output: [] })
    }, async () => {
      expect((await send(await loader({ historyPacking: enabled }), input)).status).toBe(enabled ? 200 : 400)
      expect(sent).toHaveLength(enabled ? 2 : 1)
      if (enabled) expect(reconstruct(sent[1])).toEqual(input)
      else expect(sent[0]).toEqual(input)
    })
  }
})

test("JSON 失败封套已有模型工具输出时只学习预算，不重新发送", async () => {
  const failure = { type: "response.failed", response: { status: "failed",
    output: [{ type: "function_call", call_id: "already_started", name: "write_file", arguments: "{}" }],
    error: { code: "session_turn_limit_exceeded", message: "This conversation has reached 105 model turns." },
  } }
  let calls = 0
  await withFetch(() => { calls++; return Response.json(failure, { status: 400 }) }, async () => {
    const result = await send(await loader(), toolConversation(105))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual(failure)
    expect(calls).toBe(1)
  })
})

test("同通道并发拒绝保留较小模型预算，迟到的较大计数不会覆盖", async () => {
  const sent = []
  const pending = []
  let ready
  const bothSent = new Promise(resolve => { ready = resolve })
  await withFetch((_url, _init, body) => {
    sent.push(body.input.filter(item => item.type === "function_call").length)
    if (pending.length < 2) return new Promise(resolve => {
      pending.push(resolve)
      if (pending.length === 2) ready()
    })
    return Response.json({ status: "completed", output: [] })
  }, async () => {
    const client = await loader()
    const first = send(client, toolConversation(105))
    const second = send(client, toolConversation(105))
    await bothSent
    for (const [index, count] of [[0, 10], [1, 100]]) pending[index](Response.json({ error: {
      code: "session_turn_limit_exceeded", message: `This conversation has reached ${count} model turns.`,
    } }, { status: 400 }))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await send(client, toolConversation(30))).status).toBe(200)
    expect(sent.slice(2).every(count => count <= 5)).toBe(true)
  })
})

test("上限从 20 降到 10 时按原始请求重新封装，不丢失原文", async () => {
  let limit = 20
  const sent = []
  await withFetch((_url, _init, body) => {
    sent.push(body)
    return userCount(body.input) > limit ? exceeded(limit) : Response.json({ output: [] })
  }, async () => {
    const client = await loader()
    expect((await send(client, 21)).status).toBe(200)
    limit = 10
    expect((await send(client, 21)).status).toBe(200)
    expect(sent.map(body => userCount(body.input))).toEqual([21, 16, 16, 6])
    expect(reconstruct(sent.at(-1).input)).toEqual(conversation(21))
  })
})

test("旧缓存失效后允许上限提高到 100，不再固定封装 20 轮以上的历史", async () => {
  await withDirectory(async directory => {
    const scope = turnLimitScope(base, auth.key, model)
    const expired = createTurnLimitCache(directory, { now: () => Date.now() - TURN_LIMIT_TTL_MS - 1000 })
    await expired.remember(scope, 20)
    const sent = []
    await withFetch((_url, _init, body) => {
      sent.push(body)
      return userCount(body.input) > 100 ? exceeded(100) : Response.json({ output: [] })
    }, async () => {
      const client = await loader({}, auth, directory)
      expect((await send(client, 51)).status).toBe(200)
      expect(sent.map(body => userCount(body.input))).toEqual([51])
      expect(sent[0].input).toEqual(conversation(51))
      expect((await send(client, 101)).status).toBe(200)
      expect(sent.map(body => userCount(body.input))).toEqual([51, 101, 96])
    })
  })
})

test.each([
  [400, { code: "context_length_exceeded", message: "20 turns" }],
  [429, { code: "rate_limit_exceeded", message: "20 turns" }],
  [500, { type: "upstream_error", message: "session_turn_limit_exceeded: 20 turns" }],
  [403, { type: "billing_error", message: "insufficient balance" }],
])("普通 HTTP %s 错误不学习上限或自动重试，原响应仍可读取", async (status, error) => {
  let calls = 0
  const response = Response.json({ error }, { status })
  await withFetch(() => { calls++; return response }, async () => {
    const result = await send(await loader(), 21)
    expect(result).toBe(response)
    expect(await result.json()).toEqual({ error })
    expect(calls).toBe(1)
  })
})

test("连续变化只重试一次，但第二次错误仍会更新下一次请求的上限", async () => {
  const sent = []
  await withFetch((_url, _init, body) => {
    sent.push(userCount(body.input))
    if (sent.length === 1) return exceeded(20)
    return userCount(body.input) > 10 ? exceeded(10) : Response.json({ output: [] })
  }, async () => {
    const client = await loader()
    expect((await send(client, 21)).status).toBe(400)
    expect(sent).toEqual([21, 16])
    expect((await send(client, 21)).status).toBe(200)
    expect(sent).toEqual([21, 16, 6])
  })
})

test("无法安全减少轮数及上限为 1 时保持原文，不重复发送无效请求", async () => {
  const input = conversation(21)
  input.splice(1, 0, { type: "function_call", call_id: "pending", name: "read", arguments: "{}" })
  let calls = 0
  await withFetch((_url, _init, body) => {
    calls++
    expect(body.input).toEqual(input)
    return exceeded(20)
  }, async () => {
    expect((await send(await loader(), input)).status).toBe(400)
    expect(calls).toBe(1)
  })
  calls = 0
  await withFetch(() => { calls++; return exceeded(1) }, async () => {
    expect((await send(await loader(), 2)).status).toBe(400)
    expect(calls).toBe(1)
  })
})

test.each([true, false])("UA 回退与轮次重试分别只执行一次，UA 先拒绝=%s", async uaFirst => {
  const sent = []
  await withFetch((_url, init, body) => {
    const ua = new Headers(init.headers).get("user-agent")
    const users = userCount(body.input)
    sent.push({ ua, users })
    const uaError = () => Response.json({ error: { code: "client_not_allowed" } }, { status: 403 })
    if (uaFirst && !ua.startsWith("opencode/")) return uaError()
    if (users > 20) return exceeded(20)
    if (!ua.startsWith("opencode/")) return uaError()
    return Response.json({ output: [] })
  }, async () => {
    expect((await send(await loader({ userAgent: "claude" }), 21)).status).toBe(200)
    expect(sent.map(item => item.users)).toEqual(uaFirst ? [21, 21, 16] : [21, 16, 16])
    expect(sent).toHaveLength(3)
    expect(sent.at(-1).ua).toStartWith("opencode/")
  })
})

test("账号、模型、实际 URL 和覆盖密钥不会借用其他通道的观察值", async () => {
  const sent = []
  await withFetch((url, init, body) => {
    const key = new Headers(init.headers).get("authorization")
    const limit = key === "Bearer sk-adaptive" && body.model === model && String(url).startsWith(base) ? 20 : 100
    sent.push({ key, model: body.model, users: userCount(body.input) })
    return userCount(body.input) > limit ? exceeded(limit) : Response.json({ output: [] })
  }, async () => {
    const plugin = await XingchiPlugin({ client: {} }, {})
    const first = await plugin.auth.loader(async () => auth)
    const second = await plugin.auth.loader(async () => ({ type: "api", key: "sk-other-account" }))
    expect((await send(first, 21)).status).toBe(200)
    expect((await send(second, 31)).status).toBe(200)
    expect((await send(first, 51, { model: "gpt-5.6" })).status).toBe(200)
    expect((await send(first, 51, { url: "https://other.example/v1/responses" })).status).toBe(200)
    expect((await send(first, 41, { headers: { authorization: "Bearer sk-override" } })).status).toBe(200)
    expect(sent.map(item => item.users)).toEqual([21, 16, 31, 51, 51, 41])
  })
})

test("分组标记选择的实际 key 决定上限，重试保留分组及二进制请求体", async () => {
  const account = { ...auth, metadata: { groupKeys: { 4: "sk-group-four" } } }
  const sent = []
  await withFetch((_url, init, body) => {
    const key = new Headers(init.headers).get("authorization")
    const limit = key === "Bearer sk-group-four" ? 10 : 20
    sent.push({ key, model: body.model, input: body.input, binary: init.body instanceof Uint8Array })
    return userCount(body.input) > limit ? exceeded(limit) : Response.json({ output: [] })
  }, async () => {
    const client = await loader({}, account)
    expect((await send(client, 21)).status).toBe(200)
    expect((await send(client, 21, { model: model + "-g4", binary: true })).status).toBe(200)
    expect(sent.map(item => userCount(item.input))).toEqual([21, 16, 21, 6])
    expect(sent.slice(-2).every(item => item.key === "Bearer sk-group-four" && item.model === model && item.binary)).toBe(true)
    expect(reconstruct(sent.at(-1).input)).toEqual(conversation(21))
  })
})

test("重新创建插件后使用磁盘观察值，已知上限无需再次失败探测", async () => {
  await withDirectory(async directory => {
    const sent = []
    await withFetch((_url, _init, body) => {
      sent.push(userCount(body.input))
      return userCount(body.input) > 20 ? exceeded(20) : Response.json({ output: [] })
    }, async () => {
      expect((await send(await loader({}, auth, directory), 21)).status).toBe(200)
      expect((await send(await loader({}, auth, directory), 21)).status).toBe(200)
      expect(sent).toEqual([21, 16, 16])
    })
  })
})
