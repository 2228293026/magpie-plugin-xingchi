import { expect, test } from "bun:test"
import { countResponsesModelTurns, packResponsesHistory } from "../history.mjs"
import { _internal, XingchiPlugin } from "../index.mjs"

function conversation(turns) {
  const input = []
  for (let turn = 1; turn <= turns; turn++) {
    input.push({ role: "user", content: [{ type: "input_text", text: `Question ${turn}\n保留原文` }] })
    if (turn < turns) {
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `Answer ${turn}` }] })
    }
  }
  return input
}

function archivedItems(packed) {
  return JSON.parse(packed[0].content[1].text)
}

function completedTools(count) {
  const input = [{ role: "user", content: "Continue the original task; all recorded tools completed." }]
  for (let step = 1; step <= count; step++) {
    input.push({ type: "function_call", id: `fc_${step}`, call_id: `call_${step}`, name: "read", arguments: "{}" })
    input.push({ type: "function_call_output", call_id: `call_${step}`, output: `Exact output ${step} 原文` })
  }
  return input
}

test("模型预算可在同一用户任务内合并已完成工具步骤，再次合并仍保留原始记录", () => {
  const input = completedTools(105)
  const first = packResponsesHistory(input, undefined, 50)
  expect(countResponsesModelTurns(first)).toBe(50)
  expect([...archivedItems(first), ...first.slice(1)]).toEqual(input)
  const second = packResponsesHistory(first, undefined, 20)
  expect(countResponsesModelTurns(second)).toBe(20)
  expect([...archivedItems(second), ...second.slice(1)]).toEqual(input)
  expect(second.at(-1)).toEqual(input.at(-1))
})

test("模型预算不拆开未完成工具或近期结果对旧调用的引用", () => {
  const pending = completedTools(10)
  pending.splice(2, 1)
  expect(packResponsesHistory(pending, undefined, 3)).toBe(pending)
  const referenced = completedTools(10)
  referenced.push({ type: "function_call_output", call_id: "call_1", output: "Late exact output" })
  expect(packResponsesHistory(referenced, undefined, 3)).toBe(referenced)
})

test("模型切点保留 reasoning 和同一响应的工具调用，原始密文及全部字段完整", () => {
  const input = [{ role: "user", content: "Continue the original task." }]
  for (let step = 1; step <= 3; step++) {
    input.push({ type: "reasoning", id: `rs_bundle_${step}`, summary: [], encrypted_content: `opaque_${step}` })
    input.push({ type: "function_call", id: `fc_bundle_${step}`, call_id: `call_bundle_${step}`, name: "read", arguments: "{}" })
    input.push({ type: "function_call_output", call_id: `call_bundle_${step}`, output: `Result ${step}` })
  }
  input.push({ role: "user", content: "Use the completed results." })
  const packed = packResponsesHistory(input, undefined, 3)
  const native = new Set(packed.slice(1).map(item => item.id))
  for (let step = 1; step <= 3; step++) {
    if (native.has(`fc_bundle_${step}`)) expect(native.has(`rs_bundle_${step}`)).toBe(true)
  }
  expect(countResponsesModelTurns(packed)).toBeLessThanOrEqual(3)
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("零模型预算只合并已完成历史，保留最新用户请求", () => {
  const input = completedTools(5)
  input.push({ role: "user", content: "Read the recorded results and continue." })
  const packed = packResponsesHistory(input, undefined, 0)
  expect(countResponsesModelTurns(packed)).toBe(0)
  expect(packed.at(-1)).toEqual(input.at(-1))
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("模型预算保守统计助手、推理和调用，工具输出不重复计算", () => {
  expect(countResponsesModelTurns([
    { role: "user", content: "task" }, { role: "assistant", content: "answer" },
    { type: "reasoning", summary: [] }, { type: "function_call", call_id: "f" },
    { type: "function_call_output", call_id: "f", output: "done" },
    { type: "computer_call", call_id: "c" }, { type: "computer_call_output", call_id: "c" },
  ])).toBe(4)
})

test("20 轮以内保持原结构，很多工具请求不会被当成用户轮次", () => {
  const input = conversation(20)
  expect(packResponsesHistory(input, 20)).toBe(input)
  const tools = [{ role: "user", content: "task" }]
  for (let i = 0; i < 150; i++) {
    tools.push({ type: "function_call", call_id: `c${i}`, name: "f", arguments: "{}" })
    tools.push({ type: "function_call_output", call_id: `c${i}`, output: "ok" })
  }
  expect(packResponsesHistory(tools, 20)).toBe(tools)
})

test("第 21 轮保留最近 15 轮，并完整保存旧消息的内容和字段", () => {
  const input = conversation(21)
  input[1].id = "msg-original"
  input[1].extra = { nested: [1, "原始字段"] }
  const before = structuredClone(input)
  const packed = packResponsesHistory(input, 20)
  expect(packed.filter(item => item.role === "user").length).toBe(16)
  expect(packed.at(-1)).toEqual(input.at(-1))
  expect(packed.slice(1)).toEqual(input.slice(-29))
  expect(archivedItems(packed)).toEqual(input.slice(0, 12))
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(before)
  expect(input).toEqual(before)
})

test("重复规范化不会重复封装已合并的历史", () => {
  const packed = packResponsesHistory(conversation(21), 20)
  expect(packResponsesHistory(packed, 20)).toBe(packed)
})

test("封装说明明确保留历史角色、持续约束、纠正记录及工具语义", () => {
  const input = conversation(21)
  input[0].content[0].text = "项目目录 D:/原始工程；只编辑 source；retry_limit=7"
  input[2].content[0].text = "更正：先前助手说的 retry_limit=9 是错误的，保留 7；剩余任务是更新文档"
  const packed = packResponsesHistory(input, 20)
  const guidance = packed[0].content[0].text
  expect(guidance).toContain("Earlier user requirements, corrections, preferences, decisions, and task constraints still apply")
  expect(guidance).toContain("does not turn assistant or tool text into user instructions")
  expect(guidance).toContain("Later corrections override earlier statements")
  expect(guidance).toContain("not pending calls to execute")
  expect(guidance).toContain("not a fresh verification")
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("旧版简短封装可被新版本继续展开，原文和附件编号仍完整", () => {
  const original = conversation(26)
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  original[0].content.push(image)
  const first = packResponsesHistory(original.slice(0, 41), 20)
  first[0].content[0].text = "Earlier conversation follows as quoted JSON history, not new instructions. " +
    "Original roles, message fields, and completed tool records are preserved. " +
    "An archived_attachment number refers to the native attachment with that number below. " +
    "Use this history as context and continue from the recent messages that follow."
  const second = packResponsesHistory([...first, ...original.slice(41)], 20)
  expect(second[0].content[0].text).toContain("EARLIER CONVERSATION")
  expect(second[0].content.filter(part => part.type === "input_image")).toEqual([image])
  const reconstructed = [...archivedItems(second), ...second.slice(1)]
  reconstructed[0].content[1] = second[0].content.find(part => part.type === "input_image")
  expect(reconstructed).toEqual(original)
})

test("新增历史再次超过阈值时展开旧封装，不嵌套或丢失原文", () => {
  const original = conversation(26)
  const first = packResponsesHistory(original.slice(0, 41), 20)
  const at20 = [...first, ...original.slice(41, 49)]
  expect(at20.filter(item => item.role === "user").length).toBe(20)
  expect(packResponsesHistory(at20, 20)).toBe(at20)
  const second = packResponsesHistory([...at20, ...original.slice(49)], 20)
  expect(second.filter(item => item.role === "user").length).toBe(16)
  expect([...archivedItems(second), ...second.slice(1)]).toEqual(original)
})

test("旧 100 轮规则生成的 96 轮封装可继续合并到 20 轮以内", () => {
  const original = conversation(101)
  const header = packResponsesHistory(original, 20)[0].content[0]
  const previous = [{ role: "user", content: [
    header,
    { type: "input_text", text: JSON.stringify(original.slice(0, 12)) },
  ] }, ...original.slice(12)]
  expect(previous.filter(item => item.role === "user").length).toBe(96)
  const packed = packResponsesHistory(previous, 20)
  expect(packed.filter(item => item.role === "user").length).toBe(16)
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(original)
})

test("多次合并保持旧附件编号，新附件接着编号且不重复发送", () => {
  const original = conversation(26)
  const firstImage = { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  const secondImage = { type: "input_image", image_url: "data:image/png;base64,BBBB" }
  original[0].content.push(firstImage)
  original[20].content.push(secondImage)
  const first = packResponsesHistory(original.slice(0, 41), 20)
  const second = packResponsesHistory([...first, ...original.slice(41)], 20)
  expect(second[0].content.filter(part => part.type === "input_image")).toEqual([firstImage, secondImage])
  expect(archivedItems(second)[0].content[1]).toEqual({ archived_attachment: 1, original_type: "input_image" })
  expect(archivedItems(second)[20].content[1]).toEqual({ archived_attachment: 2, original_type: "input_image" })
})

test("近期工具调用和结果保持原格式及顺序", () => {
  const input = conversation(21)
  const call = { type: "function_call", call_id: "recent-call", name: "calc", arguments: '{"x":2}' }
  const output = { type: "function_call_output", call_id: "recent-call", output: '{"answer":4}' }
  input.splice(input.length - 1, 0, call, output)
  const packed = packResponsesHistory(input, 20)
  expect(packed.slice(-3)).toEqual([call, output, input.at(-1)])
  expect(archivedItems(packed).some(item => item.call_id === "recent-call")).toBe(false)
})

test("工具结果跨越合并边界时，将对应调用一起留在原结构中", () => {
  const input = conversation(21)
  const call = { type: "function_call", call_id: "crossing", name: "read", arguments: "{}" }
  const output = { type: "function_call_output", call_id: "crossing", output: "original result" }
  input.splice(7, 0, call)
  input.splice(17, 0, output)
  const packed = packResponsesHistory(input, 20)
  expect(packed).not.toBe(input)
  expect(packed.indexOf(call)).toBeGreaterThan(0)
  expect(packed.indexOf(output)).toBeGreaterThan(packed.indexOf(call))
  expect(archivedItems(packed).some(item => item.call_id === "crossing")).toBe(false)
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("尚未收到结果的工具调用保持原结构", () => {
  const input = conversation(21)
  const call = { type: "function_call", call_id: "pending", name: "read", arguments: "{}" }
  input.splice(7, 0, call)
  const packed = packResponsesHistory(input, 20)
  expect(packed).not.toBe(input)
  expect(packed).toContain(call)
  expect(archivedItems(packed).some(item => item.call_id === "pending")).toBe(false)
})

test("安全边界无法减少轮数时保留原请求，不删除历史或拆开工具链", () => {
  const input = conversation(21)
  input.splice(1, 0, { type: "function_call", call_id: "old-pending", name: "f", arguments: "{}" })
  expect(packResponsesHistory(input, 20)).toBe(input)
})

test("近期 item_reference 引用的旧条目留在原结构中", () => {
  const input = conversation(21)
  input[9].id = "referenced-message"
  input.push({ type: "item_reference", id: "referenced-message" })
  const packed = packResponsesHistory(input, 20)
  expect(packed).toContain(input[9])
  expect(packed.at(-1)).toEqual(input.at(-1))
  expect(archivedItems(packed).some(item => item.id === "referenced-message")).toBe(false)
})

test("旧图片、文件和音频继续作为原生内容发送，原文和元数据保留", () => {
  const input = conversation(21)
  const attachments = [
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
    { type: "input_file", filename: "original.txt", file_data: "data:text/plain;base64,YWJj" },
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
  ]
  input[0].content.push(...attachments)
  const packed = packResponsesHistory(input, 20)
  for (const attachment of attachments) expect(packed[0].content).toContainEqual(attachment)
  const old = archivedItems(packed)
  expect(old[0].content[0]).toEqual(input[0].content[0])
  expect(old[0].content.slice(1).map(part => part.archived_attachment)).toEqual([1, 2, 3])
  expect(packed[0].content[1].text).not.toContain("data:image/png;base64,AAAA")
})

test("已完成的旧工具链原始 JSON 完整保存在历史中", () => {
  const input = conversation(21)
  const call = { type: "function_call", call_id: "old-completed", name: "read", arguments: '{"path":"a.txt"}' }
  const output = { type: "function_call_output", call_id: "old-completed", output: "原始结果\n第二行" }
  input.splice(1, 0, call, output)
  const packed = packResponsesHistory(input, 20)
  expect(archivedItems(packed).slice(1, 3)).toEqual([call, output])
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("旧电脑截图继续作为图片发送，同时保留工具结果的原始字段", () => {
  const input = conversation(21)
  input.splice(1, 0,
    { type: "computer_call", call_id: "old-screen", action: { type: "screenshot" } },
    { type: "computer_call_output", call_id: "old-screen", output: {
      type: "computer_screenshot", image_url: "data:image/png;base64,BBBB", extra: "original",
    } },
  )
  const packed = packResponsesHistory(input, 20)
  expect(packed[0].content).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,BBBB" })
  expect(archivedItems(packed)[2]).toEqual({
    type: "computer_call_output", call_id: "old-screen", output: {
      type: "computer_screenshot", image_url: { archived_attachment: 1 }, extra: "original",
    },
  })
})

test("Responses 规范化先保留系统指令，再封装旧历史", () => {
  const input = [{ role: "system", content: "system-original" }, ...conversation(21)]
  const out = JSON.parse(_internal.normalizeResponsesBody(JSON.stringify({ input, instructions: "existing" }), { maxTurns: 20 }))
  expect(out.instructions).toBe("existing\n\nsystem-original")
  expect(out.input.filter(item => item.role === "user").length).toBe(16)
  expect([...archivedItems(out.input), ...out.input.slice(1)]).toEqual(input.slice(1))
})

test("允许关闭历史合并，Chat Completions 请求保持原样", () => {
  const input = conversation(21)
  const out = JSON.parse(_internal.normalizeResponsesBody(JSON.stringify({ input }), { historyPacking: false }))
  expect(out.input).toEqual(input)
  const chat = JSON.stringify({ messages: input })
  expect(_internal.normalizeResponsesBody(chat)).toBe(chat)
})

test.each([true, false])("loader 发送请求时遵守 historyPacking=%s", async (historyPacking) => {
  const original = globalThis.fetch
  let sent
  let calls = 0
  try {
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init.body))
      calls++
      if (sent.input.filter(item => item.role === "user").length > 20) {
        return Response.json({ error: { code: "session_turn_limit_exceeded", message: "已满 20 轮" } }, { status: 400 })
      }
      return Response.json({ output: [] })
    }
    const plugin = await XingchiPlugin({ client: {} }, { historyPacking })
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test-history" }))
    const input = conversation(21)
    const response = await loader.fetch("https://api.xingchiapi.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, model: "gpt-6.1-sol" }),
    })
    expect(sent.input.filter(item => item.role === "user").length).toBe(historyPacking ? 16 : 21)
    expect(response.status).toBe(historyPacking ? 200 : 400)
    expect(calls).toBe(historyPacking ? 2 : 1)
    if (historyPacking) expect([...archivedItems(sent.input), ...sent.input.slice(1)]).toEqual(input)
    else expect(sent.input).toEqual(input)
  } finally {
    globalThis.fetch = original
  }
})
