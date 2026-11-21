// magpie / OpenCode provider plugin: 星驰 (api.xingchiapi.com)
//
// 三个网关特性必须在这里处理：
//
// 1) UA 白名单：网关按 User-Agent 的第一段（"/" 之前）判定客户端，只放行
//    真实的编程客户端。实测规则：
//      - 只看第一段，版本号不参与校验（opencode/任意版本都放行，zzz/ 拒绝）；
//      - 大小写不敏感（OPENCODE/1.0 与 opencode/1.0 都放行）；
//      - 必须是 "<token>/..." 的形式，单独的 opencode 被拒。
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
//
// 3) 每日签到：签到不在网关的 /v1 下，而在面板的 /api/v1 下，且用网页登录的
//    JWT 鉴权（不是 API key）。面板登录本身被 Cloudflare Turnstile 守着，
//    无法程序化登录，只能由用户从浏览器里复制令牌过来（见下面的「网页令牌」）。

import { readFile, writeFile } from "node:fs/promises"
import { dirname, join as joinPath } from "node:path"
import { fileURLToPath } from "node:url"

import { openBrowserSession } from "./browser.mjs"
import { packResponsesHistory } from "./history.mjs"

const PROVIDER = "xingchi"
const BASE_URL = "https://api.xingchiapi.com/v1"
// 面板站点（浏览器登录用）
const PANEL_SITE = "https://xingchiapi.com"
const PANEL_LOGIN = `${PANEL_SITE}/login`

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

// 文本模型的静态兜底清单（网关另有 gpt-image-* 图片模型，其生图接口对本账号未开通，故不暴露）。
// context/output 取上游模型目录（https://models.dev/api.json，2026-11-20）中的总上下文/输出值。
// GPT-6.1 Sol 按用户指定使用模型 API 规格 1050000/128000；星驰该 Key 的 Codex 清单
// 单独报告默认 500000、最大 872000。gpt-6 是 gpt-6-astra 的别名；codex-auto-review
// 没有目录记录，保留 128000/32768 通用兜底。
//
// 这份清单只是兜底：登录后 provider.models 钩子会拉网关的实时清单，并逐个实测
// 模型能不能带工具调用（见 probeToolSupport）。网关按模型分上游账号池，池子会变
// （同一个模型昨天不支持工具、今天支持），所以能力不能写死在清单里。
const MODELS = {
  "gpt-5.6": { name: "GPT-5.6", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6": { name: "GPT-6", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-sol": { name: "GPT-6 Sol", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-luna": { name: "GPT-6 Luna", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-astra": { name: "GPT-6 Astra", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.5": { name: "GPT-5.5", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.4": { name: "GPT-5.4", context: 1050000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.4-mini": { name: "GPT-5.4 Mini", context: 400000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.3-codex-spark": { name: "GPT-5.3 Codex Spark", context: 128000, output: 32000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.2": { name: "GPT-5.2", context: 400000, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "codex-auto-review": { name: "Codex Auto Review", context: 128000, output: 32768, efforts: ["low", "medium", "high", "xhigh", "max"] },
}

// ---- 面板 API（每日签到） -----------------------------------------------
//
// 面板 API 与网关同主机，但挂在 /api/v1 下：
//
//   GET  /api/v1/user/checkin
//        -> { enabled, claimed_today, amount, total_count, total_amount }
//   POST /api/v1/user/checkin
//        -> { status: { ...同上 }, amount }
//   重复领取时返回 { code, message, reason: "CHECKIN_ALREADY_CLAIMED" }
//
// 鉴权用的是网页登录的 JWT（jwt_auth 中间件），API key 会被判成
// INVALID_TOKEN。面板登录本身被 Cloudflare Turnstile 挡着
// （POST /api/v1/auth/login 不带 turnstile_token 时返回
//  "turnstile verification failed"），没法程序化登录，所以令牌由用户从
// 浏览器 localStorage 里复制过来。
const PANEL_PREFIX = "/api/v1"

// 网关地址是 https://host/v1，面板地址是 https://host/api/v1。
function panelBaseFrom(baseUrl) {
  const trimmed = String(baseUrl ?? "").replace(/\/+$/, "")
  if (!trimmed) return ""
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed
}

function panelUrl(panelBase, path) {
  return `${String(panelBase).replace(/\/+$/, "")}${PANEL_PREFIX}${path}`
}

// 面板响应统一包一层 { code: 0, message: "success", data: {...} }，
// 错误则是 { code, message, reason? }。这里统一拆成 { status, ok, data, reason, message }。
async function panelRequest(panelBase, path, options = {}) {
  const { token, method = "GET", body, ua } = options
  const headers = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  if (ua) headers["user-agent"] = ua
  if (body !== undefined) headers["content-type"] = "application/json"

  const res = await fetch(panelUrl(panelBase, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // 面板挂了就当没有，不能把宿主的额度查询一起拖死
    signal: AbortSignal.timeout(10000),
  })

  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const payload =
    parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed

  return {
    status: res.status,
    ok: res.ok,
    data: payload,
    reason: parsed && typeof parsed === "object" ? parsed.reason : undefined,
    message: parsed && typeof parsed === "object" ? parsed.message : undefined,
  }
}

// 面板的分页返回形状各版本不一样，这里把可能的容器都摊平。
function extractList(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return []
  for (const field of ["items", "list", "records", "rows", "data"]) {
    const value = data[field]
    if (Array.isArray(value)) return value
  }
  return []
}

// 用 refresh_token 换一个新的面板会话。
async function refreshPanelSession(panelBase, refreshToken, ua) {
  if (!refreshToken) return null
  try {
    const res = await panelRequest(panelBase, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      ua,
    })
    if (!res.ok) return null
    const data = res.data ?? {}
    if (!data.access_token) return null
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    }
  } catch {
    return null
  }
}

// 找一个用户可用的分组。新建/修复 key 时必须带上 group_id，
// 否则网关会直接回 403："API Key is not assigned to any group and cannot be used"。
async function resolveGroupId(panelBase, token, ua) {
  try {
    const res = await panelRequest(panelBase, "/groups/available", { token, ua })
    if (!res.ok) return 0
    const list = Array.isArray(res.data) ? res.data : extractList(res.data)
    const active = list.find((group) => {
      const status = String(group?.status ?? "").toLowerCase()
      return status === "" || status === "active"
    })
    return Number(active?.id) || 0
  } catch {
    return 0
  }
}

// ---- 分组（渠道）与倍率 ------------------------------------------------
//
// 面板按分组（渠道）划分模型：每个分组有自己的倍率（rate_multiplier）和自己的
// 模型清单，而一把 API key 只属于一个分组。所以「同时显示全部渠道」需要每个
// 分组各配一把 key，请求时按模型带走的分组标记选对应的那把。
//
// 模型 id 上带的分组标记形如 "gpt-6.1-sol-g4"，倍率只写在显示名里
// （"GPT-6.1 Sol · 1x"）。标记会经 apiId 传到 loader，loader 据此换 key
// 并把标记从请求体里去掉。
const GROUP_MARK = /-g(\d+)$/

function rateLabel(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return "1x"
  return String(n) + "x"
}

function isActiveKey(key) {
  const status = String(key?.status ?? "").toLowerCase()
  return status === "" || status === "active" || status === "enabled"
}

// 分组信息缓存：面板的分组（名字、倍率）是站点级的，各账号通用。
// 有面板会话的账号会把分组信息放进这里；只有 API key 的账号（没有面板会话）
// 等一下就能拿到，名字照样带倍率。
let groupCache = null

// 分组信息缓存放在 magpie 的配置目录里：magpie 的模型列举是串行的，只有 API key
// 的账号会排在前面，它读文件就知道别的渠道叫什么、倍率多少。
//
// 不能放在插件自己旁边：magpie 每秒扫一遍按路径安装的插件目录，文件一动就判定
// 宿主过期，把正在服务请求的插件宿主杀掉重启——正在传的上游连接因此被重置，
// 请求报 502（ECONNRESET）。所以落在配置目录（宿主 cwd），那里不受影响。
const GROUPS_FILE = "xingchi-groups.json"

// magpie 传给插件的配置目录（input.directory / input.worktree 都是它）。
let magpieDir = ""

function groupsFilePath() {
  if (!magpieDir) return null
  return joinPath(magpieDir, GROUPS_FILE)
}

// 旧版本把缓存写在插件目录里：读它，是为了迁移过来而不是从头再列一遍。
function legacyGroupsFilePath() {
  try {
    return joinPath(dirname(fileURLToPath(import.meta.url)), GROUPS_FILE)
  } catch {
    return null
  }
}

// 写过的内容：内容没变就不写，免得白白动一次磁盘。
let lastGroupCacheText = ""

async function readGroupCache() {
  const path = groupsFilePath()
  const legacy = legacyGroupsFilePath()
  for (const p of [path, legacy]) {
    if (!p) continue
    try {
      const data = JSON.parse(await readFile(p, "utf8"))
      if (data && typeof data === "object") return data
    } catch {
      // 没有或读不了：试下一个
    }
  }
  return null
}

async function writeGroupCache(data) {
  const path = groupsFilePath()
  if (!path) return
  let text
  try {
    text = JSON.stringify(data)
  } catch {
    return
  }
  if (text === lastGroupCacheText) return
  try {
    await writeFile(path, text, "utf8")
    lastGroupCacheText = text
  } catch {
    // 写不了也不影响列模型
  }
}

// 面板给这个账号开放的分组
async function listGroups(panelBase, token, ua) {
  try {
    const res = await panelRequest(panelBase, "/groups/available", { token, ua })
    if (!res.ok) return []
    const list = Array.isArray(res.data) ? res.data : extractList(res.data)
    return list
      .map((g) => ({
        id: Number(g?.id),
        name: typeof g?.name === "string" ? g.name : "",
        rate: Number(g?.rate_multiplier ?? 1) || 1,
        // balance_source=dedicated 的分组从「专属余额」里扣，没余额就列了也用不了
        source: typeof g?.balance_source === "string" ? g.balance_source : "normal",
        maxEffort: typeof g?.max_reasoning_effort === "string" ? g.max_reasoning_effort : "",
      }))
      .filter((g) => Number.isFinite(g.id))
  } catch {
    return []
  }
}

// 面板里这个账号已有的 key
async function listPanelKeys(panelBase, token, ua) {
  try {
    const res = await panelRequest(panelBase, "/keys", { token, ua })
    if (!res.ok) return []
    return extractList(res.data)
  } catch {
    return []
  }
}

async function createPanelKey(panelBase, token, ua, name, groupId) {
  try {
    const res = await panelRequest(panelBase, "/keys", {
      method: "POST",
      token,
      ua,
      body: { name, group_id: groupId },
    })
    if (res.ok && res.data?.key) {
      return { key: res.data.key, id: res.data.id, group_id: groupId }
    }
  } catch {
    // 忽略
  }
  return null
}

// 每个分组配一把 key：现成的优先，没有就建一把（名字 magpie-g<分组id>）。
async function ensureGroupKeys(panelBase, token, ua) {
  const groups = await listGroups(panelBase, token, ua)
  if (!groups.length) return { groups: [], groupKeys: {} }
  const keys = await listPanelKeys(panelBase, token, ua)
  const groupKeys = {}
  const keyGroups = {}
  for (const g of groups) {
    const existing = keys.find(
      (k) => Number(k?.group_id) === g.id && isActiveKey(k) && typeof k?.key === "string" && k.key,
    )
    if (existing) {
      groupKeys[g.id] = existing.key
      keyGroups[existing.key] = g.id
      continue
    }
    const created = await createPanelKey(panelBase, token, ua, `magpie-g${g.id}`, g.id)
    if (created) {
      groupKeys[g.id] = created.key
      keyGroups[created.key] = g.id
    }
  }
  return { groups, groupKeys, keyGroups }
}

// 某个 key 能用的模型
async function listModelsForKey(key, ua) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}`, "user-agent": ua },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray(body?.data) ? body.data : []
  } catch {
    return []
  }
}

// 面板账号的余额：普通余额与专属余额
async function readPanelBalances(panelBase, token, ua) {
  try {
    const res = await panelRequest(panelBase, "/user/profile", { token, ua })
    if (!res.ok) return null
    return {
      balance: Number(res.data?.balance),
      dedicated: Number(res.data?.dedicated_balance),
    }
  } catch {
    return null
  }
}

// 这个分组现在还有余额可用吗
function groupUsable(group, balances) {
  if (!balances) return true
  const pool = group.source === "dedicated" ? balances.dedicated : balances.balance
  return Number.isFinite(pool) ? pool > 0 : true
}

// 账号里记着的「每组一把 key」
function groupKeysOf(auth) {
  const value = auth?.metadata?.groupKeys
  return value && typeof value === "object" ? value : {}
}

// 把每组一把 key 记到账号里，loader 才知道请求该用哪把。
async function saveGroupKeys(input, auth, groupKeys, primary) {
  try {
    const metadata = { ...(auth?.metadata ?? {}), groupKeys, primaryGroup: primary }
    await input?.client?.auth?.set?.({
      path: { id: PROVIDER },
      body: { ...auth, metadata },
    })
  } catch {
    // 存不进去也不影响这次列模型
  }
}

// 请求体里的模型名，带分组标记时一并给出
function modelInBody(text) {
  try {
    const body = JSON.parse(text)
    const model = typeof body?.model === "string" ? body.model : null
    if (!model) return null
    const m = GROUP_MARK.exec(model)
    if (!m) return null
    return { raw: model, group: m[1] }
  } catch {
    return null
  }
}

// 把模型名里的分组标记去掉
function stripModelMark(text, raw) {
  try {
    const body = JSON.parse(text)
    if (typeof body?.model === "string") body.model = raw.replace(GROUP_MARK, "")
    return JSON.stringify(body)
  } catch {
    return text
  }
}

// 从面板会话里挑一把可用的 API key。
//
// 三步：
//   1. 已有绑好分组的 key —— 直接用；
//   2. 只有没绑分组的（多半是之前建的）—— 给它补上分组再���
//   3. 一把都没有 —— 新建一把，并且必须带上 group_id。
async function resolvePanelApiKey(panelBase, token, ua) {
  let list = []
  try {
    const res = await panelRequest(panelBase, "/keys", { token, ua })
    if (res.ok) list = extractList(res.data)
  } catch {
    // 列表拿不到就往下走
  }

  const isActive = (item) => {
    const status = String(item?.status ?? "").toLowerCase()
    return status === "" || status === "active" || status === "enabled"
  }
  const hasGroup = (item) => item?.group_id !== null && item?.group_id !== undefined

  // 1. 有分组且可用
  const usable = list.find((item) => isActive(item) && hasGroup(item) && item?.key)
  if (usable) return usable.key

  const groupId = await resolveGroupId(panelBase, token, ua)

  // 2. 之前建的没分组 key（名字是插件自己起的），给它补上分组
  const orphan = list.find(
    (item) => isActive(item) && !hasGroup(item) && item?.key && item?.name === "magpie",
  )
  if (orphan && groupId && orphan.id) {
    try {
      const updated = await panelRequest(panelBase, `/keys/${orphan.id}`, {
        method: "PUT",
        token,
        ua,
        body: { group_id: groupId },
      })
      if (updated.ok) {
        const key = updated.data?.key ?? orphan.key
        if (key) return key
      }
    } catch {
      // 补不上就新建
    }
  }

  // 3. 新建一把，必须带上分组
  try {
    const created = await panelRequest(panelBase, "/keys", {
      method: "POST",
      token,
      ua,
      body: { name: "magpie", ...(groupId ? { group_id: groupId } : {}) },
    })
    if (created.ok && created.data?.key) return created.data.key
  } catch {
    // 忽略
  }
  return ""
}

// 用户粘贴的令牌可能是裸 token，也可能是浏览器里 copy 出来的 JSON 块。
function parseTokenInput(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return { accessToken: "", refreshToken: "" }
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text)
      return {
        accessToken: String(obj.access_token ?? obj.accessToken ?? obj.token ?? "").trim(),
        refreshToken: String(obj.refresh_token ?? obj.refreshToken ?? "").trim(),
      }
    } catch {
      // 不是 JSON，当作裸 token
    }
  }
  return { accessToken: text, refreshToken: "" }
}

// 把签到状态翻译成 magpie 的 checkin 结果。
// outcome: claimed / done / ineligible / inactive / captcha / failed
function classifyCheckin(status, amount) {
  if (!status || typeof status !== "object") {
    return { outcome: "failed", message: "签到状态返回异常" }
  }
  if (status.enabled === false) {
    return { outcome: "inactive", message: "站点当前没有开启每日签到活动" }
  }
  if (status.claimed_today === true) {
    const total = typeof status.total_count === "number" ? status.total_count : undefined
    return {
      outcome: "done",
      streak: total,
      message: `今天已签到${total ? `，累计 ${total} 次` : ""}`,
    }
  }
  return {
    outcome: "claimed",
    credit: typeof amount === "number" ? amount : undefined,
    streak: typeof status.total_count === "number" ? status.total_count : undefined,
    message: `签到成功，获得 ${typeof amount === "number" ? amount : 0} 额度`,
  }
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
function normalizeResponsesBody(text, { historyPacking = true } = {}) {
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

  // 推理档位：上游只认 high 和 xhigh —— 它把 max 静默忽略（既不推理也不给摘要），
  // 所以 max/ultra 落到 xhigh，那是它真正支持的最高档。magpie 的 fitEffort 会把
  // ultra 映射成 max 发过来，一并落下来。
  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = String(body.reasoning.effort ?? "").toLowerCase()
    let next = body.reasoning
    if (effort === "max" || effort === "ultra") next = { ...next, effort: "xhigh" }
    // 明确要一次摘要（上游愿意转发时一定转发）
    if (next.summary === undefined) next = { ...next, summary: "auto" }
    body.reasoning = next
  }

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

  if (historyPacking) body.input = packResponsesHistory(body.input)
  return JSON.stringify(body)
}

function modelEntry(spec, id, toolCall = true) {
  const variants = {}
  for (const effort of spec.efforts) variants[effort] = {}
  return {
    id,
    name: spec.name,
    limit: { context: spec.context, output: spec.output },
    reasoning: true,
    tool_call: toolCall,
    modalities: { input: ["text"] },
    variants,
  }
}

// magpie 的 models 钩子读的是内部形状：推理能力在 capabilities 里，
// 发给厂商的模型名在 api.id 里。形状不对，magpie 会当成"这个模型不推理"。
function wireEntry(entry, { apiId, name, rate, reasoning = true } = {}) {
  const out = {
    ...entry,
    id: apiId ?? entry.id,
    name: name ?? entry.name,
    api: { id: apiId ?? entry.id, url: BASE_URL, npm: "@ai-sdk/openai" },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: false,
      toolcall: entry.tool_call !== false,
      input: { text: true },
      output: { text: true },
    },
    variants: entry.variants ?? {},
  }
  if (typeof rate === "number") out.rate = rate
  return out
}

// 同时更新配置形状与宿主内部形状，避免工具能力互相矛盾。
function setToolSupport(entry, supported) {
  entry.tool_call = supported
  entry.capabilities.toolcall = supported
}

// 探测一个模型能不能带工具调用。
//
// 网关按模型分上游账号池，池子会变：同一个模型今天能带工具、明天可能不能
// （换成了只支持 Chat Completions 的上游，就报
// "requires Responses for tool calls; this account only supports Chat Completions"）。
// 所以能力只能现测，不能写死在清单里。
//
// 用 tool_choice 强制调用来探测：只带 tools 而不强制，模型可以走纯文本回答，
// 网关的通道检查就不会触发（实测 tool_choice:none 在不支持工具的通道上也通过）。
//
// 返回 true / false；探测本身失败（限流、模型已不在池子里、网络问题）返回 null，
// 表示"这次没测出来"，调用方应保留原值而不是当成 false。
async function probeToolSupport(baseUrl, key, model, ua) {
  try {
    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": ua,
      },
      body: JSON.stringify({
        model,
        input: "probe",
        tools: [
          {
            type: "function",
            name: "probe_tool",
            description: "Tool support probe. Never call it.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        tool_choice: { type: "function", name: "probe_tool" },
        max_output_tokens: 16,
      }),
      // 单个探测卡住不能拖垮整个模型列表
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    if (res.ok) return true
    let message = text
    try {
      message = JSON.parse(text)?.error?.message ?? text
    } catch {}
    // 明确的"不支持工具"才是 false。
    // 注意别把"模型不在账号池里"（not supported by any configured account）
    // 也算进去——那是"这次没测出来"，不是"这个模型不支持工具"。
    if (/only supports chat completions|does not support (tool|function)|tool[_ ]?call[s]? (is |are )?not (supported|available)|tools? (is |are )?not (supported|available|allowed)/i.test(message)) {
      return false
    }
    return null
  } catch {
    return null
  }
}

// 探测结果按 (网关, key, 模型) 缓存，TTL 6 小时：账号池不会几分钟一变，
// 没必要每次登录都重打一轮探测。
const PROBE_TTL_MS = 6 * 60 * 60 * 1000
const probeCache = new Map()

function cacheKey(baseUrl, key, model) {
  return `${baseUrl}\n${key}\n${model}`
}

function cachedProbe(baseUrl, key, model) {
  const hit = probeCache.get(cacheKey(baseUrl, key, model))
  if (!hit) return undefined
  if (Date.now() - hit.at > PROBE_TTL_MS) {
    probeCache.delete(cacheKey(baseUrl, key, model))
    return undefined
  }
  return hit.value
}

function rememberProbe(baseUrl, key, model, value) {
  if (value === null) return
  probeCache.set(cacheKey(baseUrl, key, model), { at: Date.now(), value })
}

// 一次最多 limit 个并发。
async function mapWithLimit(items, limit, fn) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

// 换到新的面板会话后，把新令牌写回账号。写不进去也不影响本次签到。
async function persistPanelSession(input, auth, renewed) {
  try {
    const body =
      auth?.type === "oauth"
        ? {
            type: "oauth",
            access: apiKeyOf(auth),
            refresh: renewed.refreshToken,
            expires: renewed.expiresAt,
            panelToken: renewed.accessToken,
            accountId: emailOf(auth),
            metadata: {
              ...(auth?.metadata ?? {}),
              panelToken: renewed.accessToken,
              refreshToken: renewed.refreshToken,
            },
          }
        : {
            type: "api",
            key: apiKeyOf(auth),
            metadata: {
              ...(auth?.metadata ?? {}),
              accessToken: renewed.accessToken,
              refreshToken: renewed.refreshToken,
            },
          }
    await input?.client?.auth?.set?.({ path: { id: PROVIDER }, body })
  } catch {
    // 忽略
  }
}

// 浏览器登录：起一个浏览器窗口，用户正常登录，插件用 CDP 取回面板令牌。
async function browserAuthorize({ panelBase, userAgent }) {
  const session = await openBrowserSession(PANEL_LOGIN, {
    targetPrefix: `${PANEL_SITE}/`,
  })
  return {
    url: "",
    instructions:
      "在刚打开的浏览器窗口里登录星驰（xingchiapi.com），登录完插件会自动接手。",
    method: "auto",
    opened: true,
    callback: async () => {
      try {
        const found = await session.session(5 * 60 * 1000)
        if (!found?.accessToken) {
          return { type: "failed", error: "登录超时了，请重新发起登录" }
        }
        const ua = pickUserAgent(null, userAgent)
        const key = await resolvePanelApiKey(panelBase, found.accessToken, ua)
        if (!key) {
          return {
            type: "failed",
            error: "没有取到可用的 API key，请到面板「API 密钥」页新建一把后重试",
          }
        }
        return {
          type: "success",
          access: key,
          refresh: found.refreshToken,
          expires: found.expiresAt ?? 0,
          panelToken: found.accessToken,
          accountId: found.email,
          metadata: {
            email: found.email,
            panelToken: found.accessToken,
            refreshToken: found.refreshToken,
          },
        }
      } catch (error) {
        return {
          type: "failed",
          error: String(error?.message ?? error).slice(0, 500),
        }
      } finally {
        await session.close()
      }
    },
  }
}

// 读今天的签到状态，给账号卡片做一个 aside 窗口（不影响路由）。
async function readCheckinWindow(auth, panelBase, ua) {
  const token = String(panelTokenOf(auth) ?? "").trim()
  if (!token) return null
  try {
    const res = await panelRequest(panelBase, "/user/checkin", { token, ua })
    if (!res.ok) return null
    const status = res.data ?? {}
    if (status.enabled === false) return null
    const total = typeof status.total_count === "number" ? status.total_count : 0
    const next = typeof status.next_claim_at === "string" ? status.next_claim_at : ""
    if (status.claimed_today === true) {
      return {
        name: "每日签到",
        display: `今日已签到 · 累计 ${total} 次`,
        ...(next ? { resetsAt: next } : {}),
        aside: true,
      }
    }
    const amount = typeof status.amount === "number" ? status.amount : 0
    return {
      name: "每日签到",
      display: `今日可签到 · 奖励 ${amount} 额度`,
      ...(next ? { resetsAt: next } : {}),
      aside: true,
    }
  } catch {
    return null
  }
}

// 三种登录方式下凭据存放的位置不一样，这里统一读出来：
//   - api 型（粘贴 API key）：key = 网关 key，metadata.accessToken = 面板令牌
//   - oauth 型（浏览器登录）：access = 网关 key，panelToken = 面板令牌
//   - api 型（粘贴面板令牌）：key = 网关 key，metadata.accessToken = 面板令牌
function apiKeyOf(auth) {
  return auth?.key ?? auth?.access ?? auth?.metadata?.apiKey ?? ""
}

function panelTokenOf(auth) {
  return auth?.panelToken ?? auth?.metadata?.panelToken ?? auth?.metadata?.accessToken ?? ""
}

function refreshTokenOf(auth) {
  return auth?.refresh ?? auth?.metadata?.refreshToken ?? ""
}

function emailOf(auth) {
  return auth?.accountId ?? auth?.metadata?.email ?? undefined
}

export const _internal = {
  normalizeResponsesBody,
  pickUserAgent,
  resolveUserAgent,
  uaToken,
  probeToolSupport,
  mapWithLimit,
  classifyCheckin,
  extractList,
  parseTokenInput,
  apiKeyOf,
  panelTokenOf,
  refreshTokenOf,
  emailOf,
  panelBaseFrom,
  panelUrl,
  refreshPanelSession,
  resolvePanelApiKey,
  resolveGroupId,
  rateLabel,
  modelInBody,
  stripModelMark,
  listGroups,
  ensureGroupKeys,
  ALLOWED_UA_TOKENS,
  UA_PRESETS,
  DEFAULT_UA,
}

export const XingchiPlugin = async (input, options) => {
  // magpie 的配置目录：分组缓存放在那里，插件目录不能放（见 GROUPS_FILE 那段）。
  magpieDir = String(input?.directory ?? input?.worktree ?? "").trim()
  const baseUrl = options?.baseUrl ?? BASE_URL
  // 面板地址默认跟着网关走（同一个主机的 /api/v1），也可以单独配。
  const panelBase = options?.panelBaseUrl ?? panelBaseFrom(baseUrl)
  // options.userAgent：预设名或完整 UA 字符串。选了预设就一定用它，
  // 不选则沿用上游 agent 自带的 UA（若网关放行）。
  const userAgent = resolveUserAgent(options?.userAgent)
  const historyPacking = options?.historyPacking !== false

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
      methods: [
        {
          // 点一下就能登录：起一个浏览器窗口让用户正常登录，
          // 插件用 CDP 把面板的会话令牌取回来。
          type: "oauth",
          label: "Xingchi 浏览器登录（可自动签到）",
          authorize: () => browserAuthorize({ panelBase, userAgent }),
        },
        {
          type: "api",
          label: "Xingchi API key",
          placeholder: "sk-…",
        },
        {
          // 网页令牌方式：签到需要面板的 JWT，API key 干不了这事。
          // 面板登录被 Turnstile 守着，只能让用户从浏览器里复制令牌。
          type: "api",
          label: "Xingchi 网页令牌（可自动签到）",
          prompts: [
            {
              type: "password",
              key: "accessToken",
              message: "网页 access_token",
              placeholder: "localStorage 的 auth_token",
            },
            {
              type: "password",
              key: "refreshToken",
              message: "refresh_token（可选，用于自动续期）",
              placeholder: "localStorage 的 refresh_token",
            },
            {
              type: "password",
              key: "apiKey",
              message: "API key（留空则自动选取）",
              placeholder: "sk-…",
            },
          ],
          async authorize(inputs) {
            const parsed = parseTokenInput(inputs?.accessToken)
            const accessToken = parsed.accessToken
            const refreshToken = parsed.refreshToken || String(inputs?.refreshToken ?? "").trim()
            const explicitKey = String(inputs?.apiKey ?? "").trim()
            const ua = pickUserAgent(null, userAgent)

            if (!accessToken) {
              return { type: "failed", error: "缺少 access_token" }
            }

            // 先验一下令牌，顺便拿到账号邮箱。
            let email
            try {
              const me = await panelRequest(panelBase, "/auth/me", { token: accessToken, ua })
              if (!me.ok) {
                return {
                  type: "failed",
                  error: `网页令牌无效：${me.message ?? `HTTP ${me.status}`}`,
                }
              }
              email = me.data?.email ?? undefined
            } catch (err) {
              return { type: "failed", error: `无法访问面板：${String(err?.message ?? err)}` }
            }

            let key = explicitKey
            if (!key) {
              key = await resolvePanelApiKey(panelBase, accessToken, ua)
              if (!key) {
                return {
                  type: "failed",
                  error: "没有取到可用的 API key，请到面板「API 密钥」页新建一把后重试",
                }
              }
            }

            // 每个分组（渠道）各一把 key，这样模型清单能同时列出全部渠道。
            let groupKeys = {}
            let primaryGroup = 0
            try {
              const { groups, groupKeys: gk, keyGroups } = await ensureGroupKeys(
                panelBase,
                accessToken,
                ua,
              )
              groupKeys = gk
              primaryGroup = keyGroups[key] ?? groups[0]?.id ?? 0
              groupCache = {
                groups: Object.fromEntries(
                  groups.map((g) => [String(g.id), { name: g.name, rate: g.rate, source: g.source }]),
                ),
                models: {},
                primary: primaryGroup,
              }
              await writeGroupCache(groupCache)
            } catch {
              // 拿不到分组就不分组
            }

            return {
              type: "success",
              key,
              accountId: email,
              metadata: {
                email,
                accessToken,
                refreshToken,
                groupKeys,
                primaryGroup,
              },
            }
          },
        },
      ],
      // 网关额度。
      //
      // 网关有两种形态，都认：
      //   新：{ balance, remaining, unit, mode, planName, daily_usage, usage }
      //   旧：{ quota: { limit, used, remaining, unit }, usage }
      //
      // 钱包制（mode=unrestricted）没有额度上限，所以「额度」窗口只在网关
      // 真的报了上限时才有；平时给的是「余额」（预付钱包的读数）。
      //
      // 顶层 balance 是关键：magpie 把它记进 balance-history.json，账号卡片
      // 据此画「余额走势」曲线和「每天用掉多少」。
      async usage(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return { error: "没有登录", windows: [] }
        const ua = pickUserAgent(null, userAgent)
        try {
          const res = await fetch(`${baseUrl}/usage`, {
            headers: { authorization: `Bearer ${key}`, "user-agent": ua },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) return { error: `星驰 answered ${res.status}`, windows: [] }
          const u = await res.json()

          const quota = u?.quota ?? {}
          const unit =
            typeof u?.unit === "string"
              ? u.unit
              : typeof quota.unit === "string"
                ? quota.unit
                : "USD"
          const balance = Number(u?.balance ?? quota.remaining)
          const remaining = Number(u?.remaining ?? quota.remaining)
          const limit = Number(quota.limit)
          const used = Number(quota.used)

          const today = u?.usage?.today ?? {}
          const requests = Number(today.requests)
          const tokens = Number(today.total_tokens)

          // 各天的花费。网关的 usage.total 是它们的和；拿不到就按天累加。
          const days = Array.isArray(u?.daily_usage) ? u.daily_usage : []
          const sumDays = () =>
            days.reduce((a, d) => a + Number(d?.actual_cost ?? d?.cost ?? 0) || 0, 0)
          const totalUsage = u?.usage?.total ?? {}
          let spent = Number(totalUsage.actual_cost ?? totalUsage.cost)
          if (!Number.isFinite(spent)) spent = sumDays()
          let todayCost = Number(today.actual_cost ?? today.cost)
          if (!Number.isFinite(todayCost)) todayCost = sumDays()

          const windows = []

          // 1) 额度：已用 / 总量 + 进度条
          //
          //    网关报了上限就用它的（限额的 key）。钱包制没有上限，就用
          //    「累计消费 / 累计获得」——累计获得 = 现在的余额 + 累计消费。
          //    这样窗口的「剩余」正好等于钱包余额，magpie 画出的那条曲线
          //    就是余额走势。
          if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
            const pct = (used / limit) * 100
            windows.push({
              name: "额度",
              used: pct,
              amount: used,
              limit,
              unit,
              display: `${used.toFixed(2)} / ${limit.toFixed(2)} ${unit} · 剩余 ${(100 - pct).toFixed(1)}%`,
            })
          } else if (Number.isFinite(spent) && Number.isFinite(balance) && spent + balance > 0) {
            const granted = balance + spent
            const pct = (spent / granted) * 100
            windows.push({
              name: "额度",
              used: pct,
              amount: spent,
              limit: granted,
              unit,
              display: `${spent.toFixed(2)} / ${granted.toFixed(2)} ${unit} · 剩余 ${(100 - pct).toFixed(1)}%`,
            })
          }

          // 3) 今日消费
          if (Number.isFinite(todayCost) && todayCost > 0) {
            const bits = [`${todayCost.toFixed(2)} ${unit}`]
            if (Number.isFinite(requests) && requests > 0) bits.push(`${requests} 次请求`)
            if (Number.isFinite(tokens) && tokens > 0) bits.push(`${tokens} tokens`)
            windows.push({ name: "今日消费", display: bits.join(" · "), aside: true })
          }

          // 4) 今天的签到状态（aside 窗口不参与路由）
          const checkinWindow = await readCheckinWindow(auth, panelBase, ua)
          if (checkinWindow) windows.push(checkinWindow)

          const out = { plan: u?.planName ?? u?.mode ?? null, windows }

          // 顶层余额：magpie 记历史，账号卡片据此画走势图
          const shown = Number.isFinite(balance) ? balance : remaining
          if (Number.isFinite(shown)) out.balance = `${shown.toFixed(2)} ${unit}`
          return out
        } catch (err) {
          return { error: String(err?.message ?? err), windows: [] }
        }
      },
      // 每日签到：面板的 /user/checkin，用网页会话令牌鉴权。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!apiKeyOf(auth)) return { outcome: "failed", message: "账号未登录" }

        const ua = pickUserAgent(null, userAgent)
        let token = String(panelTokenOf(auth) ?? "").trim()
        if (!token) {
          return {
            outcome: "ineligible",
            message:
              "该账号没有网页会话令牌，无法自动签到。请用「Xingchi 浏览器登录」或「网页令牌」方式登录。",
          }
        }

        let state
        try {
          state = await panelRequest(panelBase, "/user/checkin", { token, ua })
        } catch (err) {
          return { outcome: "failed", message: `无法访问面板：${String(err?.message ?? err)}` }
        }

        // 会话过期：拿 refresh_token 换一张新的，再试一次。
        if (state.status === 401) {
          const renewed = await refreshPanelSession(panelBase, refreshTokenOf(auth), ua)
          if (!renewed) {
            return {
              outcome: "failed",
              message: "网页会话已过期，请重新登录（magpie plugin login xingchi）",
            }
          }
          token = renewed.accessToken
          await persistPanelSession(input, auth, renewed)
          try {
            state = await panelRequest(panelBase, "/user/checkin", { token, ua })
          } catch (err) {
            return { outcome: "failed", message: `无法访问面板：${String(err?.message ?? err)}` }
          }
        }

        if (!state.ok) {
          return {
            outcome: "failed",
            message: `读取签到状态失败：${state.message ?? `HTTP ${state.status}`}`,
          }
        }

        const status = state.data ?? {}
        // 下次可领的时间（北京时间 0 点），magpie 用它显示"何时再问"
        const next = typeof status.next_claim_at === "string" ? status.next_claim_at : ""
        if (status.enabled === false) {
          return { outcome: "inactive", message: "站点当前没有开启每日签到活动" }
        }
        if (status.claimed_today === true) {
          const total = typeof status.total_count === "number" ? status.total_count : undefined
          return {
            outcome: "done",
            streak: total,
            ...(next ? { until: next } : {}),
            message: `今天已签到${total ? `，累计 ${total} 次` : ""}`,
          }
        }

        // 领取
        let claim
        try {
          claim = await panelRequest(panelBase, "/user/checkin", { method: "POST", token, ua })
        } catch (err) {
          return { outcome: "failed", message: `签到失败：${String(err?.message ?? err)}` }
        }

        if (claim.ok) {
          const amount = claim.data?.amount ?? status.amount
          const total = claim.data?.status?.total_count ?? status.total_count
          return {
            outcome: "claimed",
            credit: typeof amount === "number" ? amount : undefined,
            streak: typeof total === "number" ? total : undefined,
            ...(next ? { until: next } : {}),
            message: `签到成功，获得 ${typeof amount === "number" ? amount : 0} 额度`,
          }
        }
        if (claim.reason === "CHECKIN_ALREADY_CLAIMED") {
          return {
            outcome: "done",
            ...(next ? { until: next } : {}),
            message: "今天已经签过到了",
          }
        }
        return {
          outcome: "failed",
          message: `签到失败：${claim.message ?? `HTTP ${claim.status}`}`,
        }
      },
      // magpie 自己的钩子：账号的会话快过期时由 magpie 调，续期后写回账号。
      // 面板令牌过期不影响网关请求，但签到要用，所以两者都要保住。
      refreshLead: 5 * 60 * 1000,
      async refresh(auth) {
        const refreshToken = refreshTokenOf(auth)
        if (!refreshToken) return {}
        const renewed = await refreshPanelSession(
          panelBase,
          refreshToken,
          pickUserAgent(null, userAgent),
        )
        if (!renewed) return {}
        return {
          access: apiKeyOf(auth),
          refresh: renewed.refreshToken,
          expires: renewed.expiresAt,
          panelToken: renewed.accessToken,
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return {
          baseURL: baseUrl,
          apiKey: key,
          headers: { "User-Agent": pickUserAgent(null, userAgent) },
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set("user-agent", pickUserAgent(headers.get("user-agent"), userAgent))

            let body = init?.body
            let replayable = false
            if (body != null && !headers.get("content-type")?.includes("multipart")) {
              const text = typeof body === "string" ? body : new TextDecoder().decode(body)
              let normalized = normalizeResponsesBody(text, { historyPacking })

              // 模型 id 上带着分组标记时：换成那个分组的 key，并把标记去掉。
              const marked = modelInBody(text)
              if (marked) {
                const groupKey = groupKeysOf(auth)[marked.group]
                if (groupKey) headers.set("authorization", `Bearer ${groupKey}`)
                normalized = stripModelMark(normalized, marked.raw)
              }

              body = typeof body === "string" ? normalized : new TextEncoder().encode(normalized)
              replayable = true
            }
            if (!headers.get("authorization")) headers.set("authorization", `Bearer ${key}`)

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
        const key = apiKeyOf(auth)
        if (!key) return provider.models
        const ua = pickUserAgent(null, userAgent)
        const token = String(panelTokenOf(auth) ?? "").trim()

        // 有面板会话：把每个分组（渠道）的模型都列出来，名字后面带倍率。
        // 每把 key 只属于一个分组，所以每个分组各配一把 key；模型 id 上带
        // "-g<分组id>" 标记，经 apiId 传到 loader，由 loader 换成那把 key。
        if (token) {
          try {
            const { groups, groupKeys } = await ensureGroupKeys(panelBase, token, ua)
            if (groups.length && Object.keys(groupKeys).length) {
              const primary = Number(auth?.metadata?.primaryGroup ?? groups[0].id)
              // 先把分组本身放进缓存并落盘：没有面板会话的账号只等这一份。
              groupCache = {
                groups: Object.fromEntries(
                  groups.map((g) => [String(g.id), { name: g.name, rate: g.rate, source: g.source }]),
                ),
                models: {},
                primary,
              }
              await writeGroupCache(groupCache)
              const out = {}
              const toolProbes = []
              const modelGroup = new Map()

              // 有些分组从「专属余额」里扣钱，账号没有那笔余额就列了也是 503。
              // 渠道照列，但在名字里标出来，免得以为是自己配错了。
              const balances = await readPanelBalances(panelBase, token, ua)

              // 同样的倍率出现多次时，名字里带上分组名，免得看不出是哪条渠道。
              const rateSeen = new Map()
              for (const g of groups) {
                const label = rateLabel(g.rate)
                rateSeen.set(label, (rateSeen.get(label) ?? 0) + 1)
              }

              for (const g of groups) {
                const gkey = groupKeys[g.id]
                if (!gkey) continue
                const rows = await listModelsForKey(gkey, ua)
                for (const row of rows) {
                  const id = row?.id
                  if (!id || id.startsWith("gpt-image")) continue
                  const spec = MODELS[id]
                  const label = rateLabel(g.rate)
                  const entryId = g.id === primary ? id : `${id}-g${g.id}`
                  const name =
                    `${spec?.name ?? row.display_name ?? id} · ${label}` +
                    (rateSeen.get(label) > 1 && g.name ? `（${g.name}）` : "") +
                    (groupUsable(g, balances) ? "" : "（余额不足）")
                  const entry = wireEntry(
                    spec
                      ? modelEntry(spec, id)
                      : {
                          id,
                          name: row.display_name ?? id,
                          limit: { context: 128000, output: 32768 },
                          reasoning: false,
                          tool_call: true,
                          modalities: { input: ["text"] },
                        },
                    { apiId: entryId, name, rate: g.rate, reasoning: spec !== undefined },
                  )
                  out[entryId] = entry
                  toolProbes.push({ id, key: gkey, entry })
                  if (!modelGroup.has(id)) modelGroup.set(id, g.id)
                }
              }

              // 分组信息放进缓存：没有面板会话的账号靠它标出倍率。
              if (groupCache) {
                groupCache.models = Object.fromEntries(modelGroup)
                groupCache.primary = primary
              }
              await writeGroupCache(groupCache)

              // 各分组可能连接不同上游，同名模型也必须用各自的 key 探测。
              await mapWithLimit(toolProbes, 4, async ({ id, key: pkey, entry }) => {
                const cached = cachedProbe(baseUrl, pkey, id)
                const value =
                  cached !== undefined
                    ? cached
                    : await probeToolSupport(baseUrl, pkey, id, ua)
                if (value === null) return
                if (cached === undefined) rememberProbe(baseUrl, pkey, id, value)
                setToolSupport(entry, value)
              })

              // 每组一把 key，记在账号里，loader 才知道该用哪把。
              await saveGroupKeys(input, auth, groupKeys, primary)
              return out
            }
          } catch {
            // 拿不到分组就退回原来那条路
          }
        }

        // 没有面板会话的账号：它只有一把 key，只能用自己那把 key 能服务的模型，
        // 但分组的名字和倍率是站点级的，从缓存里取，名字照样带倍率。
        const cache = groupCache ?? (await readGroupCache())
        let data
        try {
          const res = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${key}`, "user-agent": ua },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) return provider.models
          const body = await res.json()
          if (!Array.isArray(body?.data)) return provider.models
          data = body.data
        } catch {
          return provider.models
        }

        const out = {}
        const ids = []
        for (const row of data) {
          const id = row?.id
          if (!id || id.startsWith("gpt-image")) continue
          ids.push(id)
          const spec = MODELS[id]
          const groupId = cache?.models?.[id] ?? cache?.primary
          const group = groupId ? cache?.groups?.[String(groupId)] : null
          const label = group ? rateLabel(group.rate) : ""
          const name = group
            ? `${spec?.name ?? row.display_name ?? id} · ${label}`
            : (spec?.name ?? row.display_name ?? id)
          const entry = wireEntry(
            spec
              ? modelEntry(spec, id)
              : {
                  id,
                  name: row.display_name ?? id,
                  limit: { context: 128000, output: 32768 },
                  reasoning: false,
                  tool_call: true,
                  modalities: { input: ["text"] },
                },
            { apiId: id, name, rate: group?.rate, reasoning: spec !== undefined },
          )
          out[id] = entry
        }

        // 逐个实测工具调用能力（缓存 6 小时）。探测失败就保持原值。
        // 探测是真请求，一次最多几个并发，别把网关打出限流。
        await mapWithLimit(ids, 4, async (id) => {
          const cached = cachedProbe(baseUrl, key, id)
          if (cached !== undefined) {
            setToolSupport(out[id], cached)
            return
          }
          const probed = await probeToolSupport(baseUrl, key, id, ua)
          if (probed === null) return
          rememberProbe(baseUrl, key, id, probed)
          setToolSupport(out[id], probed)
        })

        return out
      },
    },
  }
}
