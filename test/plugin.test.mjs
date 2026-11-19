import { expect, test } from "bun:test"
import { _internal } from "../index.mjs"

const {
  normalizeResponsesBody,
  pickUserAgent,
  resolveUserAgent,
  uaToken,
  probeToolSupport,
  mapWithLimit,
  UA_PRESETS,
  DEFAULT_UA,
} = _internal

test("uaToken 只取斜杠前的客户端名", () => {
  expect(uaToken("omp/18.22.2")).toBe("omp")
  expect(uaToken("opencode/1.0.0 (magpie)")).toBe("opencode")
  expect(uaToken("Bun/1.4.2")).toBe("bun")
  expect(uaToken("omp")).toBe(null)
  expect(uaToken(undefined)).toBe(null)
})

test("白名单内的 UA 保留，其余替换成默认客户端", () => {
  expect(pickUserAgent("claude-cli/2.0.0")).toBe("claude-cli/2.0.0")
  expect(pickUserAgent("cursor/1.0")).toBe("cursor/1.0")
  expect(pickUserAgent("Bun/1.4.2")).toBe(DEFAULT_UA)
  expect(pickUserAgent(null)).toBe(DEFAULT_UA)
})

test("显式配置的 UA 优先", () => {
  expect(pickUserAgent("claude-cli/2.0.0", "omp/18.22.2")).toBe("omp/18.22.2")
  expect(pickUserAgent("Bun/1.4.2", "omp/18.22.2")).toBe("omp/18.22.2")
})

test("UA 预设名解析成真实客户端的 UA", () => {
  expect(resolveUserAgent("opencode")).toBe(UA_PRESETS.opencode)
  expect(resolveUserAgent("Claude")).toBe(UA_PRESETS.claude)
  expect(resolveUserAgent("cline")).toBe(UA_PRESETS.cline)
})

test("UA 预设名大小写不敏感", () => {
  expect(resolveUserAgent("OMP")).toBe(UA_PRESETS.omp)
  expect(resolveUserAgent("Cursor")).toBe(UA_PRESETS.cursor)
})

test("完整 UA 字符串原样使用，未知值返回 null", () => {
  expect(resolveUserAgent("claude-cli/2.1.327 (external, cli)")).toBe("claude-cli/2.1.327 (external, cli)")
  expect(resolveUserAgent("Bun/1.4.2")).toBe("Bun/1.4.2")
  expect(resolveUserAgent("nonsense")).toBe(null)
  expect(resolveUserAgent(undefined)).toBe(null)
})

test("每个 UA 预设的第一段都在网关白名单里", () => {
  for (const [key, ua] of Object.entries(UA_PRESETS)) {
    expect(uaToken(ua)).not.toBe(null)
    expect(_internal.ALLOWED_UA_TOKENS.has(uaToken(ua))).toBe(true)
  }
})

test("删掉 previous_response_id 并关闭 store", () => {
  const out = JSON.parse(
    normalizeResponsesBody(
      JSON.stringify({ model: "gpt-5.6", previous_response_id: "resp_1", store: true, input: "hi" }),
    ),
  )
  expect(out.previous_response_id).toBeUndefined()
  expect(out.store).toBe(false)
  expect(out.input).toBe("hi")
})

test("system / developer 消息提升为 instructions", () => {
  const out = JSON.parse(
    normalizeResponsesBody(
      JSON.stringify({
        model: "gpt-5.6",
        input: [
          { role: "system", content: [{ type: "input_text", text: "sys" }] },
          { role: "developer", content: "dev" },
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      }),
    ),
  )
  expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }])
  expect(out.instructions).toBe("sys\n\ndev")
})

test("只有 system 消息时降级成 user 消息", () => {
  const out = JSON.parse(
    normalizeResponsesBody(JSON.stringify({ model: "gpt-5.6", input: [{ role: "system", content: "only" }] })),
  )
  expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "only" }] }])
  expect(out.instructions).toBeUndefined()
})

test("非法 JSON 原样返回", () => {
  expect(normalizeResponsesBody("not json")).toBe("not json")
})

test("mapWithLimit 限制并发", async () => {
  let running = 0
  let peak = 0
  await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
  })
  expect(peak).toBeLessThanOrEqual(3)
  expect(peak).toBeGreaterThan(1)
})

test("mapWithLimit 全部执行", async () => {
  const seen = []
  await mapWithLimit([1, 2, 3, 4], 2, async (n) => {
    seen.push(n)
  })
  expect(seen.sort()).toEqual([1, 2, 3, 4])
})

test("mapWithLimit 空数组不报错", async () => {
  await mapWithLimit([], 4, async () => {
    throw new Error("不该被调用")
  })
})

test("探测把各种网关回答归类", async () => {
  const original = globalThis.fetch
  const reply = async (status, body) => {
    globalThis.fetch = async () => new Response(body, { status })
  }
  try {
    // 成功 → 支持工具
    await reply(200, JSON.stringify({ output: [{ type: "function_call" }] }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(true)

    // 明确不支持工具 → 不支持
    await reply(400, JSON.stringify({ error: { message: "m requires Responses for tool calls; this account only supports Chat Completions" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(false)

    // 模型已不在账号池里 → 没测出来（不是"不支持工具"）
    await reply(400, JSON.stringify({ error: { message: 'Model "m" is not supported by any configured account in this group' } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 限流 → 没测出来
    await reply(429, JSON.stringify({ error: { message: "Upstream rate limit exceeded" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 上游 5xx → 没测出来
    await reply(503, JSON.stringify({ error: { message: "Service temporarily unavailable" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 网络异常 → 没测出来
    globalThis.fetch = async () => {
      throw new Error("boom")
    }
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)
  } finally {
    globalThis.fetch = original
  }
})
