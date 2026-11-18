import { expect, test } from "bun:test"
import { _internal } from "../index.mjs"

const { normalizeResponsesBody, pickUserAgent, resolveUserAgent, uaToken, UA_PRESETS, DEFAULT_UA } = _internal

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
