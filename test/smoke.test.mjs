import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

function smoke(status, { streamFailed = false, fallbackFailed = false } = {}) {
  return spawnSync(process.execPath, [
    "--preload", fileURLToPath(new URL("./fixtures/smoke-fetch.mjs", import.meta.url)),
    fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url)),
  ], {
    env: {
      ...process.env,
      XINGCHI_API_KEY: "sk-mocked-smoke-test",
      XINGCHI_SMOKE_TEST_STATUS: String(status),
      XINGCHI_SMOKE_TEST_STREAM_FAILED: streamFailed ? "1" : "",
      XINGCHI_SMOKE_TEST_FALLBACK_FAILED: fallbackFailed ? "1" : "",
    },
    encoding: "utf8",
    timeout: 10000,
  })
}

test("冒烟仅在请求成功且流正常结束时通过", () => {
  const result = smoke(200)
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("SMOKE OK")
})

test.each([400, 401, 403, 404, 429, 500, 503])("冒烟把 HTTP %i 作为失败", (status) => {
  const result = smoke(status)
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain("SMOKE FAILED")
})

test("冒烟把 HTTP 200 的失败流作为失败", () => {
  const result = smoke(200, { streamFailed: true })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain("SMOKE FAILED")
})

test("冒烟把仅 UA 回退请求失败也作为失败", () => {
  const result = smoke(200, { fallbackFailed: true })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain("SMOKE FAILED")
})
