import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appServer, readHandoffTranscript, readMagpieOptions, runHandoff } from "../scripts/codex-handoff.mjs"

const oldId = "00000000-0000-4000-8000-000000000001"
const newId = "00000000-0000-4000-8000-000000000002"
const model = "xingchi/gpt-6.1-sol"

function completed(turn_id, item, thread_id = oldId) {
  return { type: "event_msg", payload: { type: "item_completed", thread_id, turn_id, item } }
}

function transcript(count, provider = "magpie") {
  const records = [
    { type: "session_meta", payload: { id: oldId, model_provider: provider } },
    { type: "turn_context", payload: { effort: "medium" } },
  ]
  for (let turn = 1; turn <= count; turn++) {
    const turnId = `turn-${turn}`
    const text = turn === 1 ? "Keep retry_limit=7" : turn === 2 ? "更正：保留目录 source" :
      turn === 30 ? "Never edit generated files" : `User ${turn}`
    records.push(completed(turnId, { type: "UserMessage", content: [
      { type: "text", text },
      { type: "image", url: "private-image" },
    ] }))
    records.push(completed(turnId, {
      type: "AgentMessage", phase: "final_answer", content: `Validated ${turn}`,
    }))
  }
  return records.map(record => JSON.stringify(record))
}

async function withTranscript(count, check, provider) {
  const project = await mkdtemp(join(tmpdir(), "xingchi-handoff-"))
  try {
    const transcriptPath = join(project, "rollout.jsonl")
    await writeFile(transcriptPath, transcript(count, provider).join("\n"))
    const event = { hook_event_name: "Stop", cwd: project, transcript_path: transcriptPath, session_id: oldId, model }
    await check(event, { project, stateDir: join(project, "state") })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

function mockServer({ resolvedModel = model, status = "completed", rejectStart = false, rejectName = false } = {}) {
  const calls = []
  return {
    calls,
    connect: () => ({
      async call(method, params) {
        calls.push([method, params])
        if (method === "thread/start") {
          if (rejectStart) throw new Error("模拟启动超时")
          return {
            model: resolvedModel, modelProvider: "magpie",
            thread: { id: newId, createdAt: Date.parse("2026-11-21T16:42:00Z") / 1000 },
          }
        }
        if (method === "turn/start") return { turn: { id: "handoff-turn" } }
        if (method === "thread/name/set" && rejectName) throw new Error("模拟写入标题失败")
      },
      notify(method) { calls.push([method]) },
      async waitForTurn(threadId, turnId) { calls.push(["wait", threadId, turnId]); return status },
      close() { calls.push(["close"]) },
    }),
  }
}

test("读取当前插件路径的 Magpie 开关，忽略同名副本并反映后续修改", async () => {
  await withTranscript(1, async (_event, { project }) => {
    const file = join(project, "plugins.json")
    const save = async enabled => writeFile(file, JSON.stringify({ plugins: [
      { spec: "magpie-plugin-xingchi", options: { codexAutoHandoff: !enabled } },
      { spec: project, options: { codexAutoHandoff: enabled, codexAutoOpen: false } },
    ] }))
    await save(true)
    expect(await readMagpieOptions(file, project)).toEqual({ codexAutoHandoff: true, codexAutoOpen: false })
    await save(false)
    expect(await readMagpieOptions(file, project)).toEqual({ codexAutoHandoff: false, codexAutoOpen: false })
  })
})

test("只按自己的 Codex 用户回合计数，同一回合和模型请求不会重复计数", async () => {
  const lines = transcript(95)
  lines.push(JSON.stringify(completed("turn-95", { type: "UserMessage", content: [{ type: "text", text: "Follow-up" }] })))
  lines.push(JSON.stringify(completed("turn-child", { type: "UserMessage", content: "subagent" }, newId)))
  lines.push(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "provider replay" } }))
  lines.push("{partial line")
  const history = await readHandoffTranscript(lines, oldId)
  expect(history.count).toBe(95)
  expect(history.context.original).toEqual(["Keep retry_limit=7"])
  expect(history.context.earlier).toContain("更正：保留目录 source")
  expect(history.context.earlier).toContain("Never edit generated files")
  expect(history.context.recent.at(-1)).toEqual({ user: ["User 95", "Follow-up"], assistant: ["Validated 95"] })
  const context = JSON.stringify(history.context)
  expect(context).not.toMatch(/private-image|subagent|provider replay/)
})

test("关闭、预览、未达阈值和非星驰回合都不会启动 App Server", async () => {
  const connect = () => { throw new Error("不应创建会话") }
  await withTranscript(94, async (event, options) => {
    expect(await runHandoff(event, { ...options, mode: "auto", connect })).toEqual({})
  })
  await withTranscript(95, async (event, options) => {
    expect(await runHandoff(event, { ...options, mode: "off", connect })).toEqual({})
    const preview = await runHandoff(event, { ...options, mode: "preview", connect })
    expect(preview.systemMessage).toContain("95")
    expect(await runHandoff({ ...event, model: "other/model" }, { ...options, mode: "auto", connect })).toEqual({})
    expect(await runHandoff({ ...event, stop_hook_active: true }, { ...options, mode: "auto", connect })).toEqual({})
    expect(await runHandoff(event, { ...options, project: tmpdir(), mode: "auto", connect })).toEqual({})
  })
  await withTranscript(95, async (event, options) => {
    expect(await runHandoff(event, { ...options, mode: "auto", connect })).toEqual({})
    expect(await runHandoff(event, { ...options, project: "--all-projects", mode: "auto", connect })).toEqual({})
  }, "openai")
})

test("全目录模式在其他工作区触发，并把原工作目录传给新会话", async () => {
  await withTranscript(95, async (event, options) => {
    const otherWorkspace = join(options.project, "other-workspace")
    await mkdir(otherWorkspace)
    const { connect, calls } = mockServer()
    const otherEvent = { ...event, cwd: otherWorkspace }
    expect(await runHandoff(otherEvent, { ...options, mode: "auto", connect })).toEqual({})
    expect(calls).toEqual([])

    const global = { ...options, project: "--all-projects", mode: "auto", connect }
    expect(await runHandoff({ ...otherEvent, model: "other/model" }, global)).toEqual({})
    expect(calls).toEqual([])
    expect((await runHandoff(otherEvent, global)).systemMessage).toContain(`codex resume ${newId}`)
    expect(calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
      cwd: await realpath(otherWorkspace), model, modelProvider: "magpie",
    })
  })
})

test("达到阈值后创建一条新会话，等待交接完成，且不重复创建", async () => {
  await withTranscript(95, async (event, options) => {
    const { connect, calls } = mockServer()
    const settings = { ...options, mode: "auto", connect, openThread: async id => { calls.push(["open", id]) } }
    const result = await runHandoff(event, settings)
    expect(result.systemMessage).toContain(`codex resume ${newId}`)
    expect(result.systemMessage).toContain("已请求 Codex 桌面端打开")
    expect(calls.map(([method]) => method)).toEqual([
      "initialize", "initialized", "thread/start", "turn/start", "wait", "thread/name/set", "close", "open",
    ])
    expect(calls[2][1]).toMatchObject({ model, modelProvider: "magpie", sandbox: "read-only", approvalPolicy: "never" })
    expect(calls[3][1]).toMatchObject({ threadId: newId, effort: "medium" })
    expect(calls[3][1].input[0].text).toContain("Keep retry_limit=7")
    expect(calls[3][1].input[0].text).toContain("Validated 95")
    expect(calls[4]).toEqual(["wait", newId, "handoff-turn"])
    expect(calls[5][1]).toEqual({ threadId: newId, name: "星驰续接 · 2026-11-22 00:42:00" })
    expect(calls.at(-1)).toEqual(["open", newId])
    expect((await readFile(join(options.stateDir, `${oldId}.txt`), "utf8")).trim()).toBe(newId)
    expect(await runHandoff(event, settings)).toEqual({})
    expect(calls.filter(([method]) => method === "thread/start")).toHaveLength(1)
  })
})

test("模型回退时不发送交接；交接失败会报告已创建的会话 ID", async () => {
  await withTranscript(95, async (event, options) => {
    const { connect, calls } = mockServer({ resolvedModel: "other/model" })
    const result = await runHandoff(event, { ...options, mode: "auto", connect })
    expect(result.systemMessage).toContain(newId)
    expect(calls.some(([method]) => method === "turn/start")).toBe(false)
  })
  await withTranscript(95, async (event, options) => {
    const { connect, calls } = mockServer({ status: "failed" })
    const result = await runHandoff(event, { ...options, mode: "auto", connect, openThread: async id => { calls.push(["open", id]) } })
    expect(result.systemMessage).toContain("未完成")
    expect(result.systemMessage).toContain(newId)
    expect(calls.some(([method]) => method === "open")).toBe(false)
  })
})

test("改名或打开桌面端失败时，仍提供已完成交接的会话 ID", async () => {
  await withTranscript(95, async (event, options) => {
    const { connect } = mockServer({ rejectName: true })
    const result = await runHandoff(event, {
      ...options, mode: "auto", connect,
      openThread: async () => { throw new Error("没有桌面客户端") },
    })
    expect(result.systemMessage).toContain("未能写入创建时间标题")
    expect(result.systemMessage).toContain("未能打开 Codex 桌面端")
    expect(result.systemMessage).toContain(`codex resume ${newId}`)
  })
})

test("创建超时后不会重试，以免重复创建已接收的请求", async () => {
  await withTranscript(95, async (event, options) => {
    const { connect, calls } = mockServer({ rejectStart: true })
    const settings = { ...options, mode: "auto", connect }
    expect((await runHandoff(event, settings)).systemMessage).toContain("超时")
    expect(await runHandoff(event, settings)).toEqual({})
    expect(calls.filter(([method]) => method === "thread/start")).toHaveLength(1)
  })
})

test("App Server 先发 turn/completed 再回 turn/start 也能完成交接", async () => {
  const wire = `
    import { createInterface } from "node:readline";
    const [threadId, turnId] = process.argv.slice(-2);
    const write = message => process.stdout.write(JSON.stringify(message) + "\\n");
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === "turn/start") {
        write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        write({ id: request.id, result: { turn: { id: turnId } } });
      }
    }
  `
  const client = appServer(process.execPath, ["-e", wire, "--", newId, "wire-turn"])
  try {
    const response = await client.call("turn/start", { threadId: newId }, 2000)
    expect(response.turn.id).toBe("wire-turn")
    expect(await client.waitForTurn(newId, response.turn.id)).toBe("completed")
  } finally {
    client.close()
  }
})
