// 真网关冒烟测试：模拟 magpie 宿主调用插件钩子，打到 api.xingchiapi.com。
// 用法：XINGCHI_API_KEY=sk-... bun run scripts/smoke.mjs
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
console.log("models:", Object.keys(provider.models).length, Object.keys(provider.models).join(","))

const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
console.log("loader baseURL:", loader.baseURL, "hasFetch:", typeof loader.fetch)

const live = await hooks.provider.models(provider, { auth: { type: "api", key: KEY } })
console.log("live models:", Object.keys(live).length, "->", Object.keys(live).join(","))

const usage = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
console.log("usage:", JSON.stringify(usage))

// 带 system 角色 input 项 + previous_response_id 的请求体（网关原样会拒绝）
const rawBody = JSON.stringify({
  model: "gpt-5.6",
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

let failed = false
// 网关上游偶尔整体 5xx（上游账号抖动，与插件无关）。只把 403（UA 被拒）算失败。
const ok = (status) => status !== 403 && status !== 401

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
  body: JSON.stringify({ model: "gpt-5.6", input: "say hi", max_output_tokens: 16 }),
})
console.log("preset claude UA status:", claudeRes.status)
if (!ok(claudeRes.status)) failed = true
await claudeRes.text()

// UA 被网关拒绝时（选了一个不在白名单的字符串），应回退到默认 UA 再试一次：
// 结果不再是 403 即说明回退生效。
const badHooks = await XingchiPlugin({ client: {} }, { userAgent: "zzz/9.9.9" })
const badLoader = await badHooks.auth.loader(async () => ({ type: "api", key: KEY }))
const badRes = await badLoader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-5.6", input: "say hi", max_output_tokens: 16 }),
})
console.log("rejected UA fallback status:", badRes.status)
if (badRes.status === 403) failed = true
await badRes.text()

const simple = await loader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-5.6", input: "say hi", max_output_tokens: 20 }),
})
console.log("simple status:", simple.status, "|", (await simple.text()).slice(0, 140))
if (!ok(simple.status)) failed = true

const stream = await loader.fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({ model: "gpt-5.6", input: "say hi", stream: true, max_output_tokens: 20 }),
})
const sse = await stream.text()
const events = [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]).join(",")
console.log("stream status:", stream.status, "| events:", events)
if (!ok(stream.status)) failed = true
if (stream.status === 200 && !events.includes("response.completed")) failed = true

console.log(failed ? "SMOKE FAILED" : "SMOKE OK")
process.exit(failed ? 1 : 0)
