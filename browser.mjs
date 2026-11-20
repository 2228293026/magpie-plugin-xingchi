// 浏览器登录：起一个带调试端口的 Chrome/Edge，用 CDP 读页面里的会话令牌。
//
// 为什么不用邮箱密码直接登录：星驰面板的登录被 Cloudflare Turnstile 强制守着，
// 程序化提交会被拒（POST /api/v1/auth/login 返回
// "turnstile verification failed"）。真人用自己的浏览器点一下就绕开了。
//
// 做法与社区插件（opencode-agnes-auth 等）一致：
//   1. 用独立的 user-data-dir 起一个浏览器窗口，打开登录页；
//   2. 用户在窗口里正常登录；
//   3. 插件轮询页面里的 localStorage，拿到 auth_token / refresh_token；
//   4. 关掉浏览器，把令牌交给 magpie。
//
// 独立 profile 会持久化在磁盘上，所以第二次登录通常不用再输密码。

import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const activeBrowsers = new Set()
process.once("exit", () => {
  for (const child of activeBrowsers) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
})

export function browserArgs(profile, port, url) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    "--new-window",
    url,
  ]
}

export function browserProfileDir(env = process.env, platform = process.platform) {
  if (env.XINGCHI_PROFILE) return env.XINGCHI_PROFILE
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "xingchi-browser")
  }
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"),
    "magpie",
    "xingchi-browser",
  )
}

export function findBrowser(platform = process.platform, env = process.env) {
  if (env.XINGCHI_BROWSER && existsSync(env.XINGCHI_BROWSER)) return env.XINGCHI_BROWSER
  const home = env.HOME || ""
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
          ]
  return candidates.find((path) => path && existsSync(path)) ?? ""
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

export async function cdpTarget(port, targetPrefix) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!res.ok) return null
    const list = await res.json()
    return (
      list.find(
        (target) =>
          target?.type === "page" &&
          typeof target.url === "string" &&
          target.url.startsWith(targetPrefix) &&
          target.webSocketDebuggerUrl,
      ) ?? null
    )
  } catch {
    return null
  }
}

export function cdpEvaluate(
  webSocketUrl,
  expression,
  timeout = 3000,
  WebSocketImpl = globalThis.WebSocket,
) {
  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new WebSocketImpl(webSocketUrl)
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error("CDP timed out"))
    }, timeout)
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      )
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("CDP connection failed"))
    }
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (message.error) {
        reject(new Error(message.error.message || "CDP evaluation failed"))
        return
      }
      if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails
        const text =
          details.exception?.description ||
          details.exception?.value ||
          details.text ||
          "CDP evaluation failed"
        reject(Object.assign(new Error(String(text)), { fatal: true }))
        return
      }
      resolve(message.result?.result?.value)
    }
  })
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// 登录页正在加载时 Chrome 可能报临时 SecurityError，给它一段宽限时间。
export async function waitForBrowserSession(
  evaluate,
  timeoutMs,
  { isActive = () => true, pollMs = 750, fatalGraceMs = 4000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  let lastFatalText = ""
  let fatalSince = 0
  while (Date.now() < deadline && isActive()) {
    try {
      const value = await evaluate(
        '({access: localStorage.getItem("auth_token"), refresh: localStorage.getItem("refresh_token"), user: localStorage.getItem("auth_user"), expiresAt: localStorage.getItem("token_expires_at")})',
      )
      const access = typeof value?.access === "string" ? value.access.trim() : ""
      if (access) {
        let email
        try {
          email = value?.user ? JSON.parse(String(value.user))?.email : undefined
        } catch {}
        const expiresAt = Number(value?.expiresAt)
        return {
          accessToken: access,
          refreshToken: typeof value?.refresh === "string" ? value.refresh.trim() : "",
          email: typeof email === "string" ? email : undefined,
          expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
        }
      }
      lastFatalText = ""
      fatalSince = 0
    } catch (error) {
      if (error?.fatal) {
        const text = String(error.message ?? error)
        const now = Date.now()
        if (text !== lastFatalText) {
          lastFatalText = text
          fatalSince = now
        } else if (now - fatalSince >= fatalGraceMs) {
          throw error
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  if (lastFatalText) throw new Error(lastFatalText)
  return null
}

export async function openBrowserSession(
  url,
  { targetPrefix = "https://xingchiapi.com/", profileDir = browserProfileDir() } = {},
) {
  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      "Chrome or Edge was not found; set XINGCHI_BROWSER or use the token sign-in",
    )
  }
  const port = await freePort()
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(profileDir, 0o700)
  } catch {}

  const child = spawn(browser, browserArgs(profileDir, port, url), {
    stdio: "ignore",
    detached: false,
  })
  activeBrowsers.add(child)

  let closed = false
  let exited = false
  let spawnError = ""
  child.once("error", (error) => {
    spawnError = String(error?.message ?? error)
    exited = true
  })
  child.once("exit", () => {
    exited = true
  })

  let closing = null
  const session = {
    profilePath: profileDir,
    close,
    async evaluate(expression) {
      const target = await cdpTarget(port, targetPrefix)
      if (!target?.webSocketDebuggerUrl) return null
      return await cdpEvaluate(target.webSocketDebuggerUrl, expression)
    },
    async session(timeoutMs) {
      const found = await waitForBrowserSession(
        (expression) => session.evaluate(expression),
        timeoutMs,
        { isActive: () => !closed && !exited },
      )
      if (spawnError) throw new Error(`Chrome failed to start: ${spawnError}`)
      return found
    },
  }

  function close() {
    if (closing) return closing
    closed = true
    closing = (async () => {
      activeBrowsers.delete(child)
      if (child.exitCode === null && child.signalCode === null) {
        // Windows 上 chrome.exe 会带出一串子进程，用 taskkill /T 收干净。
        if (process.platform === "win32" && child.pid) {
          try {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              detached: false,
            })
          } catch {}
        }
        try {
          child.kill("SIGTERM")
        } catch {}
        await waitForExit(child, 2000)
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {}
        await waitForExit(child, 1000)
      }
    })()
    return closing
  }

  return session
}
