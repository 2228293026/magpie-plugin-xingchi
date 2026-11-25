import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import {
  createTurnLimitCache, isTurnLimit, parseTurnFeedback, parseTurnLimit, turnLimitScope,
  TURN_LIMIT_CACHE_FILE, TURN_LIMIT_TTL_MS,
} from "../turn-limits.mjs"

const base = "https://api.xingchiapi.com/v1"
const scope = turnLimitScope(base, "sk-unit-primary", "gpt-6.1-sol")
const rejection = message => ({ error: { code: "session_turn_limit_exceeded", message } })

async function withDirectory(check) {
  const directory = await mkdtemp(join(tmpdir(), "xingchi-turn-limits-"))
  try {
    await check(directory)
  } finally {
    const target = await realpath(directory)
    const within = relative(await realpath(tmpdir()), target)
    if (isAbsolute(within) || within.startsWith("..") || !within.startsWith("xingchi-turn-limits-")) {
      throw new Error("Refusing to remove a fixture outside the test directory")
    }
    await rm(target, { recursive: true, force: true })
  }
}

test.each([
  ["中文及英文同值", rejection("当前会话已满 20 轮对话。This conversation has reached 20 turns."), 20],
  ["英文降低", rejection("This conversation has reached 10 turns. Please start a new session."), 10],
  ["明确上限优先于当前轮数", rejection("You sent 101 turns; the limit is 100 turns."), 100],
  ["中文明确上限", rejection("已发送 21 轮，上限为 20 轮。"), 20],
  ["纯轮数消息", rejection("30 rounds"), 30],
  ["结构化字段", { error: { code: "session_turn_limit_exceeded", max_turns: 50 } }, 50],
  ["结构化字符串", { error: { code: "session_turn_limit_exceeded", turn_limit: "10" } }, 10],
  ["SSE 失败载荷", { type: "response.failed", response: rejection("已满 20 轮对话") }, 20],
  ["限流不误判", { error: { code: "rate_limit_exceeded", message: "20 turns" } }, undefined],
  ["普通上游错误不误判", { error: { type: "upstream_error", message: "20 turns" } }, undefined],
  ["缺少轮数", rejection("Please start a new session"), undefined],
  ["冲突的中英文轮数", rejection("当前会话已满 20 轮。This conversation has reached 100 turns."), undefined],
  ["零轮数", rejection("limit is 0 turns"), undefined],
  ["负轮数", rejection("limit is -1 turns"), undefined],
  ["小数轮数", rejection("limit is 1.5 turns"), undefined],
  ["科学记数不截取尾数", rejection("limit is 1e2 turns"), undefined],
  ["不安全整数", rejection("limit is 9007199254740993 turns"), undefined],
])("解析上游轮次限制：%s", (_name, payload, expected) => {
  expect(parseTurnLimit(payload)).toBe(expected)
})

test("已回复的模型轮数不冒充精确上限", () => {
  const message = "当前会话模型已回复 105 轮，达到上限。Codex 请输入 /compact 压缩上下文后继续，或输入 /new 新开会话；其他客户端请新建对话。" +
    "This conversation has reached 105 model turns. Run /compact to continue with a summarized context, or /new to start a new session."
  expect(parseTurnLimit(rejection(message))).toBeUndefined()
})

test.each([
  ["双语模型拒绝计数", rejection("当前会话模型已回复 105 轮，达到上限。This conversation has reached 105 model turns."), { metric: "model", rejectedAt: 105 }],
  ["英文模型计数", rejection("This conversation has reached 100 model turns. Run /compact."), { metric: "model", rejectedAt: 100 }],
  ["明确模型上限优先于拒绝计数", rejection("模型已回复 105 轮；上限为 100 轮。This conversation has reached 105 model turns."), { metric: "model", limit: 100 }],
  ["结构化模型上限", { error: { code: "session_turn_limit_exceeded", max_model_turns: "80" } }, { metric: "model", limit: 80 }],
  ["用户与模型反馈区分", rejection("已满 20 轮对话。"), { metric: "user", limit: 20 }],
  ["冲突模型计数", rejection("模型已回复 105 轮。This conversation has reached 100 model turns."), undefined],
  ["冲突明确上限不能退化为当前计数", rejection("模型已回复 105 轮，上限为 100 轮。The limit is 200 model turns."), undefined],
  ["小数模型计数", rejection("This conversation has reached 1.5 model turns."), undefined],
])("轮次反馈语义：%s", (_name, payload, expected) => {
  expect(parseTurnFeedback(payload)).toEqual(expected)
})

test("上限只接受正的安全整数", () => {
  expect(isTurnLimit(1)).toBe(true)
  expect(isTurnLimit(100)).toBe(true)
  for (const value of [undefined, null, 0, -1, 1.5, "20", Infinity, NaN]) {
    expect(isTurnLimit(value)).toBe(false)
  }
})

test("按网关、实际密钥及 API 模型隔离；响应端点与基址归一化", () => {
  expect(turnLimitScope(base + "/responses", "sk-unit-primary", "gpt-6.1-sol")).toBe(scope)
  expect(turnLimitScope(base + "/", "sk-unit-primary", "gpt-6.1-sol")).toBe(scope)
  expect(turnLimitScope(base, "sk-unit-other-group", "gpt-6.1-sol")).not.toBe(scope)
  expect(turnLimitScope(base, "sk-unit-primary", "gpt-5.6")).not.toBe(scope)
  expect(turnLimitScope("https://other.example/v1", "sk-unit-primary", "gpt-6.1-sol")).not.toBe(scope)
  expect(turnLimitScope("invalid URL", "key", "model")).toBeUndefined()
  expect(turnLimitScope(base, "", "model")).toBeUndefined()
})

test("未知时没有固定上限，缓存到期后重新允许探明上限", async () => {
  let clock = 10000
  const cache = createTurnLimitCache(undefined, { now: () => clock })
  expect(await cache.get(scope)).toBeUndefined()
  await cache.remember(scope, 20)
  expect(await cache.get(scope)).toBe(20)
  clock += TURN_LIMIT_TTL_MS - 1
  expect(await cache.get(scope)).toBe(20)
  clock++
  expect(await cache.get(scope)).toBeUndefined()
  await cache.remember(scope, 100)
  expect(await cache.get(scope)).toBe(100)
})

test("新实例读回上限，密钥原文不写入缓存，读取不会延长有效期", async () => {
  await withDirectory(async directory => {
    let clock = 10000
    const cache = createTurnLimitCache(directory, { now: () => clock })
    await cache.remember(scope, 20)
    const text = await readFile(join(directory, TURN_LIMIT_CACHE_FILE), "utf8")
    expect(text).not.toContain("sk-unit-primary")
    expect(JSON.parse(text).limits[scope]).toEqual({ limit: 20, at: 10000 })
    const another = createTurnLimitCache(directory, { now: () => clock })
    expect(await another.get(scope)).toBe(20)
    clock += TURN_LIMIT_TTL_MS
    expect(await another.get(scope)).toBeUndefined()
    expect(await cache.get(scope)).toBeUndefined()
  })
})

test("模型预算与用户上限分别持久化，零原生模型预算可读回并按时失效", async () => {
  await withDirectory(async directory => {
    let clock = 10000
    const modelScope = turnLimitScope(base, "sk-unit-primary", "gpt-6.1-sol", "model")
    expect(modelScope).not.toBe(scope)
    const cache = createTurnLimitCache(directory, { now: () => clock })
    await cache.remember(scope, 20)
    await cache.remember(modelScope, 0, "model")
    const reloaded = createTurnLimitCache(directory, { now: () => clock })
    expect(await reloaded.get(scope)).toBe(20)
    expect(await reloaded.get(modelScope)).toBe(0)
    const data = JSON.parse(await readFile(join(directory, TURN_LIMIT_CACHE_FILE), "utf8"))
    expect(data.limits[modelScope]).toEqual({ limit: 0, at: clock, metric: "model" })
    clock += TURN_LIMIT_TTL_MS
    expect(await reloaded.get(scope)).toBeUndefined()
    expect(await reloaded.get(modelScope)).toBeUndefined()
  })
})

test("并发模型预算更新原子保留较小值，其他实例及持久缓存不会抬高预算", async () => {
  await withDirectory(async directory => {
    let clock = 10000
    const scope = turnLimitScope(base, "sk-unit-concurrent", "gpt-6.1-sol", "model")
    const first = createTurnLimitCache(directory, { now: () => clock })
    const second = createTurnLimitCache(directory, { now: () => clock })
    await Promise.all([first.remember(scope, 5, "model"), second.remember(scope, 50, "model")])
    expect(await first.get(scope)).toBe(5)
    expect(await second.get(scope)).toBe(5)
    expect(await createTurnLimitCache(directory, { now: () => clock }).get(scope)).toBe(5)
    clock++
    await second.remember(scope, 100, "model")
    const data = JSON.parse(await readFile(join(directory, TURN_LIMIT_CACHE_FILE), "utf8"))
    expect(data.limits[scope]).toEqual({ limit: 5, at: 10000, metric: "model" })
    clock += TURN_LIMIT_TTL_MS
    await second.remember(scope, 100, "model")
    expect(await second.get(scope)).toBe(100)
  })
})

test("等待中的 get 不会用旧时间删除刚记住的有效模型预算", async () => {
  let clock = 1000
  const scope = turnLimitScope(base, "sk-unit-read-race", "gpt-6.1-sol", "model")
  const cache = createTurnLimitCache(undefined, { now: () => clock })
  const pending = cache.get(scope)
  clock++
  await cache.remember(scope, 5, "model")
  expect(await pending).toBe(5)
  expect(await cache.get(scope)).toBe(5)
  await cache.remember(scope, 50, "model")
  expect(await cache.get(scope)).toBe(5)
})

test("异步读取跨过缓存到期点后使用新预算，不让过期磁盘值覆盖", async () => {
  await withDirectory(async directory => {
    let clock = 1000
    const scope = turnLimitScope(base, "sk-unit-expiring-read", "gpt-6.1-sol", "model")
    const cache = createTurnLimitCache(directory, { now: () => clock })
    await cache.remember(scope, 5, "model")
    clock += TURN_LIMIT_TTL_MS - 1
    const pending = cache.get(scope)
    clock++
    const updated = cache.remember(scope, 50, "model")
    expect(await pending).toBe(50)
    await updated
    expect(await cache.get(scope)).toBe(50)
  })
})

test("同一路径的并发更新保留各通道，其他实例读到新观察值", async () => {
  await withDirectory(async directory => {
    const first = createTurnLimitCache(directory, { now: () => 10000 })
    const second = createTurnLimitCache(directory, { now: () => 10000 })
    const other = turnLimitScope(base, "sk-unit-other", "gpt-6.1-sol")
    await Promise.all([first.remember(scope, 20), second.remember(other, 100)])
    expect(await first.get(scope)).toBe(20)
    expect(await first.get(other)).toBe(100)
    expect(await second.get(scope)).toBe(20)
    await first.remember(scope, 10)
    expect(await second.get(scope)).toBe(10)
    expect(Object.keys(JSON.parse(await readFile(join(directory, TURN_LIMIT_CACHE_FILE), "utf8")).limits))
      .toHaveLength(2)
  })
})

test("损坏或未来时间的缓存忽略，无写权限仍能在内存记住新上限", async () => {
  await withDirectory(async directory => {
    const file = join(directory, TURN_LIMIT_CACHE_FILE)
    const cache = createTurnLimitCache(directory, { now: () => 10000 })
    await writeFile(file, "not JSON")
    expect(await cache.get(scope)).toBeUndefined()
    await writeFile(file, JSON.stringify({ version: 1, limits: { [scope]: { limit: 20, at: 10001 } } }))
    expect(await cache.get(scope)).toBeUndefined()
    const blocked = join(directory, "not-a-directory")
    await writeFile(blocked, "fixture")
    const memory = createTurnLimitCache(blocked, { now: () => 10000 })
    await memory.remember(scope, 20)
    await memory.remember(scope, 10)
    expect(await memory.get(scope)).toBe(10)
  })
})
