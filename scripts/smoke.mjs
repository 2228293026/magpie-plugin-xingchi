// 真网关冒烟测试：模拟 magpie 宿主调用插件钩子，打到 api.xingchiapi.com。
// 用法：XINGCHI_API_KEY=sk-... bun run scripts/smoke.mjs
//
// 模型不写死：网关的账号池会变（今天能用的模型明天可能就不在池子里了），
// 所以先拉实时清单，再挑一个当前可用的模型来测。
import { XingchiPlugin } from "../index.mjs"

const KEY = process.env.XINGCHI_API_KEY
if (!KEY) {
  console.error("缺少 XINGCHI_API_KEY")
  process.exit(2)
}
const BASE = "https://api.xingchiapi.com/v1"

const hooks = await XingchiPlugin({ client: {} }, {})

const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider.xingchi
console.log("provider:", provider.name, provider.npm, provider.api)
console.log("静态兜底清单:", Object.keys(provider.models).length, "个")

const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
console.log("loader baseURL:", loader.baseURL, "hasFetch:", typeof loader.fetch)

const live = await hooks.provider.models(provider, { auth: { type: "api", key: KEY } })
console.log("实时清单:", Object.keys(live).length, "->", Object.keys(live).join(","))
console.log(
  "tool_call 探测结果:",
  Object.entries(live)
    .map(([id, m]) => `${id}=${m.tool_call}`)
    .join(" "),
)

const usage = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
console.log("usage:", JSON.stringify(usage))

const ids = Object.keys(live)
if (!ids.length) {
  console.error("网关没有可用模型，跳过请求测试")
  process.exit(1)
}
// 优先挑一个探测出支持工具的模型来测工具调用。
const MODEL = ids.find((id) => live[id].tool_call) ?? ids[0]
console.log("本次测试用的模型:", MODEL)

let failed = false
// 限流或上游抖动也表示本次冒烟未通过，不能把 HTTP 错误当成功。
const ok = (status) => status >= 200 && status < 300

// 带 system 角色 input 项 + previous_response_id 的请求体（网关原样会拒绝）
const rawBody = JSON.stringify({
  model: MODEL,
  previous_response_id: "resp_should_be_removed",
  store: true,
  input: [
    { role: "system", content: [{ type: "input_text", text: "You are terse." }] },
    { role: "user", content: [{ type: "input_text", text: "Use calc for 2+2 then answer" }] },
  ],
  tools: [
    {
      type: "function",
      name: "calc",
      description: "math",
      parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
    },
  ],
  max_output_tokens: 200,
})

const res = await loader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": "Bun/1.4.2" },
  body: rawBody,
})
const text = await res.text()
console.log("tool request status:", res.status, "| reply head:", text.slice(0, 200))
if (!ok(res.status)) failed = true

// UA 预设：选了 claude 就用 Claude Code 的真实 UA
const claudeHooks = await XingchiPlugin({ client: {} }, { userAgent: "claude" })
const claudeLoader = await claudeHooks.auth.loader(async () => ({ type: "api", key: KEY }))
const claudeRes = await claudeLoader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": "Bun/1.4.2" },
  body: JSON.stringify({ model: MODEL, input: "say hi", max_output_tokens: 16 }),
})
console.log("preset claude UA status:", claudeRes.status)
if (!ok(claudeRes.status)) failed = true
await claudeRes.text()

// UA 被网关拒绝时（选了一个不在白名单的字符串），应回退到默认 UA 再试一次：
// 回退后的请求也必须成功。
const badHooks = await XingchiPlugin({ client: {} }, { userAgent: "zzz/9.9.9" })
const badLoader = await badHooks.auth.loader(async () => ({ type: "api", key: KEY }))
const badRes = await badLoader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: MODEL, input: "say hi", max_output_tokens: 16 }),
})
console.log("rejected UA fallback status:", badRes.status)
if (!ok(badRes.status)) failed = true
await badRes.text()

const simple = await loader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: MODEL, input: "say hi", max_output_tokens: 20 }),
})
console.log("simple status:", simple.status, "|", (await simple.text()).slice(0, 140))
if (!ok(simple.status)) failed = true

const stream = await loader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({ model: MODEL, input: "say hi", stream: true, max_output_tokens: 20 }),
})
const sse = await stream.text()
const events = [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]).join(",")
console.log("stream status:", stream.status, "| events:", events)
if (!ok(stream.status)) failed = true
if (ok(stream.status) && !events.includes("response.completed")) failed = true

console.log(failed ? "SMOKE FAILED" : "SMOKE OK")
process.exit(failed ? 1 : 0)
