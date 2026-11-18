// magpie / OpenCode provider plugin: 星驰 (api.xingchiapi.com)
//
// 两个网关特性必须在这里处理：
//
// 1) UA 白名单：网关按 User-Agent 的第一段（"/" 之前）判定客户端，只放行
//    真实的编程客户端。实测规则：
//      - 只看第一段，版本号不参与校验（opencode/任意版本都放行，zzz/ 拒绝）；
//      - 大小写不敏感（OPENCODE/1.0 与 opencode/1.0 都放行）；
//      - 必须是 "<token>/..." 的形式，单独的 "opencode" 被拒。
//    网关自报的支持列表（Codex、Kilo、Roo、Copilot、Grok 等）与实际放行集
//    不一致——codex_cli_rs、kilo、roo、copilot、grok-cli 实测都被 403 拒绝。
//    Bun 默认发 "Bun/x.y.z"，不在名单里，会被 client_not_allowed 拒绝。
//    所以每次请求都要显式带一个放行的客户端 token；上游 agent 自带的 UA
//    若已在名单里就保留，否则换成 UA_PRESETS 里的默认项。
//
// 2) 协议：网关不支持 Responses 的 store / previous_response_id 链式
//    （previous_response_id is not available for this user），并且会把
//    input 数组里的 system / developer 角色丢掉——只发这些角色时上游会报
//    "One of input or previous_response_id ... must be provided"。
//    因此这里强制 store:false、删掉 previous_response_id，并把 system/developer
//    消息提升成 instructions。

const PROVIDER = "xingchi"
const BASE_URL = "https://api.xingchiapi.com/v1"

// 网关放行的客户端 token（UA 的 "<token>/" 位置，实测）。
const ALLOWED_UA_TOKENS = new Set([
  "claude-cli",
  "claude-code",
  "opencode",
  "omp",
  "pi",
  "cline",
  "cursor",
  "trae",
  "qoder",
  "minis",
  "zcode",
  "hermes",
  "hermes-agent",
  "workbuddy",
  "deepseek-harness",
  "kilo-code",
  "roo-code",
])

// 真实客户端的 User-Agent 预设：客户端名与版本格式都取自客户端本身
// （版本号取各自 npm 上的当前版本）。
// 供 options.userAgent 选择，也用作默认 UA。
const UA_PRESETS = {
  opencode: "opencode/1.19.6",
  claude: "claude-cli/2.1.327 (external, cli)",
  cline: "Cline/3.0.74",
  cursor: "Cursor/1.0.3",
  omp: "omp/18.22.2",
  pi: "pi/1.5.2 (darwin; node; arm64)",
  kilo: "kilo-code/7.8.27",
  roo: "Roo-Code/3.0.0",
}

const DEFAULT_UA_KEY = "opencode"
const DEFAULT_UA = UA_PRESETS[DEFAULT_UA_KEY]

// 文本模型（网关另有 gpt-image-* 图片模型，其生图接口对本账号未开通，故不暴露）。
// context/output 取 omp 内置目录里同名 id 的值（gpt-5.6-* 与 gpt-6-* 为 272000/128000，
// gpt-6.1-* 为 500000/128000）；目录里没有的按 omp 的通用默认值 128000/32768。
// tools:false = 该模型在本账号的上游通道上不支持工具调用（实测），别让 agent 选它做工具活。
const MODELS = {
  "gpt-5.6": { name: "GPT-5.6", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6": { name: "GPT-6", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-sol": { name: "GPT-6 Sol", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-luna": { name: "GPT-6 Luna", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-astra": { name: "GPT-6 Astra", context: 272000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  // 这两个模型的上游通道只支持 Chat Completions，带工具调用时被网关拒绝（与推理无关）：
  // "gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions"
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", context: 500000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"], tools: false },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", context: 500000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"], tools: false },
  "gpt-5.5": { name: "GPT-5.5", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.4": { name: "GPT-5.4", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.4-mini": { name: "GPT-5.4 Mini", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.3-codex-spark": { name: "GPT-5.3 Codex Spark", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.2": { name: "GPT-5.2", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
  "codex-auto-review": { name: "Codex Auto Review", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh"] },
}

function uaToken(ua) {
  if (!ua) return null
  const slash = ua.indexOf("/")
  if (slash <= 0) return null
  return ua.slice(0, slash).trim().toLowerCase()
}

// options.userAgent 可以是预设名（opencode / claude / cline / cursor / omp /
// pi / kilo / roo），也可以是完整的 UA 字符串（"claude-cli/2.1.327 (external, cli)"）。
function resolveUserAgent(option) {
  if (!option) return null
  const preset = UA_PRESETS[String(option).trim().toLowerCase()]
  if (preset) return preset
  return uaToken(option) ? String(option) : null
}

function pickUserAgent(current, override) {
  if (override && uaToken(override)) return override
  const token = uaToken(current)
  if (token && ALLOWED_UA_TOKENS.has(token)) return current
  return DEFAULT_UA
}

function itemText(item) {
  const content = item?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part.text === "string") return part.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

// 把 Responses 请求体改写成网关能接受的形式。
function normalizeResponsesBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!body || typeof body !== "object") return text

  // 只有 Responses 形态（带 input 字段）才做下面这些改写；chat completions 原样放行。
  if (!("input" in body)) return text

  // 网关没有 store 链，previous_response_id 一律被拒。
  if ("previous_response_id" in body) delete body.previous_response_id
  body.store = false

  if (Array.isArray(body.input)) {
    const kept = []
    const systemParts = []
    for (const item of body.input) {
      const role = item && typeof item === "object" ? item.role : undefined
      if (role === "system" || role === "developer") {
        const t = itemText(item)
        if (t) systemParts.push(t)
        continue
      }
      kept.push(item)
    }
    if (systemParts.length) {
      if (kept.length) {
        body.input = kept
        body.instructions = [body.instructions, ...systemParts].filter(Boolean).join("\n\n")
      } else {
        // 网关要求 input 里至少有 user 内容；只有 system 时降级成一条 user 消息。
        body.input = [{ role: "user", content: [{ type: "input_text", text: systemParts.join("\n\n") }] }]
        delete body.instructions
      }
    }
  }

  return JSON.stringify(body)
}

function modelEntry(spec, id) {
  const variants = {}
  for (const effort of spec.efforts) variants[effort] = {}
  return {
    id,
    name: spec.name,
    limit: { context: spec.context, output: spec.output },
    reasoning: true,
    tool_call: spec.tools !== false,
    modalities: { input: ["text"] },
    variants,
  }
}

export const _internal = {
  normalizeResponsesBody,
  pickUserAgent,
  resolveUserAgent,
  uaToken,
  ALLOWED_UA_TOKENS,
  UA_PRESETS,
  DEFAULT_UA,
}

export const XingchiPlugin = async (_input, options) => {
  const baseUrl = options?.baseUrl ?? BASE_URL
  // options.userAgent：预设名或完整 UA 字符串。选了预设就一定用它，
  // 不选则沿用上游 agent 自带的 UA（若网关放行）。
  const userAgent = resolveUserAgent(options?.userAgent)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "星驰 Xingchi",
        npm: "@ai-sdk/openai", // OpenAI Responses
        api: baseUrl,
        models: Object.fromEntries(Object.entries(MODELS).map(([id, spec]) => [id, modelEntry(spec, id)])),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "Xingchi API key", placeholder: "sk-…" }],
      // 网关额度：/v1/usage 返回 quota {limit, used, remaining, unit}
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "没有登录", windows: [] }
        try {
          const res = await fetch(`${baseUrl}/usage`, {
            headers: { authorization: `Bearer ${auth.key}`, "user-agent": pickUserAgent(null, userAgent) },
          })
          if (!res.ok) return { error: `星驰 answered ${res.status}`, windows: [] }
          const u = await res.json()
          const quota = u?.quota ?? {}
          const limit = Number(quota.limit)
          const used = Number(quota.used)
          const remaining = Number(quota.remaining)
          const unit = typeof quota.unit === "string" ? quota.unit : "USD"
          const windows = []
          if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
            windows.push({
              name: "额度",
              used: (used / limit) * 100,
              amount: used,
              limit,
              unit,
              display: `${used.toFixed(2)} / ${limit} ${unit}`,
            })
          }
          const out = { plan: u?.mode ?? null, windows }
          if (Number.isFinite(remaining)) out.balance = `${remaining.toFixed(2)} ${unit}`
          return out
        } catch (err) {
          return { error: String(err?.message ?? err), windows: [] }
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          baseURL: baseUrl,
          apiKey: auth.key,
          headers: { "User-Agent": pickUserAgent(null, userAgent) },
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            if (!headers.get("authorization")) headers.set("authorization", `Bearer ${auth.key}`)
            headers.set("user-agent", pickUserAgent(headers.get("user-agent"), userAgent))

            let body = init?.body
            let replayable = false
            if (body != null && !headers.get("content-type")?.includes("multipart")) {
              const text = typeof body === "string" ? body : new TextDecoder().decode(body)
              const normalized = normalizeResponsesBody(text)
              body = typeof body === "string" ? normalized : new TextEncoder().encode(normalized)
              replayable = true
            }

            const res = await fetch(input, { ...init, headers, body })

            // 网关按 UA 第一段放行客户端；选了不被放行的 UA 时回退到默认 UA 再试一次。
            if (res.status === 403 && replayable && headers.get("user-agent") !== DEFAULT_UA) {
              const peek = await res.clone().text()
              if (peek.includes("client_not_allowed")) {
                const retry = new Headers(headers)
                retry.set("user-agent", DEFAULT_UA)
                return await fetch(input, { ...init, headers: retry, body })
              }
            }
            return res
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        try {
          const res = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${auth.key}`, "user-agent": pickUserAgent(null, userAgent) },
          })
          if (!res.ok) return provider.models
          const { data } = await res.json()
          if (!Array.isArray(data)) return provider.models
          const out = { ...provider.models }
          for (const row of data) {
            const id = row?.id
            if (!id || id.startsWith("gpt-image")) continue
            const spec = MODELS[id]
            if (spec) {
              out[id] = modelEntry(spec, id)
              continue
            }
            // 网关上新出现的文本模型：保守的上下文/输出上限，避免超过上游限制。
            out[id] = {
              id,
              name: row.display_name ?? id,
              limit: { context: 128000, output: 32768 },
              reasoning: false,
              tool_call: true,
              modalities: { input: ["text"] },
            }
          }
          return out
        } catch {
          return provider.models
        }
      },
    },
  }
}
