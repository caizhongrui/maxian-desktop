import { MaxianClient } from "@maxian/sdk"

export const BASE = (import.meta.env.VITE_MAXIAN_URL as string) || "http://127.0.0.1:4096"
export const USER = (import.meta.env.VITE_MAXIAN_USER as string) || "maxian"
export const PASS = (import.meta.env.VITE_MAXIAN_PASS as string) || "test123"

// ─── 本地凭据存储（localStorage） ───────────────────────────────────────────
const CRED_KEY = "maxian_credentials"

export interface SavedCredentials {
  apiUrl: string
  username: string
  password: string
  userInfo: UserInfo
  rememberMe: boolean
}

export interface UserInfo {
  id: string
  userName: string
  nickName?: string
  email?: string
  avatar?: string
  agentPermission?: string[]
}

export function loadSavedCredentials(): SavedCredentials | null {
  try {
    const raw = localStorage.getItem(CRED_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SavedCredentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: SavedCredentials): void {
  localStorage.setItem(CRED_KEY, JSON.stringify(creds))
}

export function clearCredentials(): void {
  localStorage.removeItem(CRED_KEY)
}

// ─── Tauri plugin-http fetch（绕过 webview CORS） ──────────────────────────
async function makeFetch(): Promise<typeof fetch> {
  try {
    // @ts-ignore
    if ((window as any).__TAURI_INTERNALS__) {
      const mod = await import("@tauri-apps/plugin-http")
      return mod.fetch as unknown as typeof fetch
    }
  } catch (e) {
    console.warn("[maxian] tauri http plugin unavailable, fallback to native fetch", e)
  }
  return fetch
}

let _client: MaxianClient | null = null

export async function getClient(): Promise<MaxianClient> {
  if (_client) return _client
  const f = await makeFetch()
  _client = new MaxianClient({ baseUrl: BASE, username: USER, password: PASS, fetch: f })
  return _client
}

export async function waitForServer(maxMs = 15000, intervalMs = 300): Promise<void> {
  const c = await getClient()
  const start = Date.now()
  let lastErr: unknown = null
  let attempts = 0
  while (Date.now() - start < maxMs) {
    attempts++
    try {
      const r = await c.health()
      if (r.ok) {
        console.log(`[maxian] server ready in ${Date.now() - start}ms (${attempts} attempts)`)
        return
      }
    } catch (e) {
      lastErr = e
      if (attempts <= 3) console.warn(`[maxian] health attempt ${attempts} failed:`, e)
    }
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  throw new Error(
    `无法连接到 Maxian Server: ${BASE}\n最后错误: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

/**
 * 验证用户凭据，调用码弦后端 checkUser 接口。
 * 使用 Tauri plugin-http 发出请求（跳过 CORS 限制）。
 */
export async function loginCheck(
  apiUrl: string,
  username: string,
  password: string,
): Promise<UserInfo> {
  const f = await makeFetch()
  const base = apiUrl.replace(/\/$/, "")
  const url = `${base}/knowledge/appCustomer/checkUser?userName=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  const res = await f(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`服务器错误 ${res.status}，请检查服务器地址是否正确`)
  }
  const json = await res.json() as { code: number; msg?: string; data?: UserInfo }
  if (json.code !== 200) {
    throw new Error(json.msg || "用户名或密码错误")
  }
  if (!json.data || typeof json.data !== "object") {
    throw new Error("登录响应格式异常")
  }
  const raw = json.data as any
  return {
    id: raw.id ?? "",
    userName: raw.userName ?? username,
    nickName: raw.nickName,
    email: raw.email,
    avatar: raw.avatar,
    agentPermission: raw.agentPermission
      ? String(raw.agentPermission).split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined,
  }
}

/**
 * 将登录凭据推送到 maxian-server 的 /auth/configure，让服务端以此调用 AI 代理。
 * 用户名和密码均以 base64 编码传输（与 AiProxyHandler 规范一致）。
 */
export async function configureServerAi(apiUrl: string, username: string, password: string): Promise<void> {
  const c = await getClient()
  await c.configureAi({
    apiUrl,
    username: btoa(username),
    password: btoa(password),
  })
}

/** 清除服务端 AI 配置（登出时调用） */
export async function clearServerAi(): Promise<void> {
  const c = await getClient()
  await c.clearAiConfig()
}
