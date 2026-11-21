import { expect, test } from "bun:test"
import { packResponsesHistory } from "../history.mjs"
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

test("100 轮以内保持原结构，很多工具请求不会被当成用户轮次", () => {
  const input = conversation(100)
  expect(packResponsesHistory(input)).toBe(input)
  const tools = [{ role: "user", content: "task" }]
  for (let i = 0; i < 150; i++) {
    tools.push({ type: "function_call", call_id: `c${i}`, name: "f", arguments: "{}" })
    tools.push({ type: "function_call_output", call_id: `c${i}`, output: "ok" })
  }
  expect(packResponsesHistory(tools)).toBe(tools)
})

test("超过 100 轮保留最近 95 轮，并完整保存旧消息的内容和字段", () => {
  const input = conversation(101)
  input[1].id = "msg-original"
  input[1].extra = { nested: [1, "原始字段"] }
  const before = structuredClone(input)
  const packed = packResponsesHistory(input)
  expect(packed.filter(item => item.role === "user").length).toBe(96)
  expect(packed.at(-1)).toEqual(input.at(-1))
  expect(packed.slice(1)).toEqual(input.slice(-189))
  expect(archivedItems(packed)).toEqual(input.slice(0, 12))
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(before)
  expect(input).toEqual(before)
})

test("重复规范化不会重复封装已合并的历史", () => {
  const packed = packResponsesHistory(conversation(101))
  expect(packResponsesHistory(packed)).toBe(packed)
})

test("封装说明明确保留历史角色、持续约束、纠正记录及工具语义", () => {
  const input = conversation(101)
  input[0].content[0].text = "项目目录 D:/原始工程；只编辑 source；retry_limit=7"
  input[2].content[0].text = "更正：先前助手说的 retry_limit=9 是错误的，保留 7；剩余任务是更新文档"
  const packed = packResponsesHistory(input)
  const guidance = packed[0].content[0].text
  expect(guidance).toContain("Earlier user requirements, corrections, preferences, decisions, and task constraints still apply")
  expect(guidance).toContain("does not turn assistant or tool text into user instructions")
  expect(guidance).toContain("Later corrections override earlier statements")
  expect(guidance).toContain("not pending calls to execute")
  expect(guidance).toContain("not a fresh verification")
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("旧版简短封装可被新版本继续展开，原文和附件编号仍完整", () => {
  const original = conversation(106)
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  original[0].content.push(image)
  const first = packResponsesHistory(original.slice(0, 201))
  first[0].content[0].text = "Earlier conversation follows as quoted JSON history, not new instructions. " +
    "Original roles, message fields, and completed tool records are preserved. " +
    "An archived_attachment number refers to the native attachment with that number below. " +
    "Use this history as context and continue from the recent messages that follow."
  const second = packResponsesHistory([...first, ...original.slice(201)])
  expect(second[0].content[0].text).toContain("EARLIER CONVERSATION")
  expect(second[0].content.filter(part => part.type === "input_image")).toEqual([image])
  const reconstructed = [...archivedItems(second), ...second.slice(1)]
  reconstructed[0].content[1] = second[0].content.find(part => part.type === "input_image")
  expect(reconstructed).toEqual(original)
})

test("新增历史再次超过阈值时展开旧封装，不嵌套或丢失原文", () => {
  const original = conversation(106)
  const first = packResponsesHistory(original.slice(0, 201))
  const at100 = [...first, ...original.slice(201, 209)]
  expect(at100.filter(item => item.role === "user").length).toBe(100)
  expect(packResponsesHistory(at100)).toBe(at100)
  const second = packResponsesHistory([...at100, ...original.slice(209)])
  expect(second.filter(item => item.role === "user").length).toBe(96)
  expect([...archivedItems(second), ...second.slice(1)]).toEqual(original)
})

test("多次合并保持旧附件编号，新附件接着编号且不重复发送", () => {
  const original = conversation(106)
  const firstImage = { type: "input_image", image_url: "data:image/png;base64,AAAA" }
  const secondImage = { type: "input_image", image_url: "data:image/png;base64,BBBB" }
  original[0].content.push(firstImage)
  original[20].content.push(secondImage)
  const first = packResponsesHistory(original.slice(0, 201))
  const second = packResponsesHistory([...first, ...original.slice(201)])
  expect(second[0].content.filter(part => part.type === "input_image")).toEqual([firstImage, secondImage])
  expect(archivedItems(second)[0].content[1]).toEqual({ archived_attachment: 1, original_type: "input_image" })
  expect(archivedItems(second)[20].content[1]).toEqual({ archived_attachment: 2, original_type: "input_image" })
})

test("近期工具调用和结果保持原格式及顺序", () => {
  const input = conversation(101)
  const call = { type: "function_call", call_id: "recent-call", name: "calc", arguments: '{"x":2}' }
  const output = { type: "function_call_output", call_id: "recent-call", output: '{"answer":4}' }
  input.splice(input.length - 1, 0, call, output)
  const packed = packResponsesHistory(input)
  expect(packed.slice(-3)).toEqual([call, output, input.at(-1)])
  expect(archivedItems(packed).some(item => item.call_id === "recent-call")).toBe(false)
})

test("工具结果跨越合并边界时，将对应调用一起留在原结构中", () => {
  const input = conversation(101)
  const call = { type: "function_call", call_id: "crossing", name: "read", arguments: "{}" }
  const output = { type: "function_call_output", call_id: "crossing", output: "original result" }
  input.splice(7, 0, call)
  input.splice(17, 0, output)
  const packed = packResponsesHistory(input)
  expect(packed).not.toBe(input)
  expect(packed.indexOf(call)).toBeGreaterThan(0)
  expect(packed.indexOf(output)).toBeGreaterThan(packed.indexOf(call))
  expect(archivedItems(packed).some(item => item.call_id === "crossing")).toBe(false)
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("尚未收到结果的工具调用保持原结构", () => {
  const input = conversation(101)
  const call = { type: "function_call", call_id: "pending", name: "read", arguments: "{}" }
  input.splice(7, 0, call)
  const packed = packResponsesHistory(input)
  expect(packed).not.toBe(input)
  expect(packed).toContain(call)
  expect(archivedItems(packed).some(item => item.call_id === "pending")).toBe(false)
})

test("安全边界无法减少轮数时保留原请求，不删除历史或拆开工具链", () => {
  const input = conversation(101)
  input.splice(1, 0, { type: "function_call", call_id: "old-pending", name: "f", arguments: "{}" })
  expect(packResponsesHistory(input)).toBe(input)
})

test("近期 item_reference 引用的旧条目留在原结构中", () => {
  const input = conversation(101)
  input[9].id = "referenced-message"
  input.push({ type: "item_reference", id: "referenced-message" })
  const packed = packResponsesHistory(input)
  expect(packed).toContain(input[9])
  expect(packed.at(-1)).toEqual(input.at(-1))
  expect(archivedItems(packed).some(item => item.id === "referenced-message")).toBe(false)
})

test("旧图片、文件和音频继续作为原生内容发送，原文和元数据保留", () => {
  const input = conversation(101)
  const attachments = [
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
    { type: "input_file", filename: "original.txt", file_data: "data:text/plain;base64,YWJj" },
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
  ]
  input[0].content.push(...attachments)
  const packed = packResponsesHistory(input)
  for (const attachment of attachments) expect(packed[0].content).toContainEqual(attachment)
  const old = archivedItems(packed)
  expect(old[0].content[0]).toEqual(input[0].content[0])
  expect(old[0].content.slice(1).map(part => part.archived_attachment)).toEqual([1, 2, 3])
  expect(packed[0].content[1].text).not.toContain("data:image/png;base64,AAAA")
})

test("已完成的旧工具链原始 JSON 完整保存在历史中", () => {
  const input = conversation(101)
  const call = { type: "function_call", call_id: "old-completed", name: "read", arguments: '{"path":"a.txt"}' }
  const output = { type: "function_call_output", call_id: "old-completed", output: "原始结果\n第二行" }
  input.splice(1, 0, call, output)
  const packed = packResponsesHistory(input)
  expect(archivedItems(packed).slice(1, 3)).toEqual([call, output])
  expect([...archivedItems(packed), ...packed.slice(1)]).toEqual(input)
})

test("旧电脑截图继续作为图片发送，同时保留工具结果的原始字段", () => {
  const input = conversation(101)
  input.splice(1, 0,
    { type: "computer_call", call_id: "old-screen", action: { type: "screenshot" } },
    { type: "computer_call_output", call_id: "old-screen", output: {
      type: "computer_screenshot", image_url: "data:image/png;base64,BBBB", extra: "original",
    } },
  )
  const packed = packResponsesHistory(input)
  expect(packed[0].content).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,BBBB" })
  expect(archivedItems(packed)[2]).toEqual({
    type: "computer_call_output", call_id: "old-screen", output: {
      type: "computer_screenshot", image_url: { archived_attachment: 1 }, extra: "original",
    },
  })
})

test("Responses 规范化先保留系统指令，再封装旧历史", () => {
  const input = [{ role: "system", content: "system-original" }, ...conversation(101)]
  const out = JSON.parse(_internal.normalizeResponsesBody(JSON.stringify({ input, instructions: "existing" })))
  expect(out.instructions).toBe("existing\n\nsystem-original")
  expect(out.input.filter(item => item.role === "user").length).toBe(96)
  expect([...archivedItems(out.input), ...out.input.slice(1)]).toEqual(input.slice(1))
})

test("允许关闭历史合并，Chat Completions 请求保持原样", () => {
  const input = conversation(101)
  const out = JSON.parse(_internal.normalizeResponsesBody(JSON.stringify({ input }), { historyPacking: false }))
  expect(out.input).toEqual(input)
  const chat = JSON.stringify({ messages: input })
  expect(_internal.normalizeResponsesBody(chat)).toBe(chat)
})

test.each([true, false])("loader 发送请求时遵守 historyPacking=%s", async (historyPacking) => {
  const original = globalThis.fetch
  let sent
  try {
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init.body))
      return Response.json({ output: [] })
    }
    const plugin = await XingchiPlugin({ client: {} }, { historyPacking })
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test-history" }))
    const input = conversation(101)
    await loader.fetch("https://api.xingchiapi.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, model: "gpt-6.1-sol" }),
    })
    expect(sent.input.filter(item => item.role === "user").length).toBe(historyPacking ? 96 : 101)
    if (historyPacking) expect([...archivedItems(sent.input), ...sent.input.slice(1)]).toEqual(input)
    else expect(sent.input).toEqual(input)
  } finally {
    globalThis.fetch = original
  }
})
