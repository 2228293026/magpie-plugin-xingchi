import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export const TURN_LIMIT_CACHE_FILE = "xingchi-turn-limits.json"
export const TURN_LIMIT_TTL_MS = 60 * 60 * 1000
const SCOPE = /^[a-f0-9]{64}$/
const writes = new Map()

export function isTurnLimit(value) {
  return Number.isSafeInteger(value) && value > 0
}

function limitNumber(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value)
  return isTurnLimit(value) ? value : undefined
}

function matchingNumber(message, patterns) {
  const values = patterns.flatMap(pattern => [...message.matchAll(pattern)])
    .map(match => limitNumber(match[1]))
  if (!values.length) return undefined
  return values.every(value => value !== undefined && value === values[0]) ? values[0] : null
}

export function parseTurnFeedback(payload) {
  const error = payload?.response?.error ?? payload?.error ?? payload
  if (error?.code !== "session_turn_limit_exceeded") return undefined
  const message = typeof error.message === "string" ? error.message : ""
  const metric = /模型|\bmodel\s+(?:turns?|rounds?|replies|responses?)\b/i.test(message) ? "model" : "user"
  for (const name of ["max_model_turns", "model_turn_limit", "max_turns", "turn_limit", "limit"]) {
    const limit = limitNumber(error[name])
    if (limit !== undefined) return { metric: name.includes("model") ? "model" : metric, limit }
  }
  if (!message) return undefined
  const explicit = matchingNumber(message, [
    /(?:上限|限制)\s*(?:为|是|[:：])?\s*(\d+)\s*轮/gi,
    /\b(?:limit|maximum|max)\s*(?:of|is|:|=)?\s*(\d+)\s*(?:model\s+)?(?:turns?|rounds?)\b/gi,
  ])
  if (explicit !== undefined) return explicit === null ? undefined : { metric, limit: explicit }
  if (metric === "model") {
    const rejectedAt = matchingNumber(message, [
      /模型\s*(?:已\s*)?回复\s*(\d+)\s*轮/gi,
      /\b(?:has\s+)?reached\s+(\d+)\s+model\s+(?:turns?|rounds?)\b/gi,
    ])
    return rejectedAt == null ? undefined : { metric, rejectedAt }
  }
  const patterns = [
    [/(?:已满|满)\s*(\d+)\s*轮/gi,
      /\b(?:has\s+)?reached\s+(\d+)\s*(?:turns?|rounds?)\b/gi],
  ]
  // Prefer an explicit ceiling over a message that also mentions the submitted count.
  for (const group of patterns) {
    const limits = group.flatMap(pattern => [...message.matchAll(pattern)])
      .map(match => limitNumber(match[1]))
    if (!limits.length) continue
    return limits.every(limit => limit !== undefined && limit === limits[0]) ? { metric, limit: limits[0] } : undefined
  }
  const limits = [...message.matchAll(/(?<![\w.\-])(\d+)\s*(?:轮|turns?\b|rounds?\b)/gi)]
    .map(match => limitNumber(match[1]))
  return limits.length && limits.every(limit => limit !== undefined && limit === limits[0])
    ? { metric, limit: limits[0] } : undefined
}

export function parseTurnLimit(payload) {
  return parseTurnFeedback(payload)?.limit
}

export function turnLimitScope(baseUrl, credential, model, metric = "user") {
  if (typeof credential !== "string" || !credential || typeof model !== "string" || !model) return undefined
  if (metric !== "user" && metric !== "model") return undefined
  try {
    const url = new URL(baseUrl)
    const gateway = url.origin + url.pathname.replace(/\/responses\/?$/, "").replace(/\/+$/, "")
    const values = [gateway, credential, model]
    if (metric === "model") values.push(metric)
    return createHash("sha256").update(JSON.stringify(values)).digest("hex")
  } catch {
    return undefined
  }
}

function validEntry(entry, now) {
  const validLimit = entry?.metric === "model"
    ? Number.isSafeInteger(entry.limit) && entry.limit >= 0 : isTurnLimit(entry?.limit)
  return validLimit && (entry.metric === undefined || entry.metric === "model") && Number.isSafeInteger(entry.at) && entry.at >= 0 &&
    entry.at <= now && now - entry.at < TURN_LIMIT_TTL_MS
}

function preferredEntry(current, incoming, now) {
  if (!validEntry(incoming, now)) return current
  if (!validEntry(current, now)) return incoming
  if (current.metric === "model" && incoming.metric === "model") {
    return current.limit < incoming.limit || current.limit === incoming.limit && current.at <= incoming.at
      ? current : incoming
  }
  return current.at > incoming.at ? current : incoming
}

async function readEntries(file, now) {
  if (!file) return {}
  try {
    const text = await readFile(file, "utf8")
    if (text.length > 1024 * 1024) return {}
    const data = JSON.parse(text)
    if (data?.version !== 1 || !data.limits || typeof data.limits !== "object") return {}
    const time = now()
    return Object.fromEntries(Object.entries(data.limits)
      .filter(([scope, entry]) => SCOPE.test(scope) && validEntry(entry, time))
      .map(([scope, entry]) => [scope, { limit: entry.limit, at: entry.at,
        ...(entry.metric === "model" ? { metric: "model" } : {}) }]))
  } catch {
    return {}
  }
}

async function persist(file, scope, entry, now) {
  const previous = writes.get(file) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const limits = await readEntries(file, now)
    const selected = preferredEntry(limits[scope], entry, now())
    if (selected === limits[scope]) return selected
    limits[scope] = selected
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    let created = false
    try {
      const handle = await open(temporary, "wx", 0o600)
      created = true
      try {
        await handle.writeFile(JSON.stringify({ version: 1, limits }) + "\n", "utf8")
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } finally {
      if (created) await rm(temporary, { force: true }).catch(() => {})
    }
    return selected
  })
  writes.set(file, task)
  try {
    return await task
  } catch {
    // An unwritable cache must not prevent learning or serving the current request.
    return undefined
  } finally {
    if (writes.get(file) === task) writes.delete(file)
  }
}

export function createTurnLimitCache(directory, { now = Date.now } = {}) {
  const file = typeof directory === "string" && directory.trim()
    ? resolve(directory, TURN_LIMIT_CACHE_FILE) : undefined
  const memory = new Map()
  const volatile = new Set()
  return {
    async get(scope) {
      if (!SCOPE.test(scope ?? "")) return undefined
      const stored = (await readEntries(file, now))[scope]
      const time = now()
      const disk = validEntry(stored, time) ? stored : undefined
      const remembered = memory.get(scope)
      const local = validEntry(remembered, time) ? remembered : undefined
      const entry = disk?.metric === "model" && local?.metric === "model"
        ? preferredEntry(local, disk, time)
        : disk && (!local || disk.at > local.at || (disk.at === local.at && !volatile.has(scope))) ? disk : local
      if (!validEntry(entry, time)) {
        memory.delete(scope)
        volatile.delete(scope)
        return undefined
      }
      memory.set(scope, entry)
      if (entry === disk) volatile.delete(scope)
      return entry.limit
    },
    async remember(scope, limit, metric = "user") {
      const validLimit = metric === "model" ? Number.isSafeInteger(limit) && limit >= 0 : isTurnLimit(limit)
      if (!SCOPE.test(scope ?? "") || !validLimit || !["user", "model"].includes(metric)) return
      const at = now()
      for (const [key, entry] of memory) {
        if (!validEntry(entry, at)) {
          memory.delete(key)
          volatile.delete(key)
        }
      }
      const proposed = { limit, at, ...(metric === "model" ? { metric } : {}) }
      const entry = metric === "model" ? preferredEntry(memory.get(scope), proposed, at) : proposed
      memory.set(scope, entry)
      volatile.add(scope)
      if (file) {
        const saved = await persist(file, scope, entry, now)
        if (!saved) return
        if (metric === "model") {
          const selected = preferredEntry(memory.get(scope), saved, now())
          memory.set(scope, selected)
          if (selected.limit === saved.limit && selected.at === saved.at) volatile.delete(scope)
        } else if (memory.get(scope) === entry) volatile.delete(scope)
      }
    },
  }
}
