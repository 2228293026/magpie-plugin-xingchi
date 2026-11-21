import { expect, test } from "bun:test"
import { join } from "node:path"
import { _internal, XingchiPlugin } from "../index.mjs"
import {
  browserArgs,
  browserProfileDir,
  findBrowser,
  waitForBrowserSession,
} from "../browser.mjs"

const {
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
  UA_PRESETS,
  DEFAULT_UA,
} = _internal

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

test("max/ultra 落到 xhigh（上游只认 high 和 xhigh）", () => {
  const max = JSON.parse(
    normalizeResponsesBody(JSON.stringify({ model: "gpt-6.1-sol", input: "hi", reasoning: { effort: "max" } })),
  )
  expect(max.reasoning.effort).toBe("xhigh")
  expect(max.reasoning.summary).toBe("auto")

  const ultra = JSON.parse(
    normalizeResponsesBody(JSON.stringify({ model: "gpt-6.1-sol", input: "hi", reasoning: { effort: "ultra" } })),
  )
  expect(ultra.reasoning.effort).toBe("xhigh")

  // low/medium/high 保持原样
  for (const e of ["low", "medium", "high", "xhigh"]) {
    const out = JSON.parse(
      normalizeResponsesBody(JSON.stringify({ model: "gpt-6.1-sol", input: "hi", reasoning: { effort: e } })),
    )
    expect(out.reasoning.effort).toBe(e)
  }
})

test("mapWithLimit 限制并发", async () => {
  let running = 0
  let peak = 0
  await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
  })
  expect(peak).toBeLessThanOrEqual(3)
  expect(peak).toBeGreaterThan(1)
})

test("mapWithLimit 全部执行", async () => {
  const seen = []
  await mapWithLimit([1, 2, 3, 4], 2, async (n) => {
    seen.push(n)
  })
  expect(seen.sort()).toEqual([1, 2, 3, 4])
})

test("mapWithLimit 空数组不报错", async () => {
  await mapWithLimit([], 4, async () => {
    throw new Error("不该被调用")
  })
})

test("探测把各种网关回答归类", async () => {
  const original = globalThis.fetch
  const reply = async (status, body) => {
    globalThis.fetch = async () => new Response(body, { status })
  }
  try {
    // 成功 → 支持工具
    await reply(200, JSON.stringify({ output: [{ type: "function_call" }] }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(true)

    // 明确不支持工具 → 不支持
    await reply(400, JSON.stringify({ error: { message: "m requires Responses for tool calls; this account only supports Chat Completions" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(false)

    // 模型已不在账号池里 → 没测出来（不是"不支持工具"）
    await reply(400, JSON.stringify({ error: { message: 'Model "m" is not supported by any configured account in this group' } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 限流 → 没测出来
    await reply(429, JSON.stringify({ error: { message: "Upstream rate limit exceeded" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 上游 5xx → 没测出来
    await reply(503, JSON.stringify({ error: { message: "Service temporarily unavailable" } }))
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)

    // 网络异常 → 没测出来
    globalThis.fetch = async () => {
      throw new Error("boom")
    }
    expect(await probeToolSupport("https://x/v1", "k", "m", "omp/1")).toBe(null)
  } finally {
    globalThis.fetch = original
  }
})

// ---- 签到相关 ----------------------------------------------------------

test("令牌输入支持裸 token 和 JSON 块", () => {
  expect(parseTokenInput("jwt-abc")).toEqual({ accessToken: "jwt-abc", refreshToken: "" })
  expect(parseTokenInput("")).toEqual({ accessToken: "", refreshToken: "" })
  expect(parseTokenInput('{"access_token":"a","refresh_token":"r"}')).toEqual({
    accessToken: "a",
    refreshToken: "r",
  })
  // 坏掉的 JSON 当作裸 token
  expect(parseTokenInput("{oops").accessToken).toBe("{oops")
})

test("面板地址由网关地址推出来", () => {
  expect(panelBaseFrom("https://api.xingchiapi.com/v1")).toBe("https://api.xingchiapi.com")
  expect(panelBaseFrom("https://api.xingchiapi.com/v1/")).toBe("https://api.xingchiapi.com")
  expect(panelBaseFrom("https://api.xingchiapi.com")).toBe("https://api.xingchiapi.com")
  expect(panelUrl("https://api.xingchiapi.com", "/user/checkin")).toBe(
    "https://api.xingchiapi.com/api/v1/user/checkin",
  )
})

test("分页容器都能摊平成列表", () => {
  expect(extractList([{ id: 1 }])).toEqual([{ id: 1 }])
  expect(extractList({ items: [{ id: 2 }] })).toEqual([{ id: 2 }])
  expect(extractList({ list: [{ id: 3 }] })).toEqual([{ id: 3 }])
  expect(extractList({ data: [{ id: 4 }] })).toEqual([{ id: 4 }])
  expect(extractList(null)).toEqual([])
  expect(extractList(undefined)).toEqual([])
})

test("签到状态分类：未开启 / 已签 / 可签", () => {
  expect(classifyCheckin({ enabled: false }).outcome).toBe("inactive")
  expect(classifyCheckin({ enabled: true, claimed_today: true, total_count: 3 }).outcome).toBe("done")
  expect(classifyCheckin({ enabled: true, claimed_today: true, total_count: 3 }).streak).toBe(3)

  const claim = classifyCheckin({ enabled: true, claimed_today: false, total_count: 0 }, 300)
  expect(claim.outcome).toBe("claimed")
  expect(claim.credit).toBe(300)
})

test("refreshPanelSession 换新令牌", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ code: 0, message: "success", data: { access_token: "new", refresh_token: "r2", expires_in: 3600 } }),
        { status: 200 },
      )
    const renewed = await refreshPanelSession("https://api.xingchiapi.com", "r1", "omp/1")
    expect(renewed.accessToken).toBe("new")
    expect(renewed.refreshToken).toBe("r2")
    expect(renewed.expiresAt).toBeGreaterThan(Date.now())

    // 没有 refresh_token 就没法续
    expect(await refreshPanelSession("https://api.xingchiapi.com", "", "omp/1")).toBe(null)

    // 服务端拒绝 → null
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 401, message: "nope" }), { status: 401 })
    expect(await refreshPanelSession("https://api.xingchiapi.com", "r1", "omp/1")).toBe(null)
  } finally {
    globalThis.fetch = original
  }
})

test("resolvePanelApiKey 优先挑现有 key，没有就新建", async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" })
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { key: "sk-new" } }), { status: 200 })
      }
      // 绑好了分组的现有 key（没分组的不能用，网关会回 403）
      return new Response(
        JSON.stringify({ code: 0, data: { items: [{ key: "sk-old", status: "active", group_id: 3 }] } }),
        { status: 200 },
      )
    }
    expect(await resolvePanelApiKey("https://api.xingchiapi.com", "tok", "omp/1")).toBe("sk-old")
    expect(calls).toHaveLength(1)

    // 列表为空 → 新建一把（先问一次可用分组）
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith("/groups/available")) {
        return new Response(JSON.stringify({ code: 0, data: [{ id: 3, status: "active" }] }), { status: 200 })
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { key: "sk-new" } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 })
    }
    expect(await resolvePanelApiKey("https://api.xingchiapi.com", "tok", "omp/1")).toBe("sk-new")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子：没有网页令牌 → ineligible", async () => {
  const plugin = await XingchiPlugin({}, {})
  const result = await plugin.auth.checkin(async () => ({ type: "api", key: "sk-x" }))
  expect(result.outcome).toBe("ineligible")
})

test("checkin 钩子：领取成功", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      const method = init?.method ?? "GET"
      if (method === "POST") {
        return new Response(
          JSON.stringify({ code: 0, data: { status: { total_count: 2 }, amount: 300 } }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: { enabled: true, claimed_today: false, amount: 300, total_count: 1, total_amount: 300 },
        }),
        { status: 200 },
      )
    }
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt" },
    }))
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(300)
    expect(result.streak).toBe(2)
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子：今天已签 → done", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { enabled: true, claimed_today: true, amount: 300, total_count: 7, total_amount: 2100 },
        }),
        { status: 200 },
      )
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt" },
    }))
    expect(result.outcome).toBe("done")
    expect(result.streak).toBe(7)
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子：重复领取 → done", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({ code: 409, message: "already claimed", reason: "CHECKIN_ALREADY_CLAIMED" }),
          { status: 409 },
        )
      }
      return new Response(
        JSON.stringify({ code: 0, data: { enabled: true, claimed_today: false, amount: 300 } }),
        { status: 200 },
      )
    }
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt" },
    }))
    expect(result.outcome).toBe("done")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子：会话过期且无法续期 → failed", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 401, message: "unauthorized" }), { status: 401 })
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt", refreshToken: "" },
    }))
    expect(result.outcome).toBe("failed")
    expect(result.message).toContain("会话已过期")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子：会话过期时用 refresh_token 换新的再签", async () => {
  const original = globalThis.fetch
  try {
    const seen = []
    let refreshed = false
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      seen.push(u)
      if (u.endsWith("/auth/refresh")) {
        refreshed = true
        return new Response(
          JSON.stringify({ code: 0, data: { access_token: "jwt2", refresh_token: "r2", expires_in: 3600 } }),
          { status: 200 },
        )
      }
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { amount: 300, status: { total_count: 2 } } }), {
          status: 200,
        })
      }
      // 换令牌之前一律 401，换过之后才放行
      if (!refreshed) {
        return new Response(JSON.stringify({ code: 401, message: "unauthorized" }), { status: 401 })
      }
      return new Response(
        JSON.stringify({ code: 0, data: { enabled: true, claimed_today: false, amount: 300 } }),
        { status: 200 },
      )
    }
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt", refreshToken: "r1" },
    }))
    expect(result.outcome).toBe("claimed")
    expect(seen.some((u) => u.endsWith("/auth/refresh"))).toBe(true)
  } finally {
    globalThis.fetch = original
  }
})

// ---- 浏览器登录与多账号 ------------------------------------------------

test("三种登录形态的凭据都能读出来", () => {
  // api 型：只粘了 API key
  const apiOnly = { type: "api", key: "sk-1" }
  expect(apiKeyOf(apiOnly)).toBe("sk-1")
  expect(panelTokenOf(apiOnly)).toBe("")
  expect(refreshTokenOf(apiOnly)).toBe("")

  // api 型：粘了面板令牌
  const pasted = {
    type: "api",
    key: "sk-2",
    accountId: "a@example.com",
    metadata: { accessToken: "jwt-2", refreshToken: "r-2" },
  }
  expect(apiKeyOf(pasted)).toBe("sk-2")
  expect(panelTokenOf(pasted)).toBe("jwt-2")
  expect(refreshTokenOf(pasted)).toBe("r-2")
  expect(emailOf(pasted)).toBe("a@example.com")

  // oauth 型：浏览器登录，access 是网关 key，panelToken 是面板令牌
  const browser = {
    type: "oauth",
    access: "sk-3",
    refresh: "r-3",
    panelToken: "jwt-3",
    accountId: "b@example.com",
  }
  expect(apiKeyOf(browser)).toBe("sk-3")
  expect(panelTokenOf(browser)).toBe("jwt-3")
  expect(refreshTokenOf(browser)).toBe("r-3")
  expect(emailOf(browser)).toBe("b@example.com")
})

test("浏览器参数带独立 profile 与调试端口", () => {
  const args = browserArgs("/tmp/profile", 9333, "https://xingchiapi.com/login")
  expect(args).toContain("--user-data-dir=/tmp/profile")
  expect(args).toContain("--remote-debugging-port=9333")
  expect(args).toContain("--remote-debugging-address=127.0.0.1")
  expect(args[args.length - 1]).toBe("https://xingchiapi.com/login")
})

test("profile 目录按平台落到 magpie 目录下", () => {
  const win = browserProfileDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32")
  expect(win).toContain("magpie")
  expect(win).toContain("xingchi-browser")
  const linux = browserProfileDir({ HOME: "/home/x", XDG_CONFIG_HOME: "/home/x/.config" }, "linux")
  expect(linux).toBe(join("/home/x/.config", "magpie", "xingchi-browser"))
  // 环境变量优先
  expect(browserProfileDir({ XINGCHI_PROFILE: "/custom" }, "linux")).toBe("/custom")
})

test("找不到浏览器时给出空串（交给上层报错）", () => {
  expect(findBrowser("linux", {})).toBe("")
})

test("轮询到 localStorage 里的面板会话", async () => {
  let calls = 0
  const evaluate = async () => {
    calls++
    if (calls < 2) return { access: null, refresh: null, user: null }
    return {
      access: "jwt-9",
      refresh: "r-9",
      user: JSON.stringify({ email: "c@example.com" }),
      expiresAt: "1893456000000",
    }
  }
  const found = await waitForBrowserSession(evaluate, 5000, { pollMs: 1 })
  expect(found.accessToken).toBe("jwt-9")
  expect(found.refreshToken).toBe("r-9")
  expect(found.email).toBe("c@example.com")
  expect(found.expiresAt).toBe(1893456000000)
})

test("轮询超时返回 null", async () => {
  const evaluate = async () => ({ access: null, refresh: null, user: null })
  expect(await waitForBrowserSession(evaluate, 30, { pollMs: 1 })).toBe(null)
})

test("auth.refresh 钩子用 refresh_token 换新会话", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ code: 0, data: { access_token: "jwt-new", refresh_token: "r-new", expires_in: 3600 } }),
        { status: 200 },
      )
    const plugin = await XingchiPlugin({}, {})
    const renewed = await plugin.auth.refresh({
      type: "oauth",
      access: "sk-3",
      refresh: "r-3",
      panelToken: "jwt-3",
    })
    expect(renewed.access).toBe("sk-3")
    expect(renewed.refresh).toBe("r-new")
    expect(renewed.panelToken).toBe("jwt-new")
    expect(renewed.expires).toBeGreaterThan(Date.now())

    // 没有 refresh_token → 不返回任何东西
    const none = await plugin.auth.refresh({ type: "oauth", access: "sk-3" })
    expect(none).toEqual({})
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子也认 oauth 型账号", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ code: 0, data: { amount: 300, status: { total_count: 5 } } }), {
          status: 200,
        })
      }
      return new Response(
        JSON.stringify({ code: 0, data: { enabled: true, claimed_today: false, amount: 300 } }),
        { status: 200 },
      )
    }
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "oauth",
      access: "sk-3",
      refresh: "r-3",
      panelToken: "jwt-3",
      accountId: "c@example.com",
    }))
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(300)
    expect(result.streak).toBe(5)
  } finally {
    globalThis.fetch = original
  }
})

test("三种登录方式都在 methods 里", async () => {
  const plugin = await XingchiPlugin({}, {})
  const labels = plugin.auth.methods.map((m) => m.label)
  expect(labels.length).toBe(3)
  expect(labels[0]).toContain("浏览器登录")
  expect(plugin.auth.methods[0].type).toBe("oauth")
  expect(plugin.auth.methods[0].authorize).toBeDefined()
  // 浏览器登录没有 prompts（自己开浏览器），另外两种有
  expect(plugin.auth.methods[0].prompts).toBeUndefined()
})


test("新建 key 必须带分组：没分组的 key 要先补上", async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      const method = init?.method ?? "GET"
      calls.push(method + " " + u)
      if (u.endsWith("/groups/available")) {
        return new Response(
          JSON.stringify({ code: 0, data: [{ id: 3, name: "GPT公益", status: "active" }] }),
          { status: 200 },
        )
      }
      if (u.endsWith("/keys/47165")) {
        return new Response(JSON.stringify({ code: 0, data: { id: 47165, key: "sk-fixed", group_id: 3 } }), {
          status: 200,
        })
      }
      if (u.endsWith("/keys")) {
        // 列表里只有一把没分组的（插件之前建的）
        return new Response(
          JSON.stringify({ code: 0, data: { items: [{ id: 47165, name: "magpie", status: "active", group_id: null, key: "sk-old" }] } }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 200 })
    }
    const key = await resolvePanelApiKey("https://api.xingchiapi.com", "tok", "omp/1")
    expect(key).toBe("sk-fixed")
    // 是 PUT 补分组，不是新建
    expect(calls.some((c) => c.startsWith("PUT") && c.includes("/keys/47165"))).toBe(true)
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/keys"))).toBe(false)
  } finally {
    globalThis.fetch = original
  }
})

test("新建 key 时带上 group_id", async () => {
  const original = globalThis.fetch
  try {
    let body = null
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith("/groups/available")) {
        return new Response(
          JSON.stringify({ code: 0, data: [{ id: 7, name: "GPT公益", status: "active" }] }),
          { status: 200 },
        )
      }
      if (u.endsWith("/keys")) {
        if ((init?.method ?? "GET") === "POST") {
          body = JSON.parse(String(init.body))
          return new Response(JSON.stringify({ code: 0, data: { key: "sk-new", group_id: 7 } }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }
    const key = await resolvePanelApiKey("https://api.xingchiapi.com", "tok", "omp/1")
    expect(key).toBe("sk-new")
    expect(body.group_id).toBe(7)
  } finally {
    globalThis.fetch = original
  }
})

test("已有绑好分组的 key 直接用，不新建", async () => {
  const original = globalThis.fetch
  try {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push(String(url))
      if (String(url).endsWith("/keys")) {
        return new Response(
          JSON.stringify({ code: 0, data: { items: [{ id: 1, name: "mine", status: "active", group_id: 3, key: "sk-good" }] } }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 200 })
    }
    expect(await resolvePanelApiKey("https://api.xingchiapi.com", "tok", "omp/1")).toBe("sk-good")
    expect(calls.some((c) => c.includes("/groups/available"))).toBe(false)
  } finally {
    globalThis.fetch = original
  }
})

test("resolveGroupId 取第一个可用分组", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: [
            { id: 3, name: "GPT公益", status: "active" },
            { id: 4, name: "Astra-专属余额", status: "active" },
          ],
        }),
        { status: 200 },
      )
    expect(await resolveGroupId("https://api.xingchiapi.com", "tok", "omp/1")).toBe(3)
  } finally {
    globalThis.fetch = original
  }
})


test("usage 钩子认新版 /v1/usage：顶层余额 + 余额窗口 + 今日消费", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.endsWith("/v1/usage")) {
        return new Response(
          JSON.stringify({
            balance: 297.45,
            remaining: 297.45,
            unit: "USD",
            mode: "unrestricted",
            planName: "钱包余额",
            usage: {
              today: { actual_cost: 5.1, requests: 98, total_tokens: 2330799 },
              total: { actual_cost: 42.5 },
            },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            enabled: true,
            claimed_today: true,
            amount: 300,
            total_count: 1,
            next_claim_at: "2026-11-21T00:00:00+08:00",
          },
        }),
        { status: 200 },
      )
    }
    const plugin = await XingchiPlugin({}, {})
    const usage = await plugin.auth.usage(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt" },
    }))
    expect(usage.plan).toBe("钱包余额")
    // 顶层余额：magpie 记进 balance-history.json，账号卡片据此画走势图
    expect(usage.balance).toBe("297.45 USD")
    // 额度窗口：已用=累计消费，总量=余额+累计消费，剩余正好是余额
    const quota = usage.windows.find((w) => w.name === "额度")
    expect(quota.amount).toBe(42.5)
    expect(quota.limit).toBe(339.95)
    expect(quota.unit).toBe("USD")
    expect(quota.display).toContain("42.50 / 339.95 USD")
    // 窗口的剩余 = 余额，magpie 画出的曲线就是余额走势
    expect(quota.limit - quota.amount).toBe(297.45)
    const today = usage.windows.find((w) => w.name === "今日消费")
    expect(today.display).toContain("5.10 USD")
    expect(today.display).toContain("98 次请求")
    const checkin = usage.windows.find((w) => w.name === "每日签到")
    expect(checkin.display).toContain("今日已签到")
    expect(checkin.resetsAt).toBe("2026-11-21T00:00:00+08:00")
  } finally {
    globalThis.fetch = original
  }
})

test("usage 钩子认旧版 quota 格式：给出已用/总量的额度窗口", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v1/usage")) {
        return new Response(
          JSON.stringify({ quota: { limit: 100, used: 25, remaining: 75, unit: "USD" }, usage: {} }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: { enabled: true, claimed_today: true } }), {
        status: 200,
      })
    }
    const plugin = await XingchiPlugin({}, {})
    const usage = await plugin.auth.usage(async () => ({ type: "api", key: "sk-x" }))
    const quota = usage.windows.find((w) => w.name === "额度")
    expect(quota.used).toBe(25)
    expect(quota.amount).toBe(25)
    expect(quota.limit).toBe(100)
    expect(quota.display).toContain("25.00 / 100.00 USD")
    expect(usage.balance).toBe("75.00 USD")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin 钩子回报下次可领时间", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            enabled: true,
            claimed_today: true,
            amount: 300,
            total_count: 1,
            next_claim_at: "2026-11-21T00:00:00+08:00",
          },
        }),
        { status: 200 },
      )
    const plugin = await XingchiPlugin({}, {})
    const result = await plugin.auth.checkin(async () => ({
      type: "api",
      key: "sk-x",
      metadata: { accessToken: "jwt" },
    }))
    expect(result.outcome).toBe("done")
    expect(result.until).toBe("2026-11-21T00:00:00+08:00")
    expect(result.streak).toBe(1)
  } finally {
    globalThis.fetch = original
  }
})


test("倍率标签与分组标记", () => {
  expect(rateLabel(0.5)).toBe("0.5x")
  expect(rateLabel(1)).toBe("1x")
  expect(rateLabel(0.25)).toBe("0.25x")
  const marked = modelInBody(JSON.stringify({ model: "gpt-6.1-sol-g4" }))
  expect(marked.group).toBe("4")
  expect(marked.raw).toBe("gpt-6.1-sol-g4")
  // 没标记就不是分组模型
  expect(modelInBody(JSON.stringify({ model: "gpt-6.1-sol" }))).toBe(null)
  expect(modelInBody("not json")).toBe(null)
  // 去掉标记
  expect(JSON.parse(stripModelMark(JSON.stringify({ model: "gpt-6.1-sol-g4" }), "gpt-6.1-sol-g4")).model).toBe(
    "gpt-6.1-sol",
  )
})

test("分组清单读出倍率", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/groups/available")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: [
              { id: 3, name: "GPT公益", rate_multiplier: 0.5 },
              { id: 4, name: "Astra-专属余额", rate_multiplier: 1 },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })
    }
    const groups = await listGroups("https://api.xingchiapi.com", "tok", "omp/1")
    expect(groups.length).toBe(2)
    expect(groups[0].id).toBe(3)
    expect(groups[0].rate).toBe(0.5)
    expect(groups[1].rate).toBe(1)
  } finally {
    globalThis.fetch = original
  }
})

test("每个分组配一把 key：现成的优先，没有就建", async () => {
  const original = globalThis.fetch
  try {
    const created = []
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith("/groups/available")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: [
              { id: 3, name: "A", rate_multiplier: 0.5 },
              { id: 4, name: "B", rate_multiplier: 1 },
            ],
          }),
          { status: 200 },
        )
      }
      if (u.endsWith("/keys")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body))
          created.push(body)
          return new Response(
            JSON.stringify({ code: 0, data: { id: 99, key: "sk-new-" + body.group_id, group_id: body.group_id } }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({ code: 0, data: { items: [{ id: 1, name: "mine", status: "active", group_id: 3, key: "sk-old" }] } }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 200 })
    }
    const { groups, groupKeys } = await ensureGroupKeys("https://api.xingchiapi.com", "tok", "omp/1")
    expect(groups.length).toBe(2)
    expect(groupKeys["3"]).toBe("sk-old")
    expect(groupKeys["4"]).toBe("sk-new-4")
    expect(created.length).toBe(1)
    expect(created[0].group_id).toBe(4)
  } finally {
    globalThis.fetch = original
  }
})

test("模型清单合并全部分组，名字后面带倍率", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith("/groups/available")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: [
              { id: 3, name: "GPT公益", rate_multiplier: 0.5 },
              { id: 4, name: "Astra", rate_multiplier: 1 },
            ],
          }),
          { status: 200 },
        )
      }
      if (u.endsWith("/keys")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body))
          return new Response(
            JSON.stringify({ code: 0, data: { id: 99, key: "sk-g" + body.group_id, group_id: body.group_id } }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 })
      }
      if (u.endsWith("/models")) {
        const key = init?.headers?.authorization ?? ""
        if (key.includes("sk-g3")) {
          return new Response(
            JSON.stringify({ data: [{ id: "gpt-6.1-sol", display_name: "GPT-6.1 Sol" }] }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            data: [
              ...[
                "gpt-5.6",
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-6",
                "gpt-6-sol",
                "gpt-6-luna",
                "gpt-6-astra",
                "gpt-6.1-sol",
                "gpt-6.1-terra",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.3-codex-spark",
                "codex-auto-review",
                "gpt-5.2",
              ].map((id) => ({ id, display_name: id })),
              { id: "gpt-image-1", display_name: "Image" },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 200 })
    }
    const plugin = await XingchiPlugin({ client: { auth: { set: async () => {} } } }, {})
    const models = await plugin.provider.models(
      { models: {} },
      {
        auth: {
          type: "api",
          key: "sk-g3",
          metadata: { accessToken: "jwt", primaryGroup: 3, groupKeys: { 3: "sk-g3", 4: "sk-g4" } },
        },
      },
    )
    const ids = Object.keys(models)
    // 主分组保持原 id，其它分组带 -g<分组id> 标记
    expect(ids).toContain("gpt-6.1-sol")
    expect(ids).toContain("gpt-6.1-sol-g4")
    expect(ids).toContain("gpt-5.6-sol-g4")
    // 图片模型不列
    expect(ids.some((id) => id.startsWith("gpt-image"))).toBe(false)
    // 名字后面带倍率
    expect(models["gpt-6.1-sol"].name).toBe("GPT-6.1 Sol · 0.5x")
    expect(models["gpt-6.1-sol-g4"].name).toBe("GPT-6.1 Sol · 1x")
    expect(models["gpt-5.6-sol-g4"].name).toBe("GPT-5.6 Sol · 1x")
    // api.id 带着分组标记，loader 据此换 key
    expect(models["gpt-6.1-sol-g4"].api.id).toBe("gpt-6.1-sol-g4")
    expect(models["gpt-5.6-sol-g4"].rate).toBe(1)
    // 内部形状：推理能力在 capabilities 里，否则 magpie 当成"这模型不推理"
    expect(models["gpt-6.1-sol"].capabilities.reasoning).toBe(true)
    // 所有目录匹配项都应同步为上游总上下文与输出规格。
    for (const [id, context, output] of [
      ["gpt-5.6", 1050000, 128000],
      ["gpt-5.6-sol", 1050000, 128000],
      ["gpt-5.6-terra", 1050000, 128000],
      ["gpt-5.6-luna", 1050000, 128000],
      ["gpt-6", 1050000, 128000],
      ["gpt-6-sol", 1050000, 128000],
      ["gpt-6-luna", 1050000, 128000],
      ["gpt-6-astra", 1050000, 128000],
      ["gpt-6.1-sol", 1050000, 128000],
      ["gpt-6.1-terra", 1050000, 128000],
      ["gpt-5.5", 1050000, 128000],
      ["gpt-5.4", 1050000, 128000],
      ["gpt-5.4-mini", 400000, 128000],
      ["gpt-5.3-codex-spark", 128000, 32000],
      ["gpt-5.2", 400000, 128000],
    ]) {
      expect(models[id + "-g4"].limit).toEqual({ context, output })
    }
    expect(models["codex-auto-review-g4"].limit).toEqual({ context: 128000, output: 32768 })
    expect(models["gpt-6.1-sol"].limit).toEqual({ context: 1050000, output: 128000 })
    expect(models["gpt-6.1-sol-g4"].limit).toEqual({ context: 1050000, output: 128000 })
    expect(Object.keys(models["gpt-6.1-sol"].variants)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  } finally {
    globalThis.fetch = original
  }
})

test("单 key 的工具能力与宿主字段同步，缓存结果也保持一致", async () => {
  const original = globalThis.fetch
  let probes = 0
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) {
        return Response.json({ data: [{ id: "test-tool-capability" }] })
      }
      if (String(url).endsWith("/responses")) {
        probes++
        return Response.json({ error: { message: "This account does not support tools" } }, { status: 400 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
    const plugin = await XingchiPlugin({ client: {} }, {})
    const auth = { type: "api", key: "sk-test-capability-sync" }
    for (let i = 0; i < 2; i++) {
      const models = await plugin.provider.models({ models: {} }, { auth })
      expect(models["test-tool-capability"].tool_call).toBe(false)
      expect(models["test-tool-capability"].capabilities.toolcall).toBe(false)
    }
    expect(probes).toBe(1)
  } finally {
    globalThis.fetch = original
  }
})

test("工具探测限流时保留能力并允许下次重试", async () => {
  const original = globalThis.fetch
  let probes = 0
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) {
        return Response.json({ data: [{ id: "test-tool-probe-retry" }] })
      }
      if (String(url).endsWith("/responses")) {
        probes++
        return probes === 1
          ? Response.json({ error: { message: "Upstream rate limit exceeded" } }, { status: 429 })
          : Response.json({ error: { message: "This account does not support tools" } }, { status: 400 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
    const plugin = await XingchiPlugin({ client: {} }, {})
    const auth = { type: "api", key: "sk-test-capability-retry" }
    const first = await plugin.provider.models({ models: {} }, { auth })
    expect(first["test-tool-probe-retry"].tool_call).toBe(true)
    expect(first["test-tool-probe-retry"].capabilities.toolcall).toBe(true)
    const second = await plugin.provider.models({ models: {} }, { auth })
    expect(second["test-tool-probe-retry"].tool_call).toBe(false)
    expect(second["test-tool-probe-retry"].capabilities.toolcall).toBe(false)
    expect(probes).toBe(2)
  } finally {
    globalThis.fetch = original
  }
})

test("同名模型按各分组的 key 分别探测并缓存工具能力", async () => {
  const original = globalThis.fetch
  const probes = []
  try {
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      const bearer = new Headers(init?.headers).get("authorization")
      if (path.endsWith("/groups/available")) {
        return Response.json({ code: 0, data: [
          { id: 31, name: "支持工具", rate_multiplier: 1 },
          { id: 32, name: "纯文本", rate_multiplier: 2 },
        ] })
      }
      if (path.endsWith("/keys")) {
        return Response.json({ code: 0, data: [
          { id: 31, key: "sk-test-group-tools-31", group_id: 31, status: "active" },
          { id: 32, key: "sk-test-group-tools-32", group_id: 32, status: "active" },
        ] })
      }
      if (path.endsWith("/user/profile")) {
        return Response.json({ code: 0, data: { balance: 100, dedicated_balance: 100 } })
      }
      if (path.endsWith("/models")) {
        return Response.json({ data: [{ id: "test-group-tool-capability" }] })
      }
      if (path.endsWith("/responses")) {
        probes.push(bearer)
        return bearer === "Bearer sk-test-group-tools-31"
          ? Response.json({ output: [{ type: "function_call" }] })
          : Response.json({ error: { message: "This account only supports Chat Completions" } }, { status: 400 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
    const plugin = await XingchiPlugin({ client: { auth: { set: async () => {} } } }, {})
    const auth = {
      type: "api",
      key: "sk-test-group-tools-31",
      metadata: { accessToken: "jwt-test-groups", primaryGroup: 31 },
    }
    for (let i = 0; i < 2; i++) {
      const models = await plugin.provider.models({ models: {} }, { auth })
      expect(models["test-group-tool-capability"].tool_call).toBe(true)
      expect(models["test-group-tool-capability"].capabilities.toolcall).toBe(true)
      expect(models["test-group-tool-capability-g32"].tool_call).toBe(false)
      expect(models["test-group-tool-capability-g32"].capabilities.toolcall).toBe(false)
    }
    expect(probes.sort()).toEqual([
      "Bearer sk-test-group-tools-31",
      "Bearer sk-test-group-tools-32",
    ])
  } finally {
    globalThis.fetch = original
  }
})

test("loader 用分组那把 key，并把标记从请求体去掉", async () => {
  const original = globalThis.fetch
  try {
    let seenAuth = null
    let seenBody = null
    globalThis.fetch = async (input, init) => {
      seenAuth = init?.headers?.authorization ?? init?.headers?.get?.("authorization")
      seenBody = init?.body
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const plugin = await XingchiPlugin({ client: {} }, {})
    const loader = await plugin.auth.loader(async () => ({
      type: "api",
      key: "sk-main",
      metadata: { groupKeys: { 4: "sk-group4" } },
    }))
    await loader.fetch("https://api.xingchiapi.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-main", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol-g4", input: "hi" }),
    })
    expect(seenAuth).toBe("Bearer sk-group4")
    expect(JSON.parse(seenBody).model).toBe("gpt-5.6-sol")

    // 没有标记就用账号自己的 key
    seenAuth = null
    await loader.fetch("https://api.xingchiapi.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-main", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi" }),
    })
    expect(seenAuth).toBe("Bearer sk-main")
    expect(JSON.parse(seenBody).model).toBe("gpt-6.1-sol")
  } finally {
    globalThis.fetch = original
  }
})
