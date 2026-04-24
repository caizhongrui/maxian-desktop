import { createSignal, createMemo, For, Show, onMount, onCleanup, createEffect } from "solid-js"
import type { SessionSummary, Workspace, MaxianEvent, StoredMessage } from "@maxian/sdk"
import { renderMarkdown } from "./markdown"
import hljs from "highlight.js/lib/common"
import "highlight.js/styles/github-dark.css"
import logoUrl from "./assets/logo.png"
import {
  getClient, waitForServer,
  loadSavedCredentials, saveCredentials, clearCredentials,
  loginCheck, configureServerAi, clearServerAi,
  BASE, USER, PASS,
  type SavedCredentials, type UserInfo,
} from "./api"
import { initI18n, t, setLocale, getLocale } from "./i18n"

/** 等待工具审批时的状态 */
interface ApprovalRequest {
  sessionId: string
  toolUseId: string
  toolName: string
  toolParams: Record<string, unknown>
}

/** 文件变更记录 */
interface FileChangeEntry {
  path: string
  action: 'modified' | 'created' | 'deleted'
}

/** 预览标签（右侧预览面板中的一个打开文件） */
interface PreviewTab {
  path:      string                           // 文件路径（相对或绝对）
  title:     string                           // 标签页标题（basename）
  kind:      'text' | 'image' | 'audio' | 'video' | 'binary' | 'markdown'
  content:   string                           // 文本或 base64
  mimeType:  string
  size:      number
  error?:    string
  loading:   boolean
  viewMode:  'source' | 'diff' | 'rendered'   // markdown: source/rendered, 变更文件: source/diff
  changed?:  FileChangeEntry['action']        // 若该文件在会话中被修改过
  // diff 数据（懒加载）
  diffOriginal?: string | null
  diffCurrent?:  string
  diffLoading?:  boolean
  /** 外部变更检测（P0-4）: 监测到文件被外部修改时的时间戳 */
  extChangedAt?: number
  /** 跳转到行号（P0-1）: 加载完成后滚动定位 */
  pendingLine?: number
  /** 已加载时的磁盘 mtime（P0-4: 外部变更检测） */
  mtimeMs?: number
}

/** 附加图片 */
interface AttachedImage {
  id: string
  dataUrl: string  // base64 data URL
  name: string
}

/** 集成终端 Tab */
interface TerminalTab {
  id: string
  title: string
  sessionId: string   // 所属会话 ID，用于多会话终端隔离
}

/** 弹出确认对话框：Tauri 环境用插件，浏览器用 window.confirm */
async function appConfirm(message: string): Promise<boolean> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { confirm } = await import("@tauri-apps/plugin-dialog")
      return await confirm(message, { kind: "warning" })
    } catch {
      // 插件不可用时降级
    }
  }
  return window.confirm(message)
}

type AppStatus  = "login" | "booting" | "ready" | "error"
type SettingsTab = "general" | "appearance" | "worktree" | "mcp" | "keybinds" | "templates" | "usage" | "errors" | "plugins" | "about"
type Theme      = "dark" | "light" | "system"

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system" | "error" | "tool" | "reasoning"
  content: string
  isPartial?: boolean
  /** 创建时间戳（毫秒），live 消息用 Date.now()，DB 消息用 created_at */
  createdAt?: number
  /** 工具调用专属字段 */
  toolName?: string
  toolUseId?: string
  toolSuccess?: boolean
  toolParams?: Record<string, unknown>   // 工具原始参数（用于展示文件路径等）
  toolResult?: string                    // 工具执行结果摘要
  liveOutput?: string                    // 流式工具实时输出（bash 的 stdout/stderr）
  /** 思考过程专属字段 */
  charCount?: number                     // 完成时的字符数
}

// ─── 工具名称 → 中文标签映射 ───────────────────────────────────────────────
const TOOL_LABELS: Record<string, string> = {
  read_file:       "读取文件",
  write_to_file:   "写入文件",
  edit:            "编辑文件",
  multiedit:       "多处编辑",
  search_files:    "搜索文件",
  list_files:      "列出目录",
  execute_command: "执行命令",
  todo_write:      "更新任务",
  web_fetch:       "获取网页",
  load_skill:      "加载技能",
}

// ─── 工具名称 → SVG 图标路径（codicon 风格） ──────────────────────────────
const TOOL_ICONS: Record<string, string> = {
  read_file:       "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z",
  write_to_file:   "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  edit:            "M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83zM3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z",
  multiedit:       "M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83zM7 4h2v2H7zm0 4h2v2H7zm0 4h2v2H7z",
  search_files:    "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  list_files:      "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  execute_command: "M8 5v14l11-7z",
  todo_write:      "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z",
  web_fetch:       "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
}

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

function getToolSubtitle(name: string, params?: Record<string, unknown>): string {
  if (!params) return ""
  switch (name) {
    case "read_file":
    case "write_to_file":
    case "edit":
    case "multiedit":
      return (params.path as string) || ""
    case "search_files": {
      const p = (params.path as string) || ""
      const r = (params.regex as string) || ""
      return p && r ? `${p}  ·  ${r}` : (p || r)
    }
    case "list_files":
      return (params.path as string) || ""
    case "execute_command": {
      const cmd = (params.command as string) || ""
      return cmd.length > 72 ? cmd.slice(0, 72) + "…" : cmd
    }
    case "todo_write": {
      const todos = params.todos as Array<{status: string; content: string}> | undefined
      if (!todos) return ""
      const inProgress = todos.find(t => t.status === 'in_progress')
      if (inProgress) return `正在: ${inProgress.content}`
      const pending = todos.filter(t => t.status === 'pending').length
      const done = todos.filter(t => t.status === 'completed').length
      return `${done}/${todos.length} 已完成`
    }
    case "web_fetch":
      return (params.url as string) || ""
    default:
      return ""
  }
}

const THEME_KEY       = "maxian_theme"
const FONT_FAMILY_KEY = "maxian_font_family"
const FONT_SIZE_KEY   = "maxian_font_size"
const DEFAULT_API_URL = "http://10.205.81.162/api"

// ─── Font options ────────────────────────────────────────────────────────────
const FONT_FAMILIES = [
  { value: "system",      label: "系统默认",    css: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { value: "pingfang",   label: "PingFang SC",  css: "'PingFang SC', 'Hiragino Sans GB', sans-serif" },
  { value: "msyahei",    label: "微软雅黑",      css: "'Microsoft YaHei', 'WenQuanYi Micro Hei', sans-serif" },
  { value: "sourcehansans", label: "思源黑体",   css: "'Source Han Sans CN', 'Noto Sans CJK SC', 'PingFang SC', sans-serif" },
  { value: "noto",       label: "Noto Sans",    css: "'Noto Sans', 'Noto Sans CJK SC', sans-serif" },
  { value: "helvetica",  label: "Helvetica Neue", css: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
]

// ─── Theme / font helpers ────────────────────────────────────────────────────
function loadTheme(): Theme {
  return (localStorage.getItem(THEME_KEY) as Theme) || "dark"
}
function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t)
  localStorage.setItem(THEME_KEY, t)
}

function loadFontFamily(): string {
  return localStorage.getItem(FONT_FAMILY_KEY) || "system"
}
function loadFontSize(): number {
  return parseInt(localStorage.getItem(FONT_SIZE_KEY) || "13", 10)
}
function applyFont(family: string, size: number) {
  const def = FONT_FAMILIES.find(f => f.value === family) ?? FONT_FAMILIES[0]
  document.documentElement.style.setProperty("--font-sans", def.css)
  document.documentElement.style.setProperty("--font-size-base", `${size}px`)
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // App status
  const [appStatus, setAppStatus] = createSignal<AppStatus>("login")
  const [bootError, setBootError] = createSignal("")

  // Auth
  const [currentUser, setCurrentUser] = createSignal<UserInfo | null>(null)
  const [loginApiUrl, setLoginApiUrl] = createSignal(DEFAULT_API_URL)
  const [loginUsername, setLoginUsername] = createSignal("")
  const [loginPassword, setLoginPassword] = createSignal("")
  const [loginRemember, setLoginRemember] = createSignal(true)
  const [loginError, setLoginError] = createSignal("")
  const [loginLoading, setLoginLoading] = createSignal(false)

  // View
  const [showSettings, setShowSettings] = createSignal(false)
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("appearance")

  // Theme
  const [theme, setThemeSignal] = createSignal<Theme>(loadTheme())

  // Font
  const [fontFamily, setFontFamilySignal] = createSignal<string>(loadFontFamily())
  const [fontSize, setFontSizeSignal] = createSignal<number>(loadFontSize())

  // Mode: 'code' (Agent + tools) or 'chat' (Q&A only)
  const [globalMode, setGlobalMode] = createSignal<'code' | 'chat'>('code')

  // Sidebar user panel
  const [userExpanded, setUserExpanded] = createSignal(false)

  // Inline rename state
  const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null)
  const [editingWorkspaceName, setEditingWorkspaceName] = createSignal("")
  const [editingSessionId, setEditingSessionId] = createSignal<string | null>(null)
  const [editingSessionTitle, setEditingSessionTitle] = createSignal("")

  // Collapsed workspace groups (Set of workspace IDs)
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set())

  // Tool card expand state (Set of toolUseIds that are EXPANDED; completed tools are collapsed by default)
  const [expandedTools, setExpandedTools] = createSignal<Set<string>>(new Set())
  // Reasoning block expand state (Set of msg IDs that are expanded; completed reasoning collapsed by default)
  const [expandedReasonings, setExpandedReasonings] = createSignal<Set<string>>(new Set())

  // ── 权限审批对话框 ─────────────────────────────────────────────────────────
  const [approvalRequest, setApprovalRequest] = createSignal<ApprovalRequest | null>(null)

  // ── 文件变更树面板 ─────────────────────────────────────────────────────────
  const [showFileTree, setShowFileTree] = createSignal(false)
  const [changedFiles, setChangedFiles] = createSignal<Map<string, FileChangeEntry>>(new Map())

  // ── 右侧预览面板 ──────────────────────────────────────────────────────────
  const [previewTabs, setPreviewTabs] = createSignal<PreviewTab[]>([])
  const [activePreviewPath, setActivePreviewPath] = createSignal<string | null>(null)
  // 预览面板宽度（像素），可拖动
  const [previewWidth, setPreviewWidth] = createSignal(520)

  // ── 工作区文件浏览器面板 ──────────────────────────────────────────────────
  const [showExplorer, setShowExplorer] = createSignal(false)
  const [explorerSearch, setExplorerSearch] = createSignal("")

  // ── Diff 视图模式（P1-12）: unified / split ─────────────────────────────
  const [diffViewMode, setDiffViewMode] = createSignal<'unified' | 'split'>('unified')

  // ── Todo 跟踪面板（P0-1） ────────────────────────────────────────────────
  interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
  const [todos, setTodos] = createSignal<TodoItem[]>([])
  const [todoDockCollapsed, setTodoDockCollapsed] = createSignal(false)

  // ── Followup 建议队列（P0-2） ───────────────────────────────────────────
  const [followupSuggestions, setFollowupSuggestions] = createSignal<string[]>([])
  const [followupQueue, setFollowupQueue] = createSignal<string[]>([])
  const [followupCollapsed, setFollowupCollapsed] = createSignal(false)

  // ── Rate-limit 重试 UI（P0-6） ──────────────────────────────────────────
  interface RateLimitState { active: boolean; resetAt: number; attempt: number; message: string }
  const [rateLimit, setRateLimit] = createSignal<RateLimitState>({ active: false, resetAt: 0, attempt: 0, message: '' })

  // ── Context 标签页（P1-10） ─────────────────────────────────────────────
  const [showContextPanel, setShowContextPanel] = createSignal(false)
  // contextFiles memo 移到 messages 信号声明之后，避免 TDZ

  // ── Session revert dock（P1-11） ────────────────────────────────────────
  const [showRevertDock, setShowRevertDock] = createSignal(false)

  // ── Agent 提问对话框（question 工具）───────────────────────────────────
  interface QuestionRequest {
    sessionId: string
    question:  string
    options:   string[]
    multi:     boolean
  }
  const [questionRequest, setQuestionRequest] = createSignal<QuestionRequest | null>(null)

  // ── 上下文压缩状态（进行中时显示持续 banner） ─────────────────────────
  interface CompactingState {
    tokensCurrent: number
    willLevel2:    boolean
    manual:        boolean
    startedAt:     number
  }
  const [compactingState, setCompactingState] = createSignal<CompactingState | null>(null)
  const [questionAnswer,  setQuestionAnswer]  = createSignal('')
  const [questionSelected, setQuestionSelected] = createSignal<string[]>([])

  // ── Plan Exit 对话框 ──────────────────────────────────────────────────
  interface PlanExitRequest {
    sessionId: string
    summary:   string
    steps:     string
  }
  const [planExitRequest, setPlanExitRequest] = createSignal<PlanExitRequest | null>(null)
  const [planExitFeedback, setPlanExitFeedback] = createSignal('')

  async function revertToMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    const ok = await appConfirm('确定要回退到此消息吗？该消息及其后所有消息将被永久删除。')
    if (!ok) return
    try {
      const c = await getClient()
      const res = await c.revertToMessage(sid, msgId)
      if (!res.ok) throw new Error(res.error ?? '回退失败')
      showToast({ message: `已回退，删除 ${res.deleted} 条消息`, kind: 'success' })
      // 重新加载消息
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      setShowRevertDock(false)
    } catch (e) {
      showToast({ message: '回退失败: ' + (e as Error).message, kind: 'error' })
    }
  }

  // ── 图像生成输出（P1-16）: 消息里解析 [[image:base64]] 标记 ────────────

  // ── Skills 面板 ───────────────────────────────────────────────────────────
  type SkillEntry = {
    name:        string
    description: string
    path:        string
    source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude'
    size:        number
  }
  const [showSkillsPanel, setShowSkillsPanel] = createSignal(false)
  const [skillsList, setSkillsList] = createSignal<SkillEntry[]>([])
  const [skillsLoading, setSkillsLoading] = createSignal(false)
  const [skillsSearchedDirs, setSkillsSearchedDirs] = createSignal<Array<{ path: string; source: string; exists: boolean }>>([])

  // ── Token 用量 ─────────────────────────────────────────────────────────────
  const [tokenUsed, setTokenUsed] = createSignal(0)
  // tokenLimit 由后端根据实际模型窗口上报（token_usage 事件的 limit 字段）
  // 默认 1M（Qwen3-coder-plus / Claude 1M / Qwen-max-longcontext），
  // 后端通过 MAXIAN_CONTEXT_WINDOW 环境变量可覆盖，上报给前端后实时更新
  const [tokenLimit, setTokenLimit] = createSignal(1_000_000)

  // ── Slash 命令面板 ─────────────────────────────────────────────────────────
  const [showSlash, setShowSlash] = createSignal(false)
  const [slashQuery, setSlashQuery] = createSignal("")
  const [slashIdx, setSlashIdx] = createSignal(0)

  // ── 图片附件 ──────────────────────────────────────────────────────────────
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([])

  // ── 全局 Toast 系统（带 action 按钮） ─────────────────────────────────────
  interface ToastItem {
    id:       string
    message:  string
    kind:     'info' | 'success' | 'warn' | 'error'
    action?:  { label: string; onClick: () => void }
    duration: number
  }
  const [toasts, setToasts] = createSignal<ToastItem[]>([])
  function showToast(opts: {
    message:  string
    kind?:    ToastItem['kind']
    action?:  ToastItem['action']
    duration?: number
  }) {
    const id = Math.random().toString(36).slice(2)
    const toast: ToastItem = {
      id,
      message:  opts.message,
      kind:     opts.kind ?? 'info',
      action:   opts.action,
      duration: opts.duration ?? 4000,
    }
    setToasts(prev => [...prev, toast])
    if (toast.duration > 0) {
      setTimeout(() => dismissToast(id), toast.duration)
    }
    return id
  }
  function dismissToast(id: string) {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  // ── Prompt 历史（↑/↓ 翻历史）────────────────────────────────────────────
  const HISTORY_STORAGE_KEY = 'maxian:prompt-history'
  const HISTORY_MAX         = 100
  const [promptHistory, setPromptHistory] = createSignal<string[]>(
    (() => { try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]') } catch { return [] } })()
  )
  const [historyIdx, setHistoryIdx] = createSignal(-1)  // -1 = 新输入；0..n-1 = 历史条目
  const [historyDraft, setHistoryDraft] = createSignal('')
  function pushPromptHistory(text: string) {
    if (!text.trim()) return
    setPromptHistory(prev => {
      // 去重：若最新一条相同则跳过
      if (prev[prev.length - 1] === text) return prev
      const next = [...prev, text].slice(-HISTORY_MAX)
      try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next)) } catch {}
      return next
    })
    setHistoryIdx(-1)
  }

  // ── 键盘快捷键速查面板 ───────────────────────────────────────────────────
  const [showKeybindHelp, setShowKeybindHelp] = createSignal(false)
  const [keybindSearch, setKeybindSearch] = createSignal('')

  // ── Vim 模式（composer textarea 的基础 modal 编辑）────────────────────
  const VIM_ENABLED_KEY = 'maxian:vim-enabled'
  const [vimEnabled, setVimEnabled] = createSignal<boolean>(
    (() => { try { return localStorage.getItem(VIM_ENABLED_KEY) === '1' } catch { return false } })()
  )
  function toggleVim(on: boolean) {
    setVimEnabled(on)
    try { localStorage.setItem(VIM_ENABLED_KEY, on ? '1' : '0') } catch {}
  }
  type VimMode = 'normal' | 'insert' | 'visual'
  const [vimMode, setVimMode] = createSignal<VimMode>('insert')
  // 暂存寄存器（yank / delete）
  let vimRegister = ''
  /** vim 按键处理器（返回 true 表示已处理，阻止默认） */
  function handleVimKey(e: KeyboardEvent, ta: HTMLTextAreaElement): boolean {
    if (!vimEnabled()) return false
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    const mode = vimMode()
    const k = e.key

    // Esc 任何时候 → normal
    if (k === 'Escape') { setVimMode('normal'); e.preventDefault(); return true }

    if (mode === 'insert') {
      // insert 模式下除了 Esc 都透传
      return false
    }

    if (mode === 'normal' || mode === 'visual') {
      const val = ta.value
      const pos = ta.selectionStart
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1
      const lineEnd   = val.indexOf('\n', pos); const lineEndIdx = lineEnd < 0 ? val.length : lineEnd

      const set = (s: number, ePos?: number) => {
        ta.selectionStart = s
        ta.selectionEnd   = ePos ?? s
      }

      if (k === 'i') { setVimMode('insert'); e.preventDefault(); return true }
      if (k === 'a') { set(pos + 1); setVimMode('insert'); e.preventDefault(); return true }
      if (k === 'A') { set(lineEndIdx); setVimMode('insert'); e.preventDefault(); return true }
      if (k === 'I') { set(lineStart); setVimMode('insert'); e.preventDefault(); return true }
      if (k === 'o') {
        ta.value = val.slice(0, lineEndIdx) + '\n' + val.slice(lineEndIdx)
        set(lineEndIdx + 1); setVimMode('insert'); e.preventDefault(); return true
      }
      if (k === 'O') {
        ta.value = val.slice(0, lineStart) + '\n' + val.slice(lineStart)
        set(lineStart); setVimMode('insert'); e.preventDefault(); return true
      }
      if (k === 'h') { set(Math.max(0, pos - 1)); e.preventDefault(); return true }
      if (k === 'l') { set(Math.min(val.length, pos + 1)); e.preventDefault(); return true }
      if (k === 'j') {
        const nextLineStart = lineEndIdx + 1
        if (nextLineStart > val.length) return true
        const col = pos - lineStart
        const nextLineEnd = val.indexOf('\n', nextLineStart)
        const nlEnd = nextLineEnd < 0 ? val.length : nextLineEnd
        set(Math.min(nextLineStart + col, nlEnd))
        e.preventDefault(); return true
      }
      if (k === 'k') {
        if (lineStart === 0) return true
        const prevLineEnd = lineStart - 1
        const prevLineStart = val.lastIndexOf('\n', prevLineEnd - 1) + 1
        const col = pos - lineStart
        set(Math.min(prevLineStart + col, prevLineEnd))
        e.preventDefault(); return true
      }
      if (k === '0' || k === 'Home') { set(lineStart); e.preventDefault(); return true }
      if (k === '$' || k === 'End')  { set(lineEndIdx); e.preventDefault(); return true }
      if (k === 'w') {
        // 下一个单词起点
        let i = pos
        while (i < val.length && /\w/.test(val[i])) i++
        while (i < val.length && !/\w/.test(val[i])) i++
        set(i); e.preventDefault(); return true
      }
      if (k === 'b') {
        let i = pos
        while (i > 0 && !/\w/.test(val[i - 1])) i--
        while (i > 0 && /\w/.test(val[i - 1])) i--
        set(i); e.preventDefault(); return true
      }
      if (k === 'x') {
        ta.value = val.slice(0, pos) + val.slice(pos + 1)
        set(pos); e.preventDefault(); return true
      }
      if (k === 'D') {
        ta.value = val.slice(0, pos) + val.slice(lineEndIdx)
        vimRegister = val.slice(pos, lineEndIdx)
        set(pos); e.preventDefault(); return true
      }
      if (k === 'p') {
        ta.value = val.slice(0, pos + 1) + vimRegister + val.slice(pos + 1)
        set(pos + 1 + vimRegister.length); e.preventDefault(); return true
      }
      // 屏蔽普通字符输入
      if (k.length === 1 && /[a-zA-Z0-9]/.test(k)) {
        e.preventDefault()
        return true
      }
    }
    return false
  }

  // ── 项目级自定义 command（从 .maxian/commands/*.md 加载，动态合入 slash 面板） ──
  interface CustomCmdEntry { name: string; description: string; template: string; agent?: string }
  const [customCommands, setCustomCommands] = createSignal<CustomCmdEntry[]>([])
  async function refreshProjectConfig() {
    const ws = activeWorkspace()
    if (!ws) { setCustomCommands([]); return }
    try {
      const c = await getClient()
      const r = await c.getProjectConfig(ws.id)
      setCustomCommands(r.commands ?? [])
    } catch { /* ignore */ }
  }
  createEffect(() => {
    const ws = activeWorkspace()
    if (ws) void refreshProjectConfig()
  })

  // ── Session 模板 ────────────────────────────────────────────────────
  const TEMPLATE_KEY = 'maxian:session-templates'
  interface SessionTemplate { name: string; content: string; tags?: string[] }
  const [sessionTemplates, setSessionTemplates] = createSignal<SessionTemplate[]>(
    (() => { try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]') } catch { return [] } })()
  )
  function addSessionTemplate(t: SessionTemplate) {
    const next = [...sessionTemplates(), t]
    setSessionTemplates(next)
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next)) } catch {}
  }
  function removeSessionTemplate(name: string) {
    const next = sessionTemplates().filter(t => t.name !== name)
    setSessionTemplates(next)
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next)) } catch {}
  }

  // ── 错误追踪（最近 50 条错误事件）────────────────────────────────────
  interface ErrorEntry { id: string; ts: number; sessionId?: string; source: string; message: string }
  const [errorLog, setErrorLog] = createSignal<ErrorEntry[]>([])
  function pushError(source: string, message: string, sessionId?: string) {
    setErrorLog(prev => [
      { id: Math.random().toString(36).slice(2), ts: Date.now(), source, message, sessionId },
      ...prev,
    ].slice(0, 50))
  }

  // ── 自定义快捷键（localStorage 持久化）────────────────────────────────
  const KEYBIND_STORAGE = 'maxian:keybinds'
  type KeybindAction = 'new-session' | 'close-session' | 'prev-session' | 'next-session'
    | 'cmd-palette' | 'slash-cmd' | 'terminal' | 'settings' | 'help' | 'global-search'
  interface KeybindEntry { action: KeybindAction; label: string; defaultKey: string }
  const KEYBIND_DEFAULTS: KeybindEntry[] = [
    { action: 'new-session',   label: '新建会话',        defaultKey: 'mod+n' },
    { action: 'close-session', label: '关闭当前会话',    defaultKey: 'mod+w' },
    { action: 'prev-session',  label: '上一个会话',      defaultKey: 'mod+[' },
    { action: 'next-session',  label: '下一个会话',      defaultKey: 'mod+]' },
    { action: 'slash-cmd',     label: '斜杠命令面板',    defaultKey: 'mod+k' },
    { action: 'cmd-palette',   label: '全局搜索',        defaultKey: 'mod+p' },
    { action: 'terminal',      label: '切换终端',        defaultKey: 'mod+`' },
    { action: 'settings',      label: '打开设置',        defaultKey: 'mod+,' },
    { action: 'help',          label: '快捷键速查',      defaultKey: 'mod+/' },
  ]
  const [customKeybinds, setCustomKeybinds] = createSignal<Record<string, string>>(
    (() => { try { return JSON.parse(localStorage.getItem(KEYBIND_STORAGE) || '{}') } catch { return {} } })()
  )
  function getKeybind(action: KeybindAction): string {
    const custom = customKeybinds()[action]
    if (custom) return custom
    return KEYBIND_DEFAULTS.find(k => k.action === action)?.defaultKey ?? ''
  }
  function setKeybind(action: KeybindAction, key: string) {
    const next = { ...customKeybinds(), [action]: key }
    setCustomKeybinds(next)
    try { localStorage.setItem(KEYBIND_STORAGE, JSON.stringify(next)) } catch {}
  }
  function resetKeybind(action: KeybindAction) {
    const next = { ...customKeybinds() }
    delete next[action]
    setCustomKeybinds(next)
    try { localStorage.setItem(KEYBIND_STORAGE, JSON.stringify(next)) } catch {}
  }
  /** 把 KeyboardEvent 转成 "mod+X" 字符串 */
  function eventToKeybind(e: KeyboardEvent): string {
    const mod = e.metaKey || e.ctrlKey
    const shift = e.shiftKey
    const alt = e.altKey
    let k = e.key.toLowerCase()
    if (k === ' ') k = 'space'
    const parts: string[] = []
    if (mod) parts.push('mod')
    if (alt) parts.push('alt')
    if (shift) parts.push('shift')
    parts.push(k)
    return parts.join('+')
  }
  /** 检查 KeyboardEvent 是否匹配绑定字符串 */
  function matchKeybind(e: KeyboardEvent, bind: string): boolean {
    return eventToKeybind(e) === bind.toLowerCase()
  }

  // ── 全局命令面板（⌘P）────────────────────────────────────────────────
  interface PaletteItem {
    type:   'session' | 'file' | 'symbol' | 'command'
    label:  string
    desc?:  string
    onSelect: () => void | Promise<void>
  }
  const [showCmdPalette, setShowCmdPalette] = createSignal(false)
  const [cmdPaletteQuery, setCmdPaletteQuery] = createSignal('')
  const [cmdPaletteIdx, setCmdPaletteIdx] = createSignal(0)
  const [cmdPaletteLoading, setCmdPaletteLoading] = createSignal(false)
  const [cmdPaletteItems, setCmdPaletteItems] = createSignal<PaletteItem[]>([])

  // ── 消息键盘导航（j/k 或 ↑/↓）──────────────────────────────────────────
  const [focusedMsgIdx, setFocusedMsgIdx] = createSignal<number>(-1)

  // ── 代码块 "应用到文件"（P0-2）───────────────────────────────────────────
  const [applyDialog, setApplyDialog] = createSignal<{
    open:    boolean
    code:    string
    lang?:   string
    target:  string
    mode:    'overwrite' | 'append'
    loading: boolean
    error?:  string
  }>({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })
  function openApplyToFileDialog(code: string, lang?: string) {
    // 默认目标：首个已打开的预览；否则空
    const firstPreview = previewTabs()[0]?.path ?? ''
    setApplyDialog({
      open: true,
      code,
      lang,
      target: firstPreview,
      mode: 'overwrite',
      loading: false,
    })
  }
  async function confirmApplyToFile() {
    const dlg = applyDialog()
    const ws = activeWorkspace()
    if (!ws) { setApplyDialog(d => ({ ...d, error: '未打开工作区' })); return }
    const target = dlg.target.trim()
    if (!target) { setApplyDialog(d => ({ ...d, error: '请选择目标文件' })); return }
    setApplyDialog(d => ({ ...d, loading: true, error: undefined }))
    try {
      const c = await getClient()
      let finalContent = dlg.code
      if (dlg.mode === 'append') {
        // 读现有文件，追加（加一个空行分隔）
        try {
          const cur = await c.readFileContent(ws.id, target)
          const base = cur?.content ?? ''
          finalContent = base.endsWith('\n') ? base + dlg.code : base + '\n' + dlg.code
        } catch {
          // 不存在就直接用新内容
        }
      }
      const res = await c.writeFileContent(ws.id, target, finalContent, { createIfMissing: true })
      showToast({
        message: `已${res.created ? '创建' : '写入'}：${target}`,
        kind: 'success',
        action: { label: '查看', onClick: () => void openPreview(target, { viewMode: 'source' }) },
      })
      // 若该文件有打开标签：刷新内容
      const existing = previewTabs().find(t => t.path === target)
      if (existing) {
        const data = await c.readFileContent(ws.id, target)
        setPreviewTabs(prev => prev.map(t => t.path === target
          ? { ...t, content: data.content, size: data.size, mimeType: data.mimeType, loading: false }
          : t
        ))
      }
      setApplyDialog({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })
    } catch (e) {
      setApplyDialog(d => ({ ...d, loading: false, error: (e as Error).message }))
    }
  }

  // ── 会话内 Cmd+F 搜索（P0-3）─────────────────────────────────────────────
  const [showInChatSearch, setShowInChatSearch] = createSignal(false)
  const [inChatSearchQuery, setInChatSearchQuery] = createSignal('')
  const [inChatSearchIdx, setInChatSearchIdx] = createSignal(0)
  let inChatSearchInputRef: HTMLInputElement | undefined
  /** 当前所有命中消息的 idx（在 viewGroups 中的索引） */
  const inChatSearchHits = createMemo((): number[] => {
    const q = inChatSearchQuery().trim().toLowerCase()
    if (!q || !showInChatSearch()) return []
    const hits: number[] = []
    const groups = viewGroups()
    for (let i = 0; i < groups.length; i++) {
      const vg = groups[i]
      const text = extractVgText(vg).toLowerCase()
      if (text.includes(q)) hits.push(i)
    }
    return hits
  })
  /** 把一个 ViewGroup 压成可搜文本 */
  function extractVgText(vg: ViewGroup): string {
    try {
      if (vg.kind === 'msg') {
        return (vg.data as any)?.content ?? ''
      }
      if (vg.kind === 'tool-batch') {
        return (vg.tools ?? []).map((t: any) => {
          const name = t?.toolName ?? ''
          const input = t?.toolInput ? (typeof t.toolInput === 'string' ? t.toolInput : JSON.stringify(t.toolInput)) : ''
          const out = t?.content ?? ''
          return `${name} ${input} ${out}`
        }).join('\n')
      }
    } catch {}
    return ''
  }
  function openInChatSearch() {
    setShowInChatSearch(true)
    setInChatSearchIdx(0)
    setTimeout(() => { inChatSearchInputRef?.focus(); inChatSearchInputRef?.select() }, 0)
  }
  function closeInChatSearch() {
    setShowInChatSearch(false)
  }
  function jumpToSearchHit(idx: number) {
    const hits = inChatSearchHits()
    if (hits.length === 0) return
    const i = ((idx % hits.length) + hits.length) % hits.length
    setInChatSearchIdx(i)
    const targetMsgIdx = hits[i]
    setFocusedMsgIdx(targetMsgIdx)
    queueMicrotask(() => {
      const el = document.querySelector(`[data-msg-idx="${targetMsgIdx}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  // ── 消息过滤器（P1-13）: 隐藏内部工具、折叠 reasoning ─────────────────────
  const FILTER_STORAGE_KEY = 'maxian:msg-filter'
  interface MsgFilter { hideTodos: boolean; hideReasoning: boolean; hideInternalTools: boolean }
  const [msgFilter, setMsgFilter] = createSignal<MsgFilter>(
    (() => { try { return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '') } catch { return null } })()
      ?? { hideTodos: false, hideReasoning: false, hideInternalTools: false }
  )
  const [showFilterMenu, setShowFilterMenu] = createSignal(false)
  function updateMsgFilter(patch: Partial<MsgFilter>) {
    const next = { ...msgFilter(), ...patch }
    setMsgFilter(next)
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next)) } catch {}
  }
  /** 一批内部工具名（AI 调用但通常对用户价值不高） */
  const INTERNAL_TOOL_NAMES = new Set(['todo_write', 'load_skill', 'ask_followup_question', 'update_todo_list'])

  // ── 权限记忆（P1-14）: 持久化到 localStorage ──────────────────────────────
  const ALLOW_ALWAYS_KEY = 'maxian:tool-allow-always'  // 全局：永久允许的工具名
  const [allowAlways, setAllowAlways] = createSignal<Set<string>>(
    new Set<string>(
      (() => { try { return JSON.parse(localStorage.getItem(ALLOW_ALWAYS_KEY) || '[]') } catch { return [] } })()
    )
  )
  // 当前会话的一次性允许列表（不持久化，切会话就重置）
  const [sessionAllow, setSessionAllow] = createSignal<Map<string, Set<string>>>(new Map())
  function addAllowAlways(toolName: string) {
    setAllowAlways(prev => {
      const next = new Set(prev)
      next.add(toolName)
      try { localStorage.setItem(ALLOW_ALWAYS_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }
  function removeAllowAlways(toolName: string) {
    setAllowAlways(prev => {
      const next = new Set(prev)
      next.delete(toolName)
      try { localStorage.setItem(ALLOW_ALWAYS_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }
  function addSessionAllow(sessionId: string, toolName: string) {
    setSessionAllow(prev => {
      const next = new Map(prev)
      const set = new Set(next.get(sessionId) ?? [])
      set.add(toolName)
      next.set(sessionId, set)
      return next
    })
  }
  function isAutoApproved(sessionId: string, toolName: string): boolean {
    if (allowAlways().has(toolName)) return true
    if (sessionAllow().get(sessionId)?.has(toolName)) return true
    return false
  }

  // ── 作曲模式 (Code / Ask / Plan / Bypass) ────────────────────────────────
  type ComposerMode = 'code' | 'ask' | 'plan' | 'bypass'
  const [composerMode, setComposerMode] = createSignal<ComposerMode>('code')
  const [showModeDropdown, setShowModeDropdown] = createSignal(false)

  // ── 面板位置（slash / mention 下拉用 fixed 定位）────────────────────────────
  const [paletteRect, setPaletteRect] = createSignal({ bottom: 100, left: 0, width: 600 })
  let composerWrapRef: HTMLDivElement | undefined

  // ── Git 状态栏 ────────────────────────────────────────────────────────────
  const [currentBranch, setCurrentBranch] = createSignal<string | null>(null)
  const [showBranchPicker, setShowBranchPicker] = createSignal(false)
  const [branchPickerBranches, setBranchPickerBranches] = createSignal<string[]>([])
  const [branchPickerLoading, setBranchPickerLoading] = createSignal(false)
  const [branchPickerSearch, setBranchPickerSearch] = createSignal("")
  const [branchPickerRect, setBranchPickerRect] = createSignal({ bottom: 0, left: 0 })

  // ── 集成终端 ──────────────────────────────────────────────────────────────
  const [showTerminal, setShowTerminal] = createSignal(false)
  const [terminalCollapsed, setTerminalCollapsed] = createSignal(false)
  const [terminalHeight, setTerminalHeight] = createSignal(280)
  const [terminalTabs, setTerminalTabs] = createSignal<TerminalTab[]>([])
  const [activeTermId, setActiveTermId] = createSignal<string | null>(null)
  /** xterm.js + WebSocket 实例 Map（id → 实例），生命周期与 App 相同 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termInstances = new Map<string, { term: any; ws: WebSocket; fit: any; resizeObs?: ResizeObserver }>()
  /** 每个会话的终端状态快照（仅记录 show/collapsed/height，tabs 通过 sessionId 字段过滤） */
  interface SessionTerminalSnapshot {
    show: boolean
    collapsed: boolean
    height: number
    activeTermId: string | null
  }
  const sessionTerminalSnapshots = new Map<string, SessionTerminalSnapshot>()

  // Main state
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
  const [activeWorkspace, setActiveWorkspace] = createSignal<Workspace | null>(null)
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  // 会话搜索（sidebar 顶部，按标题模糊过滤）
  const [sessionSearch, setSessionSearch] = createSignal('')
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  // contextFiles: 从消息里提取 @ 文件引用（P1-10）
  const contextFiles = createMemo(() => {
    const set = new Set<string>()
    for (const m of messages()) {
      if (m.role !== 'user') continue
      const matches = m.content.match(/@[\S]+/g)
      if (matches) for (const x of matches) set.add(x.slice(1))
    }
    return [...set]
  })
  const [input, setInput] = createSignal("")
  const [sending, setSending] = createSignal(false)
  // 本次任务累计接收到的字符数（每次 send 重置为 0）
  const [receivedChars, setReceivedChars] = createSignal(0)

  let chatEndRef: HTMLDivElement | undefined
  let chatTimelineRef: HTMLDivElement | undefined
  /** 贴底滚动跟踪：用户手动往上翻时暂停 auto-scroll；回到底部重新启用 */
  let stickToBottom = true
  const STICK_THRESHOLD_PX = 80
  /** 判断当前是否离底部 < THRESHOLD（允许继续 auto-scroll） */
  function isNearBottom(el: HTMLElement): boolean {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < STICK_THRESHOLD_PX
  }
  /**
   * 尝试滚到底。仅当 stickToBottom=true 时才执行。
   * 用户手动往上翻后，新消息不会打断他们阅读。
   */
  function maybeScrollToBottom() {
    if (!stickToBottom) return
    requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: 'smooth' }))
  }
  let textareaRef: HTMLTextAreaElement | undefined
  let unsubscribe: (() => void) | null = null
  let msgId = 0

  // 消息分页状态
  const [msgHasMore, setMsgHasMore] = createSignal(false)
  const [msgLoadingMore, setMsgLoadingMore] = createSignal(false)
  // 当前会话最早一条消息的 createdAt（用作 before 游标）
  const [msgOldestTs, setMsgOldestTs] = createSignal<number | undefined>(undefined)

  // ── Slash 命令列表 ─────────────────────────────────────────────────────────
  const SLASH_COMMANDS = [
    { name: "clear",    label: "清空会话",    desc: "清空当前对话所有消息",       icon: "🗑️" },
    { name: "new",      label: "新建会话",    desc: "创建一个新的会话",            icon: "✏️" },
    { name: "compact",  label: "压缩上下文",  desc: "手动压缩对话历史释放 token", icon: "🗜" },
    { name: "plan",     label: "计划模式",    desc: "切换到只规划不执行的模式",    icon: "📋" },
    { name: "fork",     label: "分叉会话",    desc: "复制当前会话到新分支",        icon: "🔀" },
    { name: "terminal", label: "打开终端",    desc: "打开集成终端 (⌘`)",          icon: "⚡" },
    { name: "files",    label: "查看变更",    desc: "显示本次会话修改的文件",      icon: "📁" },
    { name: "export",   label: "导出会话",    desc: "将对话历史导出为 Markdown",   icon: "💾" },
    { name: "help",     label: "帮助",        desc: "显示可用命令列表",            icon: "❓" },
  ] as const

  // 接收计数器：用普通变量 + DOM ref 直接写，绕过 SolidJS batching，保证每次事件立即更新
  let _recvCount = 0
  let _lastEventAt = 0   // 最近收到任意 SSE 事件的时间戳（用于任务卡死兜底）
  let recvTextRef: HTMLSpanElement | undefined
  let recvDotRef:  HTMLSpanElement | undefined

  function _bumpRecv(n: number) {
    _recvCount += n
    _lastEventAt = Date.now()
    if (recvTextRef) recvTextRef.textContent = `已接收 ${formatRecv(_recvCount)}`
    // 第一次有数据时亮蓝点
    if (_recvCount > 0 && recvDotRef) recvDotRef.classList.add('recv-dot-active')
  }

  function _resetRecv() {
    _recvCount = 0
    _lastEventAt = Date.now()
    setReceivedChars(0)  // 用于 <Show> show/hide 逻辑
    if (recvTextRef) recvTextRef.textContent = '等待响应…'
    if (recvDotRef) recvDotRef.classList.remove('recv-dot-active')
  }

  // ─── 平台检测：给 body 加 class，让 CSS 能区分 macOS / Windows / Linux ──
  // macOS 用 titleBarStyle:Overlay + 我们自己的标题栏（替代原生）
  // Windows / Linux 用系统原生标题栏（隐藏我们自定义的那条，避免双标题栏）
  onMount(() => {
    const ua = navigator.userAgent.toLowerCase()
    let platformKey: 'mac' | 'win' | 'linux' | 'other' = 'other'
    if (ua.includes('mac')) platformKey = 'mac'
    else if (ua.includes('win')) platformKey = 'win'
    else if (ua.includes('linux')) platformKey = 'linux'
    document.body.classList.add(`platform-${platformKey}`)
  })

  // ─── 任务卡死兜底检测 ──────────────────────────────────────────────────
  // 若 sending=true 但 60 秒内没收到任何 SSE 事件，主动从服务端查一次消息快照
  //（大概率 SSE 被中间层 idle-kill 了），把 UI 补齐到最新状态。
  onMount(() => {
    const check = async () => {
      if (!sending()) return
      const idle = Date.now() - _lastEventAt
      if (idle < 60000) return
      // 已经静默 > 60s，可能 SSE 断了没重连成功
      const sid = activeSessionId()
      if (!sid) return
      try {
        const c = await getClient()
        const data = await c.getSessionMessages(sid, { limit: 200 })
        if (Array.isArray(data?.messages) && data.messages.length > 0) {
          setMessages(data.messages.map(storedToChatMessage))
          // 如果最后一条已经是 assistant / error / tool 完整结果 → 判定任务已结束
          const last = data.messages[data.messages.length - 1] as any
          if (last && (last.role === 'assistant' || last.role === 'error')) {
            setSending(false)
            showToast({ message: '检测到事件流静默，已从服务器补齐消息', kind: 'info', duration: 3000 })
          }
        }
      } catch (e) {
        console.warn('[watchdog] 状态同步失败:', e)
      }
      _lastEventAt = Date.now()   // 避免短时间内连续触发
    }
    const timer = setInterval(check, 10000)
    onCleanup(() => clearInterval(timer))
  })

  // Apply theme + font on change
  createEffect(() => applyTheme(theme()))
  createEffect(() => applyFont(fontFamily(), fontSize()))

  // ── 语言状态（用于触发重新渲染） ──────────────────────────────────────────
  const [locale, setLocaleSignal] = createSignal(getLocale())

  function switchLocale(l: 'zh-CN' | 'en') {
    setLocale(l)
    setLocaleSignal(l)
  }

  onMount(() => {
    initI18n()
    setLocaleSignal(getLocale())
    applyTheme(loadTheme())
    applyFont(loadFontFamily(), loadFontSize())
    const saved = loadSavedCredentials()
    if (saved) {
      setCurrentUser(saved.userInfo)
      setLoginApiUrl(saved.apiUrl)
      setLoginUsername(saved.username)
      void bootWithCredentials(saved)
    }
  })
  onCleanup(() => unsubscribe?.())

  function setTheme(t: Theme) {
    setThemeSignal(t)
    applyTheme(t)
  }
  function setFontFamily(v: string) {
    setFontFamilySignal(v)
    localStorage.setItem(FONT_FAMILY_KEY, v)
    applyFont(v, fontSize())
  }
  function setFontSize(v: number) {
    setFontSizeSignal(v)
    localStorage.setItem(FONT_SIZE_KEY, String(v))
    applyFont(fontFamily(), v)
  }

  // ─── Grouped sessions memo ─────────────────────────────────────────────────
  // 是否显示归档
  const [showArchived, setShowArchived] = createSignal(false)

  const groupedSessions = createMemo(() => {
    const groups: Array<{ workspace: Workspace | null; workspacePath: string; sessions: SessionSummary[] }> = []
    const groupMap = new Map<string, SessionSummary[]>()

    const currentUiMode = globalMode()
    const q = sessionSearch().trim().toLowerCase()
    const filteredSessions = sessions().filter(s => {
      if ((s.uiMode ?? 'code') !== currentUiMode) return false
      if (!showArchived() && s.archived) return false   // 默认不显示归档
      if (showArchived() && !s.archived) return false   // 归档视图只显示归档
      if (!q) return true
      return (s.title ?? '').toLowerCase().includes(q)
    })

    for (const s of filteredSessions) {
      const path = s.workspacePath ?? ""
      if (!groupMap.has(path)) groupMap.set(path, [])
      groupMap.get(path)!.push(s)
    }

    // Known workspaces first
    for (const ws of workspaces()) {
      const sList = groupMap.get(ws.path) ?? []
      groups.push({ workspace: ws, workspacePath: ws.path, sessions: sList })
      groupMap.delete(ws.path)
    }

    // Unknown workspace paths (orphaned sessions)
    groupMap.forEach((sList, path) => {
      if (sList.length > 0) {
        groups.push({ workspace: null, workspacePath: path, sessions: sList })
      }
    })

    return groups
  })

  // ─── 切换 globalMode 时自动切换会话 ───────────────────────────────────────
  createEffect(() => {
    const mode = globalMode()
    const current = sessions().find(s => s.id === activeSessionId())
    // 当前会话属于另一个模式，需要切换
    if (current && (current.uiMode ?? 'code') !== mode) {
      const matching = sessions().filter(s => (s.uiMode ?? 'code') === mode)
      if (matching.length > 0) {
        selectSession(matching[0].id)
      } else {
        setActiveSessionId(null)
        setMessages([])
        setSending(false)
      }
    }
  })

  // ─── View groups（将连续 tool 消息合并为批次） ──────────────────────────────
  type ViewGroup =
    | { kind: 'msg';        data:  ChatMessage }
    | { kind: 'tool-batch'; id:    string;  tools: ChatMessage[] }

  // ── 包装缓存：避免每次 setMessages 都生成全新的 ViewGroup 对象
  //   （旧实现会让 <For> 把所有行 DOM 重建，导致 reasoning-body 滚动被重置）
  // 如果底层 msg 引用未变 / tool 批次引用未变，wrapper 就复用，<For> 就能跳过这一行。
  const msgWrapCache  = new Map<string, { vg: ViewGroup; data: ChatMessage }>()
  const toolWrapCache = new Map<string, { vg: ViewGroup; toolsSig: string; flt: string }>()

  const viewGroupsAll = createMemo((): ViewGroup[] => {
    const groups: ViewGroup[] = []
    const msgs = messages()
    const flt = msgFilter()
    const fltSig = `${flt.hideTodos}|${flt.hideReasoning}|${flt.hideInternalTools}`
    const aliveMsgIds  = new Set<string>()
    const aliveToolIds = new Set<string>()
    let i = 0
    while (i < msgs.length) {
      const m = msgs[i]
      if (m.role === 'tool') {
        const batchId = m.id
        const tools: ChatMessage[] = []
        while (i < msgs.length && msgs[i].role === 'tool') {
          tools.push(msgs[i])
          i++
        }
        // 过滤：hideTodos 隐藏 todo_write；hideInternalTools 隐藏所有内部工具
        const filteredTools = tools.filter(t => {
          const name = (t.toolName ?? '').toLowerCase()
          if (flt.hideTodos && (name === 'todo_write' || name === 'update_todo_list')) return false
          if (flt.hideInternalTools && INTERNAL_TOOL_NAMES.has(name)) return false
          return true
        })
        if (filteredTools.length > 0) {
          // 生成"tools 指纹"：用每个 tool 的 id+版本（isPartial/toolResult/liveOutput.length）拼接
          // 任一 tool 的关键状态变化则指纹变化 → 重建 wrapper
          const toolsSig = filteredTools.map(t =>
            `${t.id}:${t.isPartial ? 'p' : 'd'}:${(t.toolResult ?? '').length}:${(t.liveOutput ?? '').length}`
          ).join(',')
          aliveToolIds.add(batchId)
          const cached = toolWrapCache.get(batchId)
          if (cached && cached.toolsSig === toolsSig && cached.flt === fltSig) {
            groups.push(cached.vg)
          } else {
            const vg: ViewGroup = { kind: 'tool-batch', id: batchId, tools: filteredTools }
            toolWrapCache.set(batchId, { vg, toolsSig, flt: fltSig })
            groups.push(vg)
          }
        }
      } else {
        // hideReasoning: 隐藏 reasoning 角色
        if (flt.hideReasoning && m.role === 'reasoning') { i++; continue }
        aliveMsgIds.add(m.id)
        const cached = msgWrapCache.get(m.id)
        if (cached && cached.data === m) {
          // msg 引用未变 → 复用 wrapper（<For> 会跳过此行，DOM 不重建）
          groups.push(cached.vg)
        } else {
          const vg: ViewGroup = { kind: 'msg', data: m }
          msgWrapCache.set(m.id, { vg, data: m })
          groups.push(vg)
        }
        i++
      }
    }
    // GC：清理已经不在列表中的 id（防止切换会话后内存泄漏）
    for (const id of Array.from(msgWrapCache.keys())) {
      if (!aliveMsgIds.has(id)) msgWrapCache.delete(id)
    }
    for (const id of Array.from(toolWrapCache.keys())) {
      if (!aliveToolIds.has(id)) toolWrapCache.delete(id)
    }
    return groups
  })
  // P1-6: 虚拟化兜底：超过阈值时只渲染最近 N 条，顶部提供"展开全部"
  const VG_INLINE_LIMIT = 600
  const [vgExpandAll, setVgExpandAll] = createSignal(false)
  const viewGroups = createMemo((): ViewGroup[] => {
    const all = viewGroupsAll()
    if (vgExpandAll()) return all
    if (all.length <= VG_INLINE_LIMIT) return all
    return all.slice(all.length - VG_INLINE_LIMIT)
  })
  const vgTruncatedCount = createMemo(() => {
    if (vgExpandAll()) return 0
    const n = viewGroupsAll().length
    return n > VG_INLINE_LIMIT ? n - VG_INLINE_LIMIT : 0
  })

  // ─── Login ────────────────────────────────────────────────────────────────
  async function handleLogin() {
    const apiUrl = loginApiUrl().trim()
    const username = loginUsername().trim()
    const password = loginPassword()
    if (!apiUrl || !username || !password) { setLoginError("请填写所有字段"); return }
    setLoginLoading(true); setLoginError("")
    try {
      const userInfo = await loginCheck(apiUrl, username, password)
      const creds: SavedCredentials = { apiUrl, username, password, userInfo, rememberMe: loginRemember() }
      if (loginRemember()) saveCredentials(creds)
      setCurrentUser(userInfo)
      await bootWithCredentials(creds)
    } catch (e: any) {
      // 暴露真实错误原因（而不是固定的"登录失败"fallback），便于用户自查
      const raw = e?.message ?? String(e ?? '')
      let msg = raw || "登录失败，请重试"
      // 识别常见 Tauri plugin-http 权限拒绝的错误特征
      if (/not allowed|scope|permission|http\.fetch/i.test(raw)) {
        msg = `服务器地址未被放行：${apiUrl}\n原始错误：${raw}`
      } else if (/network|fetch|failed to fetch|unable to connect|ENETUNREACH|ECONNREFUSED/i.test(raw)) {
        msg = `无法连接到 ${apiUrl}\n原始错误：${raw}`
      }
      setLoginError(msg)
      console.error('[login] failed:', e)
    } finally {
      setLoginLoading(false)
    }
  }

  async function bootWithCredentials(creds: SavedCredentials) {
    setAppStatus("booting"); setBootError("")
    try {
      await waitForServer()
      await configureServerAi(creds.apiUrl, creds.username, creds.password)
      await refreshWorkspaces()
      await refreshSessions()
      setAppStatus("ready")
      // 启动后静默检查更新（后台，不影响 UI）
      void checkForUpdatesSilent()
    } catch (e: any) {
      setBootError(String(e?.message || e))
      setAppStatus("error")
    }
  }

  /** 静默更新检查：有新版本时显示 toast 提示 */
  const [updateAvailable, setUpdateAvailable] = createSignal(false)
  const [updateVersion, setUpdateVersion] = createSignal("")

  async function checkForUpdatesSilent() {
    try {
      if (!(window as any).__TAURI_INTERNALS__) return
      const { check } = await import('@tauri-apps/plugin-updater' as any)
      const update = await check()
      if (update?.available) {
        setUpdateAvailable(true)
        setUpdateVersion(update.version ?? '')
      }
    } catch { /* 忽略更新检查错误 */ }
  }

  async function installUpdateFromToast() {
    setUpdateAvailable(false)
    try {
      const { check } = await import('@tauri-apps/plugin-updater' as any)
      const update = await check()
      if (update?.available) {
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process' as any)
        await relaunch()
      }
    } catch (e) { alert("更新失败：" + (e as Error).message) }
  }

  async function handleLogout() {
    clearCredentials()
    try { await clearServerAi() } catch { /**/ }
    unsubscribe?.(); unsubscribe = null
    setCurrentUser(null); setActiveSessionId(null)
    setMessages([]); setSessions([]); setWorkspaces([])
    setLoginPassword(""); setLoginError("")
    setShowSettings(false); setUserExpanded(false)
    setAppStatus("login")
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────
  async function refreshWorkspaces() {
    const c = await getClient()
    const r = await c.listWorkspaces()
    setWorkspaces(r.workspaces)
    if (!activeWorkspace() && r.workspaces.length > 0) setActiveWorkspace(r.workspaces[0])
  }

  async function pickFolder() {
    try {
      const dialog = await import("@tauri-apps/plugin-dialog")
      const path = await dialog.open({ directory: true, multiple: false })
      if (!path || typeof path !== "string") return
      const c = await getClient()
      const ws = await c.addWorkspace(path)
      await refreshWorkspaces()
      setActiveWorkspace(ws)
    } catch (e) { alert("添加工作区失败：" + (e as Error).message) }
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────
  async function refreshSessions() {
    const c = await getClient()
    const r = await c.listSessions()
    setSessions(r.sessions.sort((a, b) => b.updatedAt - a.updatedAt))
  }

  async function createSession() {
    const c = await getClient()

    // Chat 模式：无需关联工作区，直接创建
    if (globalMode() === 'chat') {
      const s = await c.createSession({
        title: `对话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
        workspacePath: '',
        mode: 'ask',
        uiMode: 'chat',
      })
      await refreshSessions()
      await selectSession(s.id)
      return
    }

    // Code 模式：需要工作区
    let ws = activeWorkspace()
    if (!ws) {
      const all = workspaces()
      if (all.length === 0) { alert("请先点击右上角文件夹图标添加工作区"); return }
      ws = all[0]
      setActiveWorkspace(ws)
    }
    const s = await c.createSession({
      title: `会话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      workspacePath: ws.path,
      mode: composerMode(),
      uiMode: 'code',
    })
    await refreshSessions()
    await selectSession(s.id)
  }

  async function selectSession(id: string) {
    // ── 保存当前会话的终端状态快照 ──
    const outgoingId = activeSessionId()
    if (outgoingId) {
      sessionTerminalSnapshots.set(outgoingId, {
        show: showTerminal(),
        collapsed: terminalCollapsed(),
        height: terminalHeight(),
        activeTermId: activeTermId(),
        // tabs 不保存：tab 通过 sessionId 字段永久留在 terminalTabs 中
      })
    }

    setActiveSessionId(id); setMessages([])
    setChangedFiles(new Map())
    setTokenUsed(0)
    setApprovalRequest(null)
    setSending(false)   // 切换会话时重置发送状态，防止 '等待响应…' 残留
    _resetRecv()
    setMsgHasMore(false)
    setMsgOldestTs(undefined)
    setTodos([])
    setFollowupSuggestions([])
    setFollowupQueue([])
    setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
    setFocusedMsgIdx(-1)
    setQuestionRequest(null)
    setPlanExitRequest(null)
    setCompactingState(null)
    unsubscribe?.()

    // ── 恢复目标会话的终端状态 ──
    // terminalTabs 不清空也不恢复 —— 所有 tab 的 DOM 容器始终存在，
    // TerminalPanel 通过 sessionId 过滤来显示当前会话的 tab。
    const snap = sessionTerminalSnapshots.get(id)
    if (snap) {
      setShowTerminal(snap.show)
      setTerminalCollapsed(snap.collapsed)
      setTerminalHeight(snap.height)
      setActiveTermId(snap.activeTermId)
    } else {
      // 新会话默认不显示终端面板
      setShowTerminal(false)
      // activeTermId 不重置：新会话切换时找不到 sessionId 匹配的 tab 即可
    }

    // 同步 activeWorkspace 到会话所属工作区，确保 @ 文件提及显示正确项目文件
    const sess = sessions().find(s => s.id === id)
    if (sess?.workspacePath) {
      const matchWs = workspaces().find(w => w.path === sess.workspacePath)
      if (matchWs) setActiveWorkspace(matchWs)
    }
    // 若该会话在后台仍在运行，显示"生成中"状态（subscribeEvents 下文会重新连接）
    if (sess?.status === 'running') {
      setSending(true)
      _bumpRecv(1)  // 让接收指示器亮起
    }
    const c = await getClient()

    // Load persisted messages from server（最近 50 条，滚到底部）
    try {
      const { messages: stored, hasMore } = await c.getSessionMessages(id, { limit: 50 })
      if (stored.length > 0) {
        setMessages(stored.map(storedToChatMessage))
        setMsgHasMore(hasMore)
        setMsgOldestTs(stored[0].createdAt)
      }
      // 切换会话：视为"刚进来想看最新"，重置贴底状态 + 直接滚底（不走 maybe）
      stickToBottom = true
      requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: "instant" }))
    } catch (e) {
      console.warn("[maxian] failed to load session messages:", e)
    }

    unsubscribe = c.subscribeEvents(id, handleEvent, (err) => console.error("[SSE]", err))
    setShowSettings(false)
    setUserExpanded(false)
  }

  // 向上滚动时加载更早的消息
  async function loadMoreMessages() {
    const sid = activeSessionId()
    const oldestTs = msgOldestTs()
    if (!sid || !msgHasMore() || msgLoadingMore() || oldestTs === undefined) return
    setMsgLoadingMore(true)
    try {
      const c = await getClient()
      const { messages: older, hasMore } = await c.getSessionMessages(sid, { limit: 50, before: oldestTs })
      if (older.length > 0) {
        // 记录当前滚动高度，加载后维持滚动位置
        const el = chatTimelineRef
        const prevScrollHeight = el?.scrollHeight ?? 0
        setMessages(prev => [
          ...older.map(storedToChatMessage),
          ...prev,
        ])
        setMsgOldestTs(older[0].createdAt)
        setMsgHasMore(hasMore)
        // 保持视口位置（新消息插入顶部后不跳动）
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevScrollHeight
        })
      } else {
        setMsgHasMore(false)
      }
    } catch (e) {
      console.warn("[maxian] loadMoreMessages failed:", e)
    } finally {
      setMsgLoadingMore(false)
    }
  }

  async function deleteSession(e: MouseEvent, id: string) {
    e.stopPropagation()
    if (!await appConfirm("确定要删除这个会话？")) return
    const c = await getClient()
    await c.deleteSession(id)
    if (activeSessionId() === id) {
      setActiveSessionId(null); unsubscribe?.(); unsubscribe = null; setMessages([])
    }
    await refreshSessions()
  }

  async function togglePinSession(id: string, pinned: boolean) {
    try {
      const c = await getClient()
      await c.setSessionPinned(id, pinned)
      await refreshSessions()
    } catch (e) {
      showToast({ message: '置顶失败：' + (e as Error).message, kind: 'error' })
    }
  }

  async function toggleArchiveSession(id: string, archived: boolean) {
    try {
      const c = await getClient()
      await c.setSessionArchived(id, archived)
      if (archived && activeSessionId() === id) {
        // 若归档了当前会话则关闭
        setActiveSessionId(null); unsubscribe?.(); unsubscribe = null; setMessages([])
      }
      await refreshSessions()
      showToast({ message: archived ? '已归档' : '已取消归档', kind: 'success', duration: 2000 })
    } catch (e) {
      showToast({ message: '操作失败：' + (e as Error).message, kind: 'error' })
    }
  }

  // ── 消息操作（删除 / 编辑 / 重生成 / fork-from-here）────────────────────
  async function deleteMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    if (!await appConfirm('删除这条消息？')) return
    try {
      const c = await getClient()
      await c.deleteMessage(sid, msgId)
      setMessages(prev => prev.filter(m => m.id !== msgId))
      showToast({ message: '已删除', kind: 'success', duration: 1500 })
    } catch (e) {
      showToast({ message: '删除失败：' + (e as Error).message, kind: 'error' })
    }
  }

  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = createSignal('')
  async function commitEditMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    const newContent = editingMessageContent()
    setEditingMessageId(null)
    try {
      const c = await getClient()
      const r = await c.editUserMessage(sid, msgId, newContent)
      if (!r.ok) throw new Error(r.error ?? '编辑失败')
      // 重新加载 + 自动用新内容重跑一次 AI
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      // 发送一条空触发以让 agent 继续（实际上后端会用新的 history）
      setInput('')
      setSending(true)
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE]", err))
      await c.sendMessage(sid, { content: newContent })
    } catch (e) {
      showToast({ message: '编辑失败：' + (e as Error).message, kind: 'error' })
      setSending(false)
    }
  }

  async function regenerateMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    try {
      const c = await getClient()
      const r = await c.regenerateFromMessage(sid, msgId)
      if (!r.ok || !r.promptUserId) throw new Error('无法定位触发用户消息')
      // 重新加载 messages
      const data = await c.getSessionMessages(sid, { limit: 50 })
      setMessages(data.messages.map(storedToChatMessage))
      // 取保留的最后一条 user 消息内容再发一次
      const promptMsg = data.messages.find(m => m.id === r.promptUserId)
      if (!promptMsg) throw new Error('找不到触发消息')
      setSending(true)
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE]", err))
      await c.sendMessage(sid, { content: promptMsg.content })
    } catch (e) {
      showToast({ message: '重生成失败：' + (e as Error).message, kind: 'error' })
      setSending(false)
    }
  }

  async function forkFromMessage(msgId: string) {
    const sid = activeSessionId()
    if (!sid) return
    try {
      const c = await getClient()
      const r = await c.forkFromMessage(sid, msgId)
      if (!r.ok || !r.newSessionId) throw new Error('Fork 失败')
      await refreshSessions()
      await selectSession(r.newSessionId)
      showToast({ message: '已分叉到新会话', kind: 'success' })
    } catch (e) {
      showToast({ message: 'Fork 失败：' + (e as Error).message, kind: 'error' })
    }
  }

  async function deleteWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    if (!await appConfirm(`确定要移除项目「${ws.name}」？\n（仅移除项目记录，不会删除磁盘文件）`)) return
    const c = await getClient()
    await c.removeWorkspace(ws.id)
    if (activeWorkspace()?.id === ws.id) setActiveWorkspace(null)
    await refreshWorkspaces()
    await refreshSessions()
  }

  // ─── Rename ────────────────────────────────────────────────────────────────
  function startRenameWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    setEditingWorkspaceId(ws.id)
    setEditingWorkspaceName(ws.name)
  }
  async function commitRenameWorkspace(id: string) {
    const name = editingWorkspaceName().trim()
    setEditingWorkspaceId(null)
    if (!name) return
    try {
      const c = await getClient()
      await c.renameWorkspace(id, name)
      await refreshWorkspaces()
    } catch (e) { alert("重命名失败：" + (e as Error).message) }
  }
  function cancelRenameWorkspace() { setEditingWorkspaceId(null) }

  function startRenameSession(e: MouseEvent, s: SessionSummary) {
    e.stopPropagation()
    setEditingSessionId(s.id)
    setEditingSessionTitle(s.title)
  }
  async function commitRenameSession(id: string) {
    const title = editingSessionTitle().trim()
    setEditingSessionId(null)
    if (!title) return
    try {
      const c = await getClient()
      await c.renameSession(id, title)
      await refreshSessions()
    } catch (e) { alert("重命名失败：" + (e as Error).message) }
  }
  function cancelRenameSession() { setEditingSessionId(null) }

  // Create session in a specific workspace
  async function createSessionInWorkspace(e: MouseEvent, ws: Workspace) {
    e.stopPropagation()
    setActiveWorkspace(ws)
    const c = await getClient()
    const s = await c.createSession({
      title: `会话 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      workspacePath: ws.path,
      mode: globalMode() === 'chat' ? 'ask' : composerMode(),
      uiMode: globalMode(),
    })
    await refreshSessions()
    await selectSession(s.id)
  }

  // ─── SSE ──────────────────────────────────────────────────────────────────
  // 任务取消时间戳：cancel 触发后，后续残留的 reasoning_delta / assistant_message
  // / tool_input_delta 事件全部忽略，避免 UI 持续显示"已停止任务"的输出
  let _abortedAt = 0

  function handleEvent(e: MaxianEvent) {
    const type = e.type as string

    // task_aborted = 后端强制中止信号，立刻进入"忽略后续流"模式
    if (type === "task_aborted") {
      _abortedAt = Date.now()
      console.log('[handleEvent] 收到 task_aborted，后续 200ms 内的流式事件全部忽略')
      // 收尾所有 isPartial 消息
      setMessages((prev) => prev.map(m => {
        if (!m.isPartial) return m
        if (m.role === 'tool') {
          return { ...m, isPartial: false, toolSuccess: false, toolResult: m.toolResult || '[任务已中止]' }
        }
        if (m.role === 'reasoning') return { ...m, isPartial: false, charCount: m.content.length }
        return { ...m, isPartial: false }
      }))
      setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
      setSending(false)
      return
    }

    // 流式事件白名单：abort 后 1.5 秒内丢弃这些（兜底防 SSE buffer 残留）
    const STREAM_EVENTS = new Set([
      'reasoning_delta', 'assistant_message', 'tool_input_delta', 'tool_call_start',
      'tool_call_result', 'tool_output_chunk', 'todos_updated',
    ])
    if (_abortedAt > 0 && STREAM_EVENTS.has(type) && (Date.now() - _abortedAt) < 1500) {
      return  // 静默丢弃
    }

    // 文件变更事件
    if (type === "file_changed") {
      const filePath = (e as any).path as string
      const action   = (e as any).action as FileChangeEntry['action']
      setChangedFiles(prev => {
        const next = new Map(prev)
        next.set(filePath, { path: filePath, action })
        return next
      })
      return
    }
    // Token 用量事件
    if (type === "token_usage") {
      const used  = (e as any).used  as number
      const limit = (e as any).limit as number | undefined
      setTokenUsed(used)
      // 后端上报的 limit 作为真实上下文窗口大小（覆盖前端默认 128K）
      if (typeof limit === 'number' && limit > 0 && limit !== tokenLimit()) {
        setTokenLimit(limit)
      }
      return
    }
    // Todos 更新事件（AI 调用 todo_write 工具时触发）
    if (type === "todos_updated") {
      const list = (e as any).todos as TodoItem[]
      setTodos(Array.isArray(list) ? list : [])
      return
    }
    // Followup 建议
    if (type === "followup_suggestions") {
      const list = (e as any).suggestions as string[]
      setFollowupSuggestions(Array.isArray(list) ? list : [])
      return
    }
    // Rate-limit 事件
    if (type === "rate_limit") {
      const resetAt = Number((e as any).resetAt) || (Date.now() + 30000)
      const attempt = Number((e as any).attempt) || 1
      const message = String((e as any).message ?? '触发限流，正在等待重试…')
      setRateLimit({ active: true, resetAt, attempt, message })
      return
    }
    if (type === "rate_limit_cleared") {
      setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
      return
    }
    // Agent 提问
    if (type === "question_request") {
      setQuestionAnswer('')
      setQuestionSelected([])
      setQuestionRequest({
        sessionId: (e as any).sessionId as string,
        question:  (e as any).question as string,
        options:   ((e as any).options as string[]) ?? [],
        multi:     ((e as any).multi as boolean) ?? false,
      })
      return
    }
    // Plan Exit 请求
    if (type === "plan_exit_request") {
      setPlanExitFeedback('')
      setPlanExitRequest({
        sessionId: (e as any).sessionId as string,
        summary:   (e as any).summary as string,
        steps:     ((e as any).steps as string) ?? '',
      })
      return
    }
    // 上下文压缩开始
    if (type === "context_compacting") {
      setCompactingState({
        tokensCurrent: (e as any).tokensCurrent as number,
        willLevel2:    !!(e as any).willLevel2,
        manual:        !!(e as any).manual,
        startedAt:     Date.now(),
      })
      return
    }
    // 上下文压缩完成
    if (type === "context_compacted") {
      const level  = (e as any).level  as number
      const before = (e as any).tokensBefore as number
      const after  = (e as any).tokensAfter  as number
      const pruned = (e as any).prunedTools as number
      const summd  = (e as any).summarizedMsgs as number
      const manual = (e as any).manual as boolean
      const error  = (e as any).error  as string | undefined
      const compactStart = compactingState()?.startedAt
      const elapsed = compactStart ? ((Date.now() - compactStart) / 1000).toFixed(1) : null
      setCompactingState(null)

      if (error) {
        setMessages(prev => [...prev, {
          id: String(++msgId),
          role: 'error',
          createdAt: Date.now(),
          content: `🗜 上下文压缩失败：${error}`,
        }])
        showToast({ message: `压缩失败：${error}`, kind: 'error', duration: 5000 })
        return
      }

      if (level === 0) {
        // 压缩实际未运行（比如 token 未达阈值、剪枝没够效果）
        setMessages(prev => [...prev, {
          id: String(++msgId),
          role: 'system',
          createdAt: Date.now(),
          content: `🗜 上下文压缩：未触发（当前 ${before.toLocaleString()} tokens 未达阈值）${elapsed ? ` · ${elapsed}s` : ''}`,
        }])
        return
      }

      const levelLabel = level === 2 ? 'LLM 总结' : '按类型剪枝'
      const saved = before - after
      const savedPct = before > 0 ? Math.round(saved / before * 100) : 0
      const detail = [
        `${before.toLocaleString()} → ${after.toLocaleString()} tokens`,
        saved > 0 ? `节省 ${saved.toLocaleString()} (${savedPct}%)` : null,
        pruned > 0 ? `剪 ${pruned} 工具结果` : null,
        summd > 0 ? `总结 ${summd} 条` : null,
        elapsed ? `${elapsed}s` : null,
      ].filter(Boolean).join(' · ')
      setMessages(prev => [...prev, {
        id: String(++msgId),
        role: 'system',
        createdAt: Date.now(),
        content: `🗜 ${manual ? '手动' : '自动'}上下文压缩完成（${levelLabel}）：${detail}`,
      }])
      showToast({
        message: `压缩完成：${before.toLocaleString()} → ${after.toLocaleString()} tokens${elapsed ? ` · ${elapsed}s` : ''}`,
        kind: 'success',
        duration: 4000,
      })
      return
    }
    // 流式 tool input 增量（实时显示工具参数生成进度）
    if (type === "tool_input_delta") {
      const toolUseId  = (e as any).toolUseId  as string
      const inputDelta = (e as any).inputDelta as string
      const toolName   = (e as any).toolName   as string
      if (inputDelta) _bumpRecv(inputDelta.length)  // 让接收计数器继续动
      // 把增量追加到对应的 tool 消息的 content（它是 streaming 预览文本）
      setMessages((prev) => {
        // 找到最近的 streaming tool 消息
        const idx = [...prev].reverse().findIndex(
          m => m.role === "tool" && m.toolUseId === toolUseId && m.isPartial
        )
        if (idx === -1) {
          // 没找到占位消息：创建一个（极端情况下 SSE 事件乱序）
          return [...prev, {
            id: String(++msgId), role: "tool" as const,
            content: inputDelta,
            toolName, toolUseId, isPartial: true,
            toolParams: { __streaming: true },
            createdAt: Date.now(),
          }]
        }
        const realIdx = prev.length - 1 - idx
        const t = prev[realIdx]
        return [
          ...prev.slice(0, realIdx),
          { ...t, content: (t.content ?? '') + inputDelta },
          ...prev.slice(realIdx + 1),
        ]
      })
      return
    }
    // 工具流式输出（bash 的 stdout/stderr 实时增量）
    if (type === "tool_output_chunk") {
      const toolUseId = (e as any).toolUseId as string
      const chunk     = (e as any).chunk     as string
      const kind      = ((e as any).kind     as 'stdout' | 'stderr') ?? 'stdout'
      if (!toolUseId || !chunk) return
      // 追加到对应工具消息的 liveOutput 字段（供工具卡片实时显示）
      setMessages((prev) => {
        const idx = [...prev].reverse().findIndex(m => m.role === 'tool' && m.toolUseId === toolUseId)
        if (idx === -1) return prev
        const realIdx = prev.length - 1 - idx
        const t = prev[realIdx] as any
        const prevLive = t.liveOutput ?? ''
        // 每一块以换行结尾，stderr 前加标记（供 UI 着色）
        const marker = kind === 'stderr' ? '⚠ ' : ''
        return [
          ...prev.slice(0, realIdx),
          { ...t, liveOutput: prevLive + marker + chunk },
          ...prev.slice(realIdx + 1),
        ]
      })
      return
    }
    // 工具审批请求事件
    if (type === "tool_approval_request") {
      const sid = (e as any).sessionId as string
      const toolUseId = (e as any).toolUseId as string
      const toolName  = (e as any).toolName  as string
      const toolParams = (e as any).toolParams as Record<string, unknown>
      // 自动审批：已记忆的工具跳过弹窗
      if (isAutoApproved(sid, toolName)) {
        void (async () => {
          try {
            const c = await getClient()
            await c.approveToolCall(sid, toolUseId, true)
          } catch (err) {
            console.error('[auto-approve] failed:', err)
          }
        })()
        return
      }
      setApprovalRequest({ sessionId: sid, toolUseId, toolName, toolParams })
      return
    }
    if (type === "reasoning_delta") {
      // 思考过程流式 delta
      const content = (e as any).content as string
      if (!content) return
      _bumpRecv(content.length)
      setMessages((prev) => {
        // 如果末尾已经有一条 isPartial 的 reasoning 消息，直接追加
        if (prev.length > 0 && prev[prev.length - 1].role === "reasoning" && prev[prev.length - 1].isPartial) {
          const last = prev[prev.length - 1]
          return [...prev.slice(0, -1), { ...last, content: last.content + content }]
        }
        // 否则新建一条
        return [...prev, { id: String(++msgId), role: "reasoning", content, isPartial: true, createdAt: Date.now() }]
      })
    } else if (type === "assistant_message") {
      const content = (e as any).content as string
      const isPartial = (e as any).isPartial as boolean
      if (content) _bumpRecv(content.length)
      setMessages((prev) => {
        let base = prev
        // 助手开始回复时，先结束当前流式 reasoning 块（思考阶段已结束）
        const lastMsg = base.length > 0 ? base[base.length - 1] : null
        if (lastMsg?.role === 'reasoning' && lastMsg.isPartial) {
          base = [...base.slice(0, -1), { ...lastMsg, isPartial: false, charCount: lastMsg.content.length }]
        }
        if (isPartial && base.length > 0 && base[base.length - 1].role === "assistant") {
          const last = base[base.length - 1]
          return [...base.slice(0, -1), { ...last, content: last.content + content, isPartial }]
        }
        return [...base, { id: String(++msgId), role: "assistant", content, isPartial, createdAt: Date.now() }]
      })
    } else if (type === "convert_reasoning_to_assistant") {
      // Agent 模式：最终迭代的文本以 reasoning_delta 流出，完成后转为普通助手消息
      setMessages((prev) => {
        if (prev.length === 0) return prev
        const last = prev[prev.length - 1]
        if (last.role === "reasoning") {
          // 将最后一条 reasoning 转为 assistant（保留内容，渲染切为 markdown）
          return [...prev.slice(0, -1), {
            ...last, role: "assistant" as const, isPartial: false,
          }]
        }
        return prev
      })
    } else if (type === "completion") {
      setMessages((prev) => prev.map(m => {
        // 完成所有残余 partial assistant
        if (m.role === "assistant" && m.isPartial) return { ...m, isPartial: false }
        // 完成所有残余 partial reasoning（中间迭代留下的）
        if (m.role === "reasoning" && m.isPartial) return { ...m, isPartial: false, charCount: m.content.length }
        return m
      }))
      setSending(false); void refreshSessions()
      // 系统通知：当文档不在前台时发送 OS 通知
      if (document.visibilityState !== 'visible') {
        void (async () => {
          try {
            if ((window as any).__TAURI_INTERNALS__) {
              const { sendNotification } = await import('@tauri-apps/plugin-notification' as any)
              await sendNotification({ title: '码弦 AI', body: 'AI 已完成任务' })
            } else if ('Notification' in window && (Notification as any).permission === 'granted') {
              new Notification('码弦 AI', { body: 'AI 已完成任务', icon: '/favicon.ico' })
            }
          } catch { /* 忽略通知失败 */ }
        })()
      }
      // 提示音（Web Audio API）
      try {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15)
        gain.gain.setValueAtTime(0.1, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3)
        osc.onended = () => ctx.close()
      } catch { /* 忽略音频失败 */ }
    } else if (type === "task_status") {
      const s = (e as any).status as string
      if (s === "processing") _bumpRecv(1)   // 后端开始处理，让蓝点亮起
      if (s === "completed" || s === "aborted" || s === "error") { setSending(false) }
    } else if (type === "tool_call_start") {
      _bumpRecv(1)
      const toolName   = (e as any).toolName   as string
      const toolUseId  = (e as any).toolUseId  as string
      const toolParams = (e as any).toolParams as Record<string, unknown> | undefined
      const streaming  = (e as any).streaming  as boolean | undefined
      setMessages((prev) => {
        // 如果是 streaming=false（工具参数完整到达），查找已有占位消息更新其 toolParams
        if (streaming === false) {
          const idx = [...prev].reverse().findIndex(m => m.role === "tool" && m.toolUseId === toolUseId)
          if (idx !== -1) {
            const realIdx = prev.length - 1 - idx
            return [
              ...prev.slice(0, realIdx),
              { ...prev[realIdx], toolParams, content: '' /* 清空 streaming 文本，正式结果在 toolResult 里 */ },
              ...prev.slice(realIdx + 1),
            ]
          }
        }
        // streaming=true（首次）或没找到占位：新建工具消息
        let base = prev
        if (prev.length > 0) {
          const last = prev[prev.length - 1]
          if (last.isPartial && (last.role === 'assistant' || last.role === 'reasoning')) {
            base = [...prev.slice(0, -1), {
              ...last,
              isPartial: false,
              ...(last.role === 'reasoning' ? { charCount: last.content.length } : {}),
            }]
          }
        }
        return [...base, {
          id: String(++msgId), role: "tool" as const, content: "",
          toolName, toolUseId, toolSuccess: undefined, isPartial: true, toolParams,
          createdAt: Date.now(),
        }]
      })
    } else if (type === "tool_call_result") {
      const toolUseId  = (e as any).toolUseId as string
      const success    = (e as any).success   as boolean
      const toolResult = (e as any).result    as string | undefined
      // 工具结果也算接收到的数据
      if (toolResult) _bumpRecv(toolResult.length)
      setMessages((prev) => {
        const idx = [...prev].reverse().findIndex(m => m.role === "tool" && m.toolUseId === toolUseId)
        if (idx === -1) return prev
        const realIdx = prev.length - 1 - idx
        return [
          ...prev.slice(0, realIdx),
          { ...prev[realIdx], isPartial: false, toolSuccess: success, toolResult },
          ...prev.slice(realIdx + 1),
        ]
      })
    } else if (type === "error") {
      const errMsg = (e as any).message ?? "未知错误"
      // 把所有 isPartial 的消息收尾（reasoning/tool/assistant），避免留下"执行中..."转圈
      setMessages((prev) => {
        const cleaned = prev.map(m => {
          if (!m.isPartial) return m
          if (m.role === 'tool') {
            return {
              ...m,
              isPartial: false,
              toolSuccess: false,
              toolResult: m.toolResult || '[任务已中断]',
            }
          }
          if (m.role === 'reasoning') {
            return { ...m, isPartial: false, charCount: m.content.length }
          }
          // assistant / 其他
          return { ...m, isPartial: false }
        })
        return [...cleaned, {
          id: String(++msgId),
          role: "error" as const,
          content: errMsg,
          createdAt: Date.now(),
        }]
      })
      pushError('agent', errMsg, (e as any).sessionId as string | undefined)
      // 清除限流提示、sending、followup 等残留状态
      setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
      setSending(false)
    }
    // 仅当用户在底部时才 auto-scroll（避免打断向上翻阅读）
    maybeScrollToBottom()
  }

  // ─── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    const sid = activeSessionId(); const content = input().trim()
    if (!sid || !content || sending()) return
    setSending(true)
    _resetRecv()  // 重置接收计数器 + 直接清空 DOM
    _abortedAt = 0  // 新任务开始，清掉上次取消的丢弃窗口
    const imgs = attachedImages()
    const displayContent = imgs.length > 0
      ? `${content}\n\n[附图 ${imgs.length} 张]`
      : content
    setMessages((prev) => [...prev, { id: String(++msgId), role: "user", content: displayContent, createdAt: Date.now() }])
    // 用户主动发消息 → 视为"想看响应"，重置贴底状态让后续 auto-scroll 生效
    stickToBottom = true
    requestAnimationFrame(() => chatEndRef?.scrollIntoView({ behavior: 'instant' }))
    pushPromptHistory(content)
    setInput("")
    setAttachedImages([])
    try {
      const c = await getClient()
      // 每次发送前重新建立 SSE 连接，避免 WKWebView 长时间运行后 XHR onprogress 停止触发
      unsubscribe?.()
      unsubscribe = c.subscribeEvents(sid, handleEvent, (err) => console.error("[SSE reconnect]", err))
      // 发送消息，附带 base64 图片（只取 base64 部分，去掉 data:...;base64, 前缀）
      const images = imgs.map(img => img.dataUrl.split(',')[1]).filter(Boolean)
      await c.sendMessage(sid, { content, images: images.length > 0 ? images : undefined })
      await refreshSessions()
    } catch (e) {
      setMessages((prev) => [...prev, { id: String(++msgId), role: "error", content: "发送失败：" + (e as Error).message, createdAt: Date.now() }])
      setSending(false)
    }
  }

  async function cancel() {
    const sid = activeSessionId(); if (!sid) return
    const c = await getClient(); await c.cancelTask(sid); setSending(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    // Vim 模式拦截（enabled 时）
    if (vimEnabled() && textareaRef) {
      if (handleVimKey(e, textareaRef)) return
    }

    // @ 提及导航
    if (showMention() && mentionFiles().length > 0) {
      if (e.key === "Escape") { e.preventDefault(); setShowMention(false); return }
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, mentionFiles().length - 1)); return }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const f = mentionFiles()[mentionIdx()]
        if (f) { insertMention(f); return }
      }
    }
    // Slash 命令面板导航
    if (showSlash()) {
      if (e.key === "Escape") { e.preventDefault(); setShowSlash(false); return }
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx(i => Math.min(i + 1, filteredSlash().length - 1)); return }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSlashIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const cmd = filteredSlash()[slashIdx()]
        if (cmd) { execSlashCommand(cmd.name); return }
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
    if (e.key === "Escape" && sending()) { e.preventDefault(); void cancel() }

    // Prompt 历史：光标位于首行且 textarea 为空或未修改时，↑/↓ 翻历史
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const ta = textareaRef
      if (!ta) return
      const atFirstLine = ta.selectionStart === 0 || !ta.value.slice(0, ta.selectionStart).includes('\n')
      const atLastLine  = ta.selectionEnd >= ta.value.length || !ta.value.slice(ta.selectionEnd).includes('\n')
      const hist = promptHistory()
      if (hist.length === 0) return

      if (e.key === "ArrowUp" && atFirstLine) {
        e.preventDefault()
        if (historyIdx() === -1) {
          // 保存当前草稿
          setHistoryDraft(input())
          setHistoryIdx(hist.length - 1)
          setInput(hist[hist.length - 1])
        } else if (historyIdx() > 0) {
          const next = historyIdx() - 1
          setHistoryIdx(next)
          setInput(hist[next])
        }
      } else if (e.key === "ArrowDown" && atLastLine) {
        if (historyIdx() === -1) return
        e.preventDefault()
        const next = historyIdx() + 1
        if (next >= hist.length) {
          setHistoryIdx(-1)
          setInput(historyDraft())
        } else {
          setHistoryIdx(next)
          setInput(hist[next])
        }
      }
    }
  }

  // 全局快捷键（支持用户自定义绑定）
  function onGlobalKeyDown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey

    // 先匹配自定义绑定（如果命中则短路掉默认逻辑）
    if (meta) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      const bindings: Array<[KeybindAction, () => void]> = [
        ['new-session',   () => { if (!inInput) { e.preventDefault(); void createSession() } }],
        ['close-session', () => {
          if (!inInput) {
            e.preventDefault()
            const sid = activeSessionId()
            if (sid) void deleteSession({ stopPropagation: () => {} } as any, sid)
          }
        }],
        ['prev-session',  () => {
          e.preventDefault()
          const list = sessions(); const cur = activeSessionId()
          const idx = list.findIndex(s => s.id === cur)
          if (idx > 0) void selectSession(list[idx - 1].id)
        }],
        ['next-session',  () => {
          e.preventDefault()
          const list = sessions(); const cur = activeSessionId()
          const idx = list.findIndex(s => s.id === cur)
          if (idx >= 0 && idx < list.length - 1) void selectSession(list[idx + 1].id)
        }],
        ['slash-cmd',     () => {
          e.preventDefault()
          textareaRef?.focus()
          if (!input().startsWith('/')) {
            setInput('/'); setShowSlash(true); setSlashQuery(''); setSlashIdx(0)
          }
        }],
        ['cmd-palette',   () => {
          e.preventDefault()
          setShowCmdPalette(true); setCmdPaletteQuery(''); setCmdPaletteIdx(0)
          void refreshCmdPalette('')
        }],
        ['terminal',      () => {
          e.preventDefault()
          if (!showTerminal()) void addTerminalTab()
          else setShowTerminal(v => !v)
        }],
        ['settings',      () => { e.preventDefault(); setShowSettings(v => !v) }],
        ['help',          () => { e.preventDefault(); setShowKeybindHelp(v => !v) }],
      ]
      for (const [action, fn] of bindings) {
        if (matchKeybind(e, getKeybind(action))) { fn(); return }
      }
    }

    // 消息间键盘导航（j/k 或 ↑/↓）— 不在输入框内、无 meta 时
    if (!meta) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const inInput = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      if (!inInput && (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const total = viewGroups().length
        if (total === 0) return
        e.preventDefault()
        const dir = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1
        const next = Math.max(0, Math.min(total - 1, (focusedMsgIdx() === -1 ? (dir > 0 ? 0 : total - 1) : focusedMsgIdx() + dir)))
        setFocusedMsgIdx(next)
        // 滚动到视图
        queueMicrotask(() => {
          const el = document.querySelector(`[data-msg-idx="${next}"]`) as HTMLElement | null
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        })
        return
      }
    }

    if (!meta) return

    // Cmd+N — 新建会话（文本框外）
    if (e.key === "n") {
      const tagName = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tagName !== "input" && tagName !== "textarea") {
        e.preventDefault()
        void createSession()
      }
    }

    // Cmd+W — 关闭当前会话（文本框外）
    if (e.key === "w") {
      const tagName = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tagName !== "input" && tagName !== "textarea") {
        e.preventDefault()
        const sid = activeSessionId()
        if (sid) {
          // deleteSession 需要一个 MouseEvent，构造一个合成事件
          const syntheticEvent = { stopPropagation: () => {} } as MouseEvent
          void deleteSession(syntheticEvent, sid)
        }
      }
    }

    // Cmd+[ — 上一个会话
    if (e.key === "[") {
      e.preventDefault()
      const list = sessions()
      const cur  = activeSessionId()
      const idx  = list.findIndex(s => s.id === cur)
      if (idx > 0) void selectSession(list[idx - 1].id)
    }

    // Cmd+] — 下一个会话
    if (e.key === "]") {
      e.preventDefault()
      const list = sessions()
      const cur  = activeSessionId()
      const idx  = list.findIndex(s => s.id === cur)
      if (idx >= 0 && idx < list.length - 1) void selectSession(list[idx + 1].id)
    }

    // Cmd+K — Slash 命令面板（聚焦输入框 + 插入 /）
    if (e.key === "k") {
      e.preventDefault()
      textareaRef?.focus()
      if (!input().startsWith('/')) {
        setInput('/')
        setShowSlash(true)
        setSlashQuery('')
        setSlashIdx(0)
      }
    }

    // Cmd+` — 切换终端
    if (e.key === "`") {
      e.preventDefault()
      if (!showTerminal()) {
        void addTerminalTab()
      } else {
        setShowTerminal(v => !v)
      }
    }

    // Cmd+, — 打开设置
    if (e.key === ",") {
      e.preventDefault()
      setShowSettings(v => !v)
    }

    // Cmd+/ 或 Cmd+? — 快捷键速查
    if (e.key === "/" || e.key === "?") {
      e.preventDefault()
      setShowKeybindHelp(v => !v)
    }

    // Cmd+P — 全局命令面板
    if (e.key === "p") {
      e.preventDefault()
      setShowCmdPalette(true)
      setCmdPaletteQuery('')
      setCmdPaletteIdx(0)
      void refreshCmdPalette('')
    }

    // Cmd+F — 会话内搜索（P0-3）：仅当有活动会话时生效
    if (e.key === "f" && activeSessionId()) {
      e.preventDefault()
      if (showInChatSearch()) {
        // 已打开：聚焦输入框
        setTimeout(() => { inChatSearchInputRef?.focus(); inChatSearchInputRef?.select() }, 0)
      } else {
        openInChatSearch()
      }
    }
  }

  // 刷新命令面板条目（本地会话 + 斜杠命令 + 远程文件符号搜索）
  async function refreshCmdPalette(query: string) {
    const q = query.trim().toLowerCase()
    const items: PaletteItem[] = []

    // 1. 会话（未归档）
    const sessions_all = sessions().filter(s => !s.archived).slice(0, 50)
    for (const s of sessions_all) {
      if (!q || (s.title ?? '').toLowerCase().includes(q)) {
        items.push({
          type: 'session',
          label: s.title || s.id.slice(0, 8),
          desc: `会话 · ${s.uiMode ?? 'code'}`,
          onSelect: async () => {
            setShowCmdPalette(false)
            await selectSession(s.id)
          },
        })
      }
    }

    // 2. 斜杠命令
    for (const cmd of SLASH_COMMANDS) {
      if (!q || cmd.name.includes(q) || cmd.label.toLowerCase().includes(q)) {
        items.push({
          type: 'command',
          label: `/${cmd.name} ${cmd.icon}`,
          desc: cmd.desc,
          onSelect: async () => {
            setShowCmdPalette(false)
            await execSlashCommand(cmd.name)
          },
        })
      }
    }

    // 3. 远程搜索：文件 + 符号（只在有查询时调）
    if (q.length >= 2) {
      const ws = activeWorkspace()
      if (ws) {
        setCmdPaletteLoading(true)
        try {
          const c = await getClient()
          const r = await c.searchSymbols(ws.id, query)
          for (const f of r.files.slice(0, 20)) {
            items.push({
              type: 'file',
              label: f.split('/').pop() ?? f,
              desc: `文件 · ${f}`,
              onSelect: () => {
                setShowCmdPalette(false)
                void openPreview(f)
              },
            })
          }
          for (const sym of r.symbols.slice(0, 20)) {
            const loc = (sym as any).location?.uri ?? (sym as any).location?.targetUri ?? ''
            items.push({
              type: 'symbol',
              label: (sym as any).name ?? '?',
              desc: `符号 · ${(sym as any).containerName ?? ''} · ${loc.replace('file://', '')}`,
              onSelect: () => {
                setShowCmdPalette(false)
                if (loc) void openPreview(loc.replace('file://', ''))
              },
            })
          }
        } catch { /* ignore */ }
        finally { setCmdPaletteLoading(false) }
      }
    }

    setCmdPaletteItems(items)
    setCmdPaletteIdx(0)
  }

  // 防抖 palette 搜索
  let cmdPaletteDebounce: number | undefined
  createEffect(() => {
    const q = cmdPaletteQuery()
    if (!showCmdPalette()) return
    if (cmdPaletteDebounce) clearTimeout(cmdPaletteDebounce)
    cmdPaletteDebounce = setTimeout(() => { void refreshCmdPalette(q) }, 150) as unknown as number
  })

  // Esc 关闭快捷键帮助（非 meta）
  createEffect(() => {
    if (!showKeybindHelp()) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setShowKeybindHelp(false) }
    }
    document.addEventListener('keydown', onEsc)
    onCleanup(() => document.removeEventListener('keydown', onEsc))
  })

  onMount(() => {
    document.addEventListener("keydown", onGlobalKeyDown)
    // 点击外部关闭下拉
    document.addEventListener("click", (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.mode-selector-wrap')) setShowModeDropdown(false)
      if (!t.closest('.git-status-branch-btn') && !t.closest('.branch-picker-popup')) setShowBranchPicker(false)
      if (!t.closest('.filter-menu') && !(t.closest('button')?.getAttribute('title') === '消息过滤')) setShowFilterMenu(false)
      // 点击 slash/mention 面板外部时关闭（textarea 内输入不关闭）
      if (!t.closest('.slash-palette') && !t.closest('textarea')) {
        setShowSlash(false)
        setShowMention(false)
      }
    })
    onCleanup(() => document.removeEventListener("keydown", onGlobalKeyDown))
  })

  // ─── 工作区切换时获取当前 git 分支 ────────────────────────────────────────
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws) { setCurrentBranch(null); setBranchPickerBranches([]); return }
    void (async () => {
      try {
        const c = await getClient()
        const r = await c.getCurrentBranch(ws.id)
        setCurrentBranch(r.branch ?? null)
        if (r.isGitRepo) {
          const br = await c.listBranches(ws.id)
          setBranchPickerBranches(br.branches ?? [])
        } else {
          setBranchPickerBranches([])
        }
      } catch {
        setCurrentBranch(null)
      }
    })()
  })

  // ─── @ 提及文件 ───────────────────────────────────────────────────────────
  const [showMention, setShowMention] = createSignal(false)
  const [mentionQuery, setMentionQuery] = createSignal("")
  const [mentionFiles, setMentionFiles] = createSignal<string[]>([])
  const [mentionIdx, setMentionIdx] = createSignal(0)
  // 全量文件缓存（按工作区 ID 分组，切换工作区时重新加载）
  const [wsFileCache, setWsFileCache] = createSignal<{ id: string; files: string[] } | null>(null)
  const [wsFileCacheLoading, setWsFileCacheLoading] = createSignal(false)

  /** 工作区变化时预加载全量文件缓存 */
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws) { setWsFileCache(null); return }
    const cached = wsFileCache()
    if (cached?.id === ws.id) return        // 已是最新缓存，无需重新加载
    setWsFileCacheLoading(true)
    void (async () => {
      try {
        const c = await getClient()
        const res = await c.listFiles(ws.id)
        setWsFileCache({ id: ws.id, files: res.files ?? [] })
      } catch {
        setWsFileCache({ id: ws.id, files: [] })
      } finally {
        setWsFileCacheLoading(false)
      }
    })()
  })

  /**
   * 本地模糊搜索：优先文件名完全包含 query，其次路径包含。
   * 按相关度排序后取前 15 条。
   */
  function filterMentionFiles(query: string): string[] {
    const cache = wsFileCache()
    if (!cache) return []
    const all = cache.files
    if (!query) {
      // 无查询：按路径深度从浅到深返回前 15 条（优先展示根目录文件）
      return [...all].sort((a, b) => {
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        return depthA !== depthB ? depthA - depthB : a.localeCompare(b)
      }).slice(0, 15)
    }
    const q = query.toLowerCase()
    const scored = all
      .map(f => {
        const basename = f.split('/').pop()!.toLowerCase()
        const full = f.toLowerCase()
        let score = 0
        if (basename === q) score = 100
        else if (basename.startsWith(q)) score = 80
        else if (basename.includes(q)) score = 60
        else if (full.includes(q)) score = 30
        else return null
        return { f, score }
      })
      .filter(Boolean) as { f: string; score: number }[]

    scored.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
    return scored.slice(0, 15).map(x => x.f)
  }

  function searchMentionFiles(query: string) {
    setMentionFiles(filterMentionFiles(query))
  }

  function insertMention(filePath: string) {
    const cur = input()
    // 找到最后一个 @ 的位置并替换到此处
    const atIdx = cur.lastIndexOf('@')
    const before = cur.slice(0, atIdx)
    const newVal = `${before}@${filePath} `
    setInput(newVal)
    setShowMention(false)
    setMentionFiles([])
    // 聚焦输入框
    textareaRef?.focus()
  }

  // ─── 计算并缓存 composer-wrap 位置（供 fixed 定位面板使用） ───────────────
  function updatePalettePos() {
    if (!composerWrapRef) return
    const rect = composerWrapRef.getBoundingClientRect()
    setPaletteRect({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
      width: rect.width,
    })
  }

  // ─── 输入框变化（检测 /slash 和 @mention） ───────────────────────────────
  function onInputChange(value: string) {
    setInput(value)
    // Slash 命令检测
    if (value.startsWith("/") && !value.includes(" ")) {
      updatePalettePos()
      const query = value.slice(1)
      setSlashQuery(query)
      setSlashIdx(0)
      setShowSlash(true)
      setShowMention(false)
      return
    }
    setShowSlash(false)

    // @ 文件提及检测
    const atIdx = value.lastIndexOf('@')
    if (atIdx >= 0 && !value.slice(atIdx).includes(' ')) {
      updatePalettePos()
      const query = value.slice(atIdx + 1)
      setMentionQuery(query)
      setMentionIdx(0)
      setShowMention(true)
      // 本地缓存过滤，无需防抖，即时响应
      searchMentionFiles(query)
    } else {
      setShowMention(false)
    }
  }

  // 过滤 slash 命令（内置 + 项目自定义）
  const filteredSlash = createMemo(() => {
    const q = slashQuery().toLowerCase()
    const customAsSlash = customCommands().map(c => ({
      name:  c.name,
      label: c.name,
      desc:  c.description || '（项目自定义命令）',
      icon:  '🎯',
      custom: true as const,
    }))
    const all: Array<typeof SLASH_COMMANDS[number] | { name: string; label: string; desc: string; icon: string; custom: true }> = [
      ...SLASH_COMMANDS, ...customAsSlash,
    ]
    if (!q) return all
    return all.filter(c => c.name.includes(q) || c.label.includes(q))
  })

  // 执行 slash 命令
  async function execSlashCommand(name: string) {
    setShowSlash(false)
    setInput("")
    // 先尝试项目自定义命令
    const custom = customCommands().find(c => c.name === name)
    if (custom) {
      // 简单模板应用：$ARGUMENTS 用当前输入（已清空）
      const applied = custom.template
        .replace(/\$ARGUMENTS\b/g, '')
        .replace(/\$FILE\b/g, '')
        .replace(/\$SELECTION\b/g, '')
      setInput(applied.trim())
      showToast({ message: `已加载模板「${name}」，编辑后按 ⌘↵ 发送`, kind: 'info', duration: 3000 })
      textareaRef?.focus()
      return
    }
    switch (name) {
      case "clear":
        setMessages([])
        setChangedFiles(new Map())
        break
      case "new":
        await createSession()
        break
      case "compact": {
        const sid = activeSessionId()
        if (!sid) { showToast({ message: '请先选择会话', kind: 'warn' }); break }
        // 结果通过 SSE context_compacting / context_compacted 事件展示
        try {
          const c = await getClient()
          await c.compactSession(sid)
        } catch (e) {
          showToast({ message: '压缩失败：' + (e as Error).message, kind: 'error' })
          setCompactingState(null)
        }
        break
      }
      case "plan": {
        const sid = activeSessionId()
        const nextMode: ComposerMode = composerMode() === 'plan' ? 'code' : 'plan'
        setComposerMode(nextMode)
        if (sid) {
          try {
            const c = await getClient()
            await c.updateSessionMode(sid, nextMode)
          } catch { /* 忽略 */ }
        }
        setMessages(prev => [...prev, {
          id: String(++msgId), role: "system",
          createdAt: Date.now(),
          content: nextMode === 'plan'
            ? "📋 已进入计划模式：AI 只规划不执行文件操作，输入任务描述后 AI 将生成实现计划"
            : "⚡ 已退出计划模式，切换回 Code 模式"
        }])
        break
      }
      case "fork": {
        const sid = activeSessionId()
        if (!sid) break
        try {
          const c = await getClient()
          const res = await c.forkSession(sid)
          if (res.ok && res.session) {
            await refreshSessions()
            await selectSession(res.session.id)
          }
        } catch (e) { alert("分叉失败：" + (e as Error).message) }
        break
      }
      case "terminal":
        void addTerminalTab()
        break
      case "files":
        setShowFileTree(true)
        break
      case "export":
        await exportSession('markdown')
        break
      case "help":
        setMessages(prev => [...prev, {
          id: String(++msgId), role: "system",
          createdAt: Date.now(),
          content: SLASH_COMMANDS.map(c => `• **/${c.name}** — ${c.desc}`).join('\n')
        }])
        break
    }
  }

  // ─── 集成终端 ─────────────────────────────────────────────────────────────

  /** 判断当前是否处于深色模式（兼容 system 自动） */
  function resolveIsDark(): boolean {
    const t = theme()
    if (t === 'dark') return true
    if (t === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  /**
   * 根据明暗模式返回 xterm.js ITheme 配置。
   * 深色：经典暗底亮字；浅色：macOS Terminal 浅灰背景风格。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getXtermTheme(isDark: boolean): Record<string, string> {
    if (isDark) {
      return {
        background:          '#111111',
        foreground:          '#e5e5e5',
        cursor:              '#e5e5e5',
        cursorAccent:        '#111111',
        selectionBackground: 'rgba(255,255,255,0.18)',
        selectionForeground: '#e5e5e5',
        black:         '#262626',
        red:           '#f87171',
        green:         '#4ade80',
        yellow:        '#fbbf24',
        blue:          '#60a5fa',
        magenta:       '#c084fc',
        cyan:          '#22d3ee',
        white:         '#e5e5e5',
        brightBlack:   '#525252',
        brightRed:     '#fca5a5',
        brightGreen:   '#86efac',
        brightYellow:  '#fde68a',
        brightBlue:    '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan:    '#67e8f9',
        brightWhite:   '#f5f5f5',
      }
    } else {
      // 浅色主题：使用浅灰背景（#f2f2f2），接近 macOS Terminal 默认浅色。
      // 所有 ANSI 颜色都为深色系，确保在浅色背景上清晰可见。
      return {
        background:          '#f2f2f2',
        foreground:          '#1c1c1e',
        cursor:              '#1c1c1e',
        cursorAccent:        '#f2f2f2',
        selectionBackground: 'rgba(0,0,0,0.15)',
        selectionForeground: '#1c1c1e',
        // 参照 macOS Terminal "Basic" 浅色方案
        black:         '#1c1c1e',
        red:           '#c0392b',
        green:         '#27ae60',
        yellow:        '#c67c00',
        blue:          '#2980b9',
        magenta:       '#8e44ad',
        cyan:          '#16a085',
        white:         '#636366',
        brightBlack:   '#48484a',
        brightRed:     '#e74c3c',
        brightGreen:   '#2ecc71',
        brightYellow:  '#f39c12',
        brightBlue:    '#3498db',
        brightMagenta: '#9b59b6',
        brightCyan:    '#1abc9c',
        brightWhite:   '#3a3a3c',
      }
    }
  }

  /** 主题变化时，更新所有已存在的 xterm 实例颜色 */
  createEffect(() => {
    const isDark = resolveIsDark()
    // 读取 theme() 使 effect 订阅主题变化
    void theme()
    const xtermTheme = getXtermTheme(isDark)
    for (const { term } of termInstances.values()) {
      try { term.options.theme = xtermTheme } catch { /* 实例可能已销毁 */ }
    }
    // 同步 CSS 变量给 terminal-body 背景
    document.documentElement.style.setProperty(
      '--terminal-bg', isDark ? '#111111' : '#f2f2f2'
    )
  })

  /**
   * 终端面板显示/激活 tab 变化时，fit 活跃终端。
   * DOM 容器始终存在（全部 tab 都在 DOM 里，仅用 CSS display 切换），
   * 所以不需要重新 open，只需 fit 即可。
   */
  createEffect(() => {
    const show = showTerminal()
    const collapsed = terminalCollapsed()
    const activeTerm = activeTermId()
    if (!show || collapsed || !activeTerm) return
    // 用 rAF 等浏览器完成布局后再 fit（切换会话后从 display:none 恢复时特别重要）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const inst = termInstances.get(activeTerm)
        if (inst) {
          try { inst.fit.fit(); inst.term.focus() } catch { /* 忽略 */ }
        }
      })
    })
  })

  /** 构建 WebSocket 终端 URL（复用 HTTP server 端口） */
  function buildTermWsUrl(cwd: string): string {
    const wsBase = BASE.replace(/^http/, 'ws')
    const auth = btoa(`${USER}:${PASS}`)
    return `${wsBase}/terminal?auth=${encodeURIComponent(auth)}&cwd=${encodeURIComponent(cwd)}`
  }

  /** 创建新终端 tab */
  async function addTerminalTab() {
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')

    const id = Math.random().toString(36).slice(2, 10)
    const tabTitle = `终端 ${terminalTabs().length + 1}`
    const cwd = activeWorkspace()?.path ?? '/'
    const wsUrl = buildTermWsUrl(cwd)

    // xterm 实例——使用当前主题色
    const term = new Terminal({
      theme: getXtermTheme(resolveIsDark()),
      fontFamily: '"Menlo", "Monaco", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // WebSocket — 必须在创建后立即设置 binaryType，才能以 ArrayBuffer 接收二进制帧
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    termInstances.set(id, { term, ws, fit })
    const sessionId = activeSessionId() ?? '__global__'
    setTerminalTabs(prev => [...prev, { id, title: tabTitle, sessionId }])
    setActiveTermId(id)
    setShowTerminal(true)
    setTerminalCollapsed(false)

    ws.onopen = () => {
      console.log(`[Terminal] WS 已连接 (${id})`)
    }

    ws.onmessage = (e: MessageEvent) => {
      const data = e.data
      // 二进制帧 = PTY 原始 UTF-8 字节流（新服务端），直接传 xterm
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data))
        return
      }
      // 文本帧：先尝试解析为控制 JSON，否则当作 PTY 文本输出（兼容旧服务端）
      const str = typeof data === 'string' ? data : ''
      if (!str) return
      try {
        const msg = JSON.parse(str) as { type: string; pid?: number; code?: number; message?: string }
        if (msg.type === 'ready') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
          return
        }
        if (msg.type === 'exit') {
          term.write(`\r\n\x1b[90m[进程已退出 (exitCode=${msg.code ?? 0})]\x1b[0m\r\n`)
          return
        }
        if (msg.type === 'error') {
          term.write(`\r\n\x1b[31m[错误: ${msg.message}]\x1b[0m\r\n`)
          return
        }
        // 其他 JSON 控制消息忽略
        return
      } catch { /* 非 JSON → 作为 PTY 文本输出（旧服务端兼容） */ }
      term.write(str)
    }

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[WebSocket 连接失败，请确认服务端已启动]\x1b[0m\r\n')
    }

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n')
    }

    // PTY 输入：xterm → WebSocket
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // 等待 DOM 渲染后挂载终端
    queueMicrotask(() => mountTerminalToDOM(id))
  }

  /** 将 xterm 挂载到指定容器元素（id 对应 DOM） */
  function mountTerminalToDOM(id: string) {
    const inst = termInstances.get(id)
    if (!inst) return
    const container = document.getElementById(`term-body-${id}`)
    if (!container) {
      // 若 DOM 尚未渲染，延迟重试
      setTimeout(() => mountTerminalToDOM(id), 50)
      return
    }
    if (container.querySelector('.xterm')) return  // 已挂载

    const { term, fit, ws } = inst
    term.open(container)

    // 用 rAF 确保浏览器完成布局后再 fit，避免 display:none 父容器导致 0 尺寸
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (container.clientWidth > 0) {
          fit.fit()
          term.focus()
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        } else {
          // 若仍为 0，再等一帧（极端情况：父容器动画中）
          requestAnimationFrame(() => {
            fit.fit()
            term.focus()
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
            }
          })
        }
      })
    })

    // 发送初始尺寸（在 WebSocket 就绪时发送；WebSocket 可能比 rAF 先开）
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    // ResizeObserver 自动适配
    // 关键：只在容器实际可见（clientWidth > 0）时才 fit，
    // 否则 display:none 时 clientWidth=0，fit 会把终端尺寸压成 0 行 0 列，
    // 导致会话切换后内容消失（PTY 被 resize 到 0 则 SIGHUP 或内容清空）。
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }
    })
    observer.observe(container)
    inst.resizeObs = observer
  }

  /** 切换 terminal tab */
  function switchTerminalTab(id: string) {
    setActiveTermId(id)
    queueMicrotask(() => {
      const inst = termInstances.get(id)
      if (inst) {
        inst.fit.fit()
        inst.term.focus()
      }
    })
  }

  /** 关闭 terminal tab */
  function closeTerminalTab(id: string, e: MouseEvent) {
    e.stopPropagation()
    const inst = termInstances.get(id)
    if (inst) {
      inst.resizeObs?.disconnect()
      try { inst.ws.close() } catch { /* ignore */ }
      inst.term.dispose()
      termInstances.delete(id)
    }
    const tabs = terminalTabs().filter(t => t.id !== id)
    setTerminalTabs(tabs)
    if (activeTermId() === id) {
      // 找当前会话的下一个可用 tab
      const sid = activeSessionId() ?? '__global__'
      const sessionTabs = tabs.filter(t => t.sessionId === sid)
      const next = sessionTabs[sessionTabs.length - 1]
      if (next) {
        setActiveTermId(next.id)
        queueMicrotask(() => switchTerminalTab(next.id))
      } else {
        setActiveTermId(null)
        setShowTerminal(false)
      }
    }
  }

  /** 调整终端高度（拖拽 resize handle） */
  let resizingTerminal = false
  let resizeStartY = 0
  let resizeStartH = 280

  function onTerminalResizeStart(e: PointerEvent) {
    resizingTerminal = true
    resizeStartY = e.clientY
    resizeStartH = terminalHeight()
    document.addEventListener('pointermove', onTerminalResizeMove)
    document.addEventListener('pointerup', onTerminalResizeEnd)
    e.preventDefault()
  }

  function onTerminalResizeMove(e: PointerEvent) {
    if (!resizingTerminal) return
    const delta = resizeStartY - e.clientY  // 向上拖动 = 增大
    const newH = Math.max(120, Math.min(600, resizeStartH + delta))
    setTerminalHeight(newH)
    // 重新 fit 当前终端
    const id = activeTermId()
    if (id) termInstances.get(id)?.fit.fit()
  }

  function onTerminalResizeEnd() {
    resizingTerminal = false
    document.removeEventListener('pointermove', onTerminalResizeMove)
    document.removeEventListener('pointerup', onTerminalResizeEnd)
  }

  /** TerminalPanel 组件 */
  function TerminalPanel() {
    // 当前会话的 terminal tab（仅用于 header 显示）
    const sessionTabs = () => terminalTabs().filter(t => t.sessionId === (activeSessionId() ?? '__global__'))

    return (
      <div
        class="terminal-panel"
        classList={{ collapsed: terminalCollapsed() }}
        style={!terminalCollapsed() ? `height:${terminalHeight()}px` : ''}
      >
        {/* 拖拽 resize handle */}
        <div class="terminal-resize-handle" onPointerDown={onTerminalResizeStart} />

        {/* 顶部 header */}
        <div class="terminal-panel-header">
          <div class="terminal-tabs">
            {/* 只显示当前会话的 tab 标签 */}
            <For each={sessionTabs()}>
              {(tab) => (
                <div
                  class="terminal-tab"
                  classList={{ active: activeTermId() === tab.id }}
                  onClick={() => switchTerminalTab(tab.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                  </svg>
                  {tab.title}
                  <span class="terminal-tab-close" onClick={(e) => closeTerminalTab(tab.id, e)}>✕</span>
                </div>
              )}
            </For>
            {/* 新建终端按钮 */}
            <button class="terminal-panel-btn" onClick={addTerminalTab} title="新建终端">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
          <div class="terminal-panel-actions">
            <button class="terminal-panel-btn" onClick={() => setTerminalCollapsed(v => !v)} title={terminalCollapsed() ? "展开" : "折叠"}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <Show when={terminalCollapsed()} fallback={<polyline points="18 15 12 9 6 15"/>}>
                  <polyline points="6 9 12 15 18 9"/>
                </Show>
              </svg>
            </button>
            <button class="terminal-panel-btn" onClick={() => {
              // 仅关闭当前会话的终端
              for (const tab of sessionTabs()) closeTerminalTab(tab.id, new MouseEvent('click'))
              setShowTerminal(false)
            }} title="关闭终端">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* 终端内容区（不折叠时显示）
            关键：body 里渲染【所有会话】的 term-body div，通过 CSS display 控制可见性。
            这样 xterm canvas 永远不会被 SolidJS 的 <For> 卸载，避免切换会话后内容丢失。 */}
        <div class="terminal-body" style={terminalCollapsed() ? 'display:none' : ''}>
          <For each={terminalTabs()}>
            {(tab) => (
              <div
                id={`term-body-${tab.id}`}
                class="terminal-xterm"
                style={activeTermId() === tab.id ? '' : 'display:none'}
              />
            )}
          </For>
        </div>
      </div>
    )
  }

  // ─── 图片附件处理 ──────────────────────────────────────────────────────────
  function handleImageFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      if (!dataUrl) return
      setAttachedImages(prev => [...prev, {
        id: Math.random().toString(36).slice(2),
        dataUrl,
        name: file.name,
      }])
    }
    reader.readAsDataURL(file)
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) handleImageFile(file)
      }
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (const file of files) {
      if (file.type.startsWith("image/")) handleImageFile(file)
    }
  }

  function removeImage(id: string) {
    setAttachedImages(prev => prev.filter(img => img.id !== id))
  }

  // ─── Agent 提问回答 ────────────────────────────────────────────────────
  async function handleAnswerQuestion(cancelled = false) {
    const req = questionRequest()
    if (!req) return
    setQuestionRequest(null)
    try {
      const c = await getClient()
      await c.answerQuestion(req.sessionId, {
        answer:    questionAnswer(),
        selected:  questionSelected().length > 0 ? questionSelected() : undefined,
        cancelled,
      })
    } catch (e) {
      console.error('[Question] 回答提交失败:', e)
    }
  }

  async function handlePlanExit(approved: boolean) {
    const req = planExitRequest()
    if (!req) return
    setPlanExitRequest(null)
    try {
      const c = await getClient()
      await c.respondPlanExit(req.sessionId, approved, planExitFeedback() || undefined)
      if (approved) {
        // 切换到 code 模式
        try { await c.updateSessionMode(req.sessionId, 'code') } catch { /* ignore */ }
        showToast({ message: '已切换到 Code 模式开始执行', kind: 'success' })
      }
    } catch (e) {
      console.error('[PlanExit] 提交失败:', e)
    }
  }

  // ─── 审批对话框操作 ────────────────────────────────────────────────────────
  async function handleApprove(approved: boolean, remember?: 'session' | 'always') {
    const req = approvalRequest()
    if (!req) return
    setApprovalRequest(null)
    // 记忆选择
    if (approved && remember === 'session') addSessionAllow(req.sessionId, req.toolName)
    if (approved && remember === 'always')  addAllowAlways(req.toolName)
    try {
      const c = await getClient()
      await c.approveToolCall(req.sessionId, req.toolUseId, approved)
    } catch (e) {
      console.error("[Approval] 审批请求失败:", e)
    }
  }

  // ─── 会话导出 ──────────────────────────────────────────────────────────────
  async function exportSession(format: 'markdown' | 'json') {
    const sid = activeSessionId()
    const msgs = messages()
    if (!sid || msgs.length === 0) { alert("暂无消息可导出"); return }

    let content: string
    let filename: string
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')

    if (format === 'markdown') {
      const lines: string[] = [`# 码弦 AI 会话导出\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n`]
      for (const m of msgs) {
        if (m.role === 'user') {
          lines.push(`\n## 用户\n\n${m.content}\n`)
        } else if (m.role === 'assistant') {
          lines.push(`\n## AI\n\n${m.content}\n`)
        } else if (m.role === 'tool') {
          lines.push(`\n> 🔧 ${TOOL_LABELS[m.toolName ?? ''] ?? m.toolName}: ${getToolSubtitle(m.toolName ?? '', m.toolParams)}\n`)
        }
      }
      content = lines.join('')
      filename = `maxian-session-${timestamp}.md`
    } else {
      content = JSON.stringify(msgs.map(m => ({
        role: m.role, content: m.content,
        toolName: m.toolName, toolParams: m.toolParams,
      })), null, 2)
      filename = `maxian-session-${timestamp}.json`
    }

    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const dialogMod = await import('@tauri-apps/plugin-dialog' as any)
        const fsMod = await import('@tauri-apps/plugin-fs' as any)
        const savePath = await dialogMod.save({ defaultPath: filename, filters: [{ name: 'File', extensions: [format === 'markdown' ? 'md' : 'json'] }] })
        if (savePath) {
          await fsMod.writeTextFile(savePath, content)
          alert(`已导出到: ${savePath}`)
        }
      } else {
        // 浏览器环境：触发下载
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        URL.revokeObjectURL(url)
      }
    } catch (e) { alert("导出失败：" + (e as Error).message) }
  }

  // ─── 在外部编辑器打开文件 ─────────────────────────────────────────────────
  async function openInEditor(filePath: string) {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const { Command } = await import('@tauri-apps/plugin-shell' as any)
        // 依次尝试常见编辑器
        const editors = ['cursor', 'code', 'vim', 'nano']
        for (const editor of editors) {
          try {
            await Command.create(editor, [filePath]).execute()
            return
          } catch { /* 该编辑器不存在，继续尝试 */ }
        }
        alert('未找到可用编辑器（已尝试 cursor/code/vim/nano）')
      } else {
        alert(`文件路径：${filePath}\n请手动在编辑器中打开`)
      }
    } catch (e) {
      console.error('[openInEditor]', e)
    }
  }

  // ─── 文件树面板 ────────────────────────────────────────────────────────────
  async function revertFile(filePath: string) {
    const sid = activeSessionId()
    if (!sid) return
    const ok = await appConfirm(`确定要撤销对文件的修改吗？\n${filePath}`)
    if (!ok) return
    try {
      const c = await getClient()
      const res = await c.revertFile(sid, filePath)
      if (res.ok) {
        setChangedFiles(prev => {
          const next = new Map(prev)
          next.delete(filePath)
          return next
        })
        // 清除该文件 preview tab 中的 diff 缓存，并切回源码
        setPreviewTabs(prev => prev.map(t =>
          t.path === filePath
            ? { ...t, viewMode: 'source', changed: undefined, diffOriginal: null, diffCurrent: '' }
            : t
        ))
      } else {
        alert("撤销失败：" + (res.error ?? "未知错误"))
      }
    } catch (e) {
      alert("撤销失败：" + (e as Error).message)
    }
  }

  // ─── 预览面板操作 ────────────────────────────────────────────────────────
  /** 根据扩展名/MIME 判定 PreviewTab.kind */
  function classifyFileKind(file: {
    isImage: boolean; isAudio: boolean; isVideo: boolean; isBinary: boolean;
    path: string; mimeType: string;
  }): PreviewTab['kind'] {
    if (file.isImage) return 'image'
    if (file.isAudio) return 'audio'
    if (file.isVideo) return 'video'
    if (file.isBinary) return 'binary'
    const ext = file.path.split('.').pop()?.toLowerCase() ?? ''
    if (['md','markdown','mdx'].includes(ext)) return 'markdown'
    return 'text'
  }

  /** 打开一个文件到预览面板（或激活已打开的标签） */
  async function openPreview(filePath: string, opts?: { viewMode?: PreviewTab['viewMode']; line?: number }) {
    const ws = activeWorkspace()
    if (!ws) { alert('请先打开工作区'); return }

    // 已打开 → 仅激活 + 可能切换视图 + 跳转行号
    const existing = previewTabs().find(t => t.path === filePath)
    if (existing) {
      setActivePreviewPath(filePath)
      if (opts?.viewMode) {
        setPreviewTabs(prev => prev.map(t =>
          t.path === filePath ? { ...t, viewMode: opts.viewMode! } : t
        ))
        if (opts.viewMode === 'diff') void loadDiffForTab(filePath)
      }
      if (opts?.line && opts.line > 0) {
        // 直接滚动（已加载）
        setTimeout(() => scrollPreviewToLine(filePath, opts.line!), 50)
      }
      return
    }

    // 新建 loading 标签
    const title = filePath.split(/[\\/]/).pop() || filePath
    const changed = changedFiles().get(filePath)?.action
    const initialViewMode: PreviewTab['viewMode'] =
      opts?.viewMode ?? (changed ? 'diff' : 'source')

    const placeholder: PreviewTab = {
      path:     filePath,
      title,
      kind:     'text',
      content:  '',
      mimeType: 'text/plain',
      size:     0,
      loading:  true,
      viewMode: initialViewMode,
      changed,
      pendingLine: opts?.line && opts.line > 0 ? opts.line : undefined,
    }
    setPreviewTabs(prev => [...prev, placeholder])
    setActivePreviewPath(filePath)

    try {
      const c = await getClient()
      const data = await c.readFileContent(ws.id, filePath)
      const kind = classifyFileKind(data)
      // 同步抓一次 mtime 作为 P0-4 基线
      let mtimeMs: number | undefined
      try {
        const st = await c.getFileStat(ws.id, filePath)
        if (st.exists) mtimeMs = st.mtimeMs
      } catch { /* ignore */ }

      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? {
              ...t,
              kind,
              content: data.content,
              mimeType: data.mimeType,
              size: data.size,
              error: data.error,
              loading: false,
              mtimeMs,
              extChangedAt: undefined,
            }
          : t
      ))

      if (initialViewMode === 'diff') void loadDiffForTab(filePath)
      // P0-1: 跳转到指定行
      if (opts?.line && opts.line > 0) {
        setTimeout(() => scrollPreviewToLine(filePath, opts.line!), 80)
      }
    } catch (e) {
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, loading: false, error: (e as Error).message }
          : t
      ))
    }
  }

  /**
   * 滚动预览到指定行号（1-based）并短暂高亮（P0-1）
   * 思路：代码行号预览是 `<pre class="preview-code-lineno">` 单个 pre，按行高计算偏移滚动。
   */
  function scrollPreviewToLine(filePath: string, line: number) {
    if (activePreviewPath() !== filePath) setActivePreviewPath(filePath)
    const wrap = document.querySelector('.preview-code-wrap') as HTMLElement | null
    if (!wrap) return
    const lineno = wrap.querySelector('.preview-code-lineno') as HTMLElement | null
    if (!lineno) return
    // 用第一行高度估算（等宽字体下所有行高相同）
    const firstTxt = (lineno.textContent ?? '').split('\n')[0] ?? '1'
    // 借助一个探测 span
    const probe = document.createElement('span')
    probe.style.cssText = 'font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:inherit;visibility:hidden;position:absolute'
    probe.textContent = firstTxt
    lineno.appendChild(probe)
    const lh = probe.getBoundingClientRect().height || 18
    probe.remove()
    const scrollable = wrap.parentElement as HTMLElement | null  // .preview-body
    if (!scrollable) return
    const targetTop = Math.max(0, (line - 3) * lh)
    scrollable.scrollTo({ top: targetTop, behavior: 'smooth' })
    // 短暂高亮：在 .preview-code 中给第 line 行包一层
    const code = wrap.querySelector('.preview-code code') as HTMLElement | null
    if (!code) return
    const oldHl = wrap.querySelector('.preview-line-hl')
    oldHl?.remove()
    const hl = document.createElement('div')
    hl.className = 'preview-line-hl'
    hl.style.cssText = `position:absolute;left:0;right:0;top:${(line - 1) * lh + code.offsetTop}px;height:${lh}px;background:rgba(255,220,60,0.18);border-left:2px solid #ffd83d;pointer-events:none;z-index:2;transition:opacity 0.5s`
    wrap.style.position = 'relative'
    wrap.appendChild(hl)
    setTimeout(() => { hl.style.opacity = '0'; setTimeout(() => hl.remove(), 600) }, 1600)
  }

  /** 重载 preview 内容（P0-4: 外部变更后点击"重新加载"） */
  async function reloadPreview(filePath: string) {
    const ws = activeWorkspace()
    if (!ws) return
    try {
      const c = await getClient()
      const data = await c.readFileContent(ws.id, filePath)
      const kind = classifyFileKind(data)
      let mtimeMs: number | undefined
      try {
        const st = await c.getFileStat(ws.id, filePath)
        if (st.exists) mtimeMs = st.mtimeMs
      } catch { /* ignore */ }
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? {
              ...t,
              kind,
              content: data.content,
              mimeType: data.mimeType,
              size: data.size,
              error: data.error,
              loading: false,
              mtimeMs,
              extChangedAt: undefined,
            }
          : t
      ))
    } catch (e) {
      showToast({ message: '重载失败: ' + (e as Error).message, kind: 'error' })
    }
  }

  // P0-4: 外部文件变更检测（每 3s 轮询已打开预览的 mtime）
  onMount(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const ws = activeWorkspace()
        const tabs = previewTabs()
        if (ws && tabs.length > 0) {
          const c = await getClient()
          for (const tab of tabs) {
            if (tab.loading) continue
            if (tab.mtimeMs === undefined) continue
            // 已标记过的保持（用户未重载前不重复提示）
            if (tab.extChangedAt) continue
            try {
              const st = await c.getFileStat(ws.id, tab.path)
              if (st.exists && Math.abs(st.mtimeMs - tab.mtimeMs) > 2) {
                setPreviewTabs(prev => prev.map(t =>
                  t.path === tab.path ? { ...t, extChangedAt: Date.now() } : t
                ))
              }
            } catch { /* ignore per-tab errors */ }
          }
        }
      } catch { /* ignore */ }
      if (!stopped) setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
    onCleanup(() => { stopped = true })
  })

  /** 懒加载某标签的 diff 数据 */
  async function loadDiffForTab(filePath: string) {
    const sid = activeSessionId()
    if (!sid) return
    const tab = previewTabs().find(t => t.path === filePath)
    if (!tab) return
    if (tab.diffOriginal !== undefined) return  // 已加载
    setPreviewTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, diffLoading: true } : t
    ))
    try {
      const c = await getClient()
      const data = await c.getFileDiff(sid, filePath)
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, diffOriginal: data.original, diffCurrent: data.current, diffLoading: false }
          : t
      ))
    } catch {
      setPreviewTabs(prev => prev.map(t =>
        t.path === filePath
          ? { ...t, diffOriginal: null, diffCurrent: '', diffLoading: false }
          : t
      ))
    }
  }

  function closePreviewTab(filePath: string) {
    setPreviewTabs(prev => {
      const idx = prev.findIndex(t => t.path === filePath)
      if (idx < 0) return prev
      const next = prev.filter(t => t.path !== filePath)
      if (activePreviewPath() === filePath) {
        // 激活邻近标签
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        setActivePreviewPath(neighbor?.path ?? null)
      }
      return next
    })
  }

  function setTabViewMode(filePath: string, mode: PreviewTab['viewMode']) {
    setPreviewTabs(prev => prev.map(t =>
      t.path === filePath ? { ...t, viewMode: mode } : t
    ))
    if (mode === 'diff') void loadDiffForTab(filePath)
  }

  // 保留旧 API 名以兼容调用点：openFileDiff → 直接打开 preview 的 diff 视图
  async function openFileDiff(filePath: string) {
    await openPreview(filePath, { viewMode: 'diff' })
  }

  function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }

  /**
   * 将 DB 存储的 StoredMessage 转换为前端 ChatMessage，
   * 'tool' 角色的 content 是 JSON（toolName/toolUseId/toolParams/toolResult/toolSuccess）需要解析。
   */
  function storedToChatMessage(m: StoredMessage): ChatMessage {
    if (m.role === 'tool') {
      try {
        const parsed = JSON.parse(m.content);
        return {
          id:          m.id,
          role:        'tool',
          content:     '',
          isPartial:   false,
          createdAt:   m.createdAt,
          toolName:    parsed.toolName    ?? 'unknown',
          toolUseId:   parsed.toolUseId   ?? m.id,
          toolParams:  parsed.toolParams  ?? {},
          toolResult:  parsed.toolResult  ?? '',
          toolSuccess: parsed.toolSuccess ?? true,
        }
      } catch {
        return { id: m.id, role: 'tool', content: m.content, isPartial: false, createdAt: m.createdAt, toolName: 'unknown', toolUseId: m.id, toolSuccess: true }
      }
    }
    if (m.role === 'reasoning') {
      return {
        id:        m.id,
        role:      'reasoning',
        content:   m.content,
        isPartial: false,
        createdAt: m.createdAt,
        charCount: m.content.length,
      }
    }
    return {
      id:        m.id,
      role:      m.role as ChatMessage["role"],
      content:   m.content,
      isPartial: false,
      createdAt: m.createdAt,
    }
  }

  /** 格式化时间戳为 yyyy-mm-dd hh:mm:ss */
  function formatFullTime(ts?: number): string {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  function userInitials(u: UserInfo) {
    const n = u.nickName || u.userName || ""
    return n.slice(0, 1).toUpperCase() || "U"
  }

  function shortPath(p: string) {
    if (!p) return "未知工作区"
    const parts = p.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || p
  }

  function formatRecv(n: number): string {
    if (n < 1000) return `${n} 字`
    return `${(n / 1000).toFixed(1)}K 字`
  }

  function toggleTool(toolUseId: string) {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(toolUseId)) next.delete(toolUseId)
      else next.add(toolUseId)
      return next
    })
  }

  function toggleReasoning(id: string) {
    setExpandedReasonings(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ─── Settings panels ──────────────────────────────────────────────────────
  function SettingsAppearance() {
    return (
      <>
        <div class="settings-title">外观</div>

        {/* Vim 模式 */}
        <div class="settings-group">
          <div class="settings-group-title">编辑器</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">Vim 模式</div>
                <div class="settings-row-desc">
                  在输入框启用 Vim 模态编辑（h/j/k/l 移动、i/a/o 进入 insert、Esc 回 normal、x/dd 删除、p 粘贴、w/b 按词跳转）
                </div>
              </div>
              <label class="toggle">
                <input type="checkbox" checked={vimEnabled()}
                  onChange={(e) => toggleVim(e.currentTarget.checked)} />
                <span class="toggle-track" />
              </label>
            </div>
          </div>
        </div>

        {/* Theme */}
        <div class="settings-group">
          <div class="settings-group-title">主题</div>
          <div class="settings-card">
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:16px">
              <div class="settings-row-label">
                <div class="settings-row-name">颜色主题</div>
                <div class="settings-row-desc">使用浅色、深色，或匹配系统设置</div>
              </div>
              <div class="theme-picker">
                <button class="theme-option" classList={{ active: theme() === "light" }} onClick={() => setTheme("light")}>
                  <div class="theme-preview theme-preview-light" />
                  <span class="theme-label">浅色</span>
                </button>
                <button class="theme-option" classList={{ active: theme() === "dark" }} onClick={() => setTheme("dark")}>
                  <div class="theme-preview theme-preview-dark" />
                  <span class="theme-label">深色</span>
                </button>
                <button class="theme-option" classList={{ active: theme() === "system" }} onClick={() => setTheme("system")}>
                  <div class="theme-preview theme-preview-system" />
                  <span class="theme-label">系统</span>
                </button>
              </div>
              <div class="code-preview-wrap" style="width:100%">
                <div class="code-preview code-preview-light">
                  <div class="code-preview-header">浅色预览</div>
                  <div class="code-preview-body">
                    <div class="code-line code-hl-del">
                      <span class="code-ln">1</span>
                      <span><span class="token-key">surface</span><span class="token-punct">: </span><span class="token-str">"sidebar"</span><span class="token-punct">,</span></span>
                    </div>
                    <div class="code-line">
                      <span class="code-ln">2</span>
                      <span><span class="token-key">contrast</span><span class="token-punct">: </span><span class="token-num">42</span><span class="token-punct">,</span></span>
                    </div>
                  </div>
                </div>
                <div class="code-preview code-preview-dark">
                  <div class="code-preview-header">深色预览</div>
                  <div class="code-preview-body">
                    <div class="code-line code-hl-add">
                      <span class="code-ln">1</span>
                      <span><span class="token-key">surface</span><span class="token-punct">: </span><span class="token-str">"elevated"</span><span class="token-punct">,</span></span>
                    </div>
                    <div class="code-line">
                      <span class="code-ln">2</span>
                      <span><span class="token-key">contrast</span><span class="token-punct">: </span><span class="token-num">68</span><span class="token-punct">,</span></span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Font */}
        <div class="settings-group">
          <div class="settings-group-title">字体</div>
          <div class="settings-card">
            {/* Font family */}
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">界面字体</div>
                <div class="settings-row-desc">应用 UI 使用的字体</div>
              </div>
              <select
                class="settings-select"
                value={fontFamily()}
                onChange={(e) => setFontFamily(e.currentTarget.value)}
              >
                <For each={FONT_FAMILIES}>
                  {(f) => <option value={f.value}>{f.label}</option>}
                </For>
              </select>
            </div>

            {/* Font size */}
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:12px">
              <div class="settings-row-label">
                <div class="settings-row-name">字体大小</div>
                <div class="settings-row-desc">界面文字大小（11 – 18 px）</div>
              </div>
              <div class="font-size-control">
                <span class="font-size-label">A</span>
                <input
                  type="range"
                  min="11" max="18" step="1"
                  class="font-size-slider"
                  value={fontSize()}
                  onInput={(e) => setFontSize(parseInt(e.currentTarget.value, 10))}
                />
                <span class="font-size-label large">A</span>
                <input
                  type="number"
                  min="11" max="18"
                  class="font-size-input"
                  value={fontSize()}
                  onInput={(e) => {
                    const v = parseInt(e.currentTarget.value, 10)
                    if (!isNaN(v) && v >= 11 && v <= 18) setFontSize(v)
                  }}
                />
                <span class="font-size-unit">px</span>
              </div>
              {/* Live preview */}
              <div class="font-preview" style={`font-family:${FONT_FAMILIES.find(f => f.value === fontFamily())?.css ?? "inherit"};font-size:${fontSize()}px`}>
                码弦 AI 编程助手 · Maxian 0.1.0
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  function SettingsGeneral() {
    return (
      <>
        <div class="settings-title">常规</div>
        <div class="settings-group">
          <div class="settings-group-title">账号</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">用户</div>
                <div class="settings-row-desc">{currentUser()?.email || currentUser()?.userName || "—"}</div>
              </div>
              <button class="btn btn-ghost" style="font-size:12px" onClick={handleLogout}>退出登录</button>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">服务器</div>
                <div class="settings-row-desc">{loginApiUrl()}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">键盘快捷键</div>
          <div class="settings-card">
            {[
              ['⌘↵',      '发送消息'],
              ['⌘N',      '新建会话'],
              ['⌘W',      '关闭当前会话'],
              ['⌘[',      '上一个会话'],
              ['⌘]',      '下一个会话'],
              ['⌘K',      '命令面板 (/)'],
              ['⌘`',      '切换终端'],
              ['⌘,',      '打开设置'],
              ['Esc',     '停止生成 / 关闭面板'],
            ].map(([key, desc]) => (
              <div class="settings-row">
                <div class="settings-row-label">
                  <div class="settings-row-desc">{desc}</div>
                </div>
                <span style="font-size:11px;color:var(--text-faint);background:var(--bg-muted);padding:3px 8px;border-radius:4px;border:1px solid var(--border-strong);font-family:monospace">{key}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">权限记忆</div>
          <div class="settings-card">
            <Show when={allowAlways().size === 0} fallback={
              <For each={[...allowAlways()]}>
                {(toolName) => (
                  <div class="settings-row">
                    <div class="settings-row-label">
                      <div class="settings-row-name">{TOOL_LABELS[toolName] ?? toolName}</div>
                      <div class="settings-row-desc">已"总是允许"此工具，跳过审批对话框</div>
                    </div>
                    <button
                      class="btn btn-ghost"
                      onClick={() => removeAllowAlways(toolName)}
                      style="color:#f87171;border-color:rgba(239,68,68,0.3)"
                    >撤销</button>
                  </div>
                )}
              </For>
            }>
              <div class="settings-row">
                <div class="settings-row-label">
                  <div class="settings-row-desc">暂无"总是允许"的工具。在工具审批对话框点击"总是允许"后会显示在此。</div>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group-title">界面语言</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">语言 / Language</div>
                <div class="settings-row-desc">切换界面语言（部分文字重启后生效）</div>
              </div>
              <div style="display:flex;gap:6px">
                <button
                  class="btn btn-ghost"
                  style={locale() === 'zh-CN' ? 'border-color:var(--accent);color:var(--accent)' : ''}
                  onClick={() => switchLocale('zh-CN')}
                >
                  中文
                </button>
                <button
                  class="btn btn-ghost"
                  style={locale() === 'en' ? 'border-color:var(--accent);color:var(--accent)' : ''}
                  onClick={() => switchLocale('en')}
                >
                  English
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ─── Git Worktree 管理设置面板 ───────────────────────────────────────────
  function SettingsWorktree() {
    const [worktrees, setWorktrees] = createSignal<Array<{ path: string; branch: string; head: string; locked: boolean }>>([])
    const [branches, setBranches] = createSignal<string[]>([])
    const [loading, setLoading] = createSignal(false)
    const [error, setError] = createSignal("")
    const [isGitRepo, setIsGitRepo] = createSignal(true)
    const [newBranch, setNewBranch] = createSignal("")
    const [fromBranch, setFromBranch] = createSignal("")
    const [creating, setCreating] = createSignal(false)

    const ws = activeWorkspace()

    onMount(async () => {
      if (!ws) return
      setLoading(true)
      try {
        const c = await getClient()
        const [wt, br] = await Promise.all([
          c.listWorktrees(ws.id),
          c.listBranches(ws.id),
        ])
        const gitRepo = (wt as any).isGitRepo !== false
        setIsGitRepo(gitRepo)
        setWorktrees(wt.worktrees ?? [])
        setBranches(br.branches ?? [])
        if (br.branches?.length) setFromBranch(br.branches[0])
        if ((wt as any).error) setError((wt as any).error)
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setLoading(false)
      }
    })

    async function addWorktree() {
      if (!ws || !newBranch().trim()) return
      setCreating(true)
      setError("")
      try {
        const c = await getClient()
        const res = await c.createWorktree(ws.id, {
          branch: fromBranch(),
          newBranch: newBranch().trim(),
        })
        if (res.ok) {
          setNewBranch("")
          const wt = await c.listWorktrees(ws.id)
          setWorktrees(wt.worktrees ?? [])
        } else {
          setError(res.error ?? '创建失败')
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setCreating(false)
      }
    }

    async function removeWorktree(wtPath: string) {
      if (!ws) return
      const ok = await appConfirm(`确定要删除 Worktree？\n${wtPath}\n\n注意：只删除 worktree，不删除分支。`)
      if (!ok) return
      try {
        const c = await getClient()
        const res = await c.removeWorktree(ws.id, wtPath)
        if (res.ok) {
          const wt = await c.listWorktrees(ws.id)
          setWorktrees(wt.worktrees ?? [])
        } else {
          setError(res.error ?? '删除失败')
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      }
    }

    return (
      <>
        <div class="settings-title">Git Worktree 管理</div>
        <Show when={!ws}>
          <div class="settings-group">
            <div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">请先在左侧选择一个工作区</div>
          </div>
        </Show>
        <Show when={!!ws && !isGitRepo()}>
          <div class="settings-group">
            <div style="color:var(--text-muted);padding:20px;text-align:center;font-size:13px">
              <div style="font-size:24px;margin-bottom:8px">📁</div>
              当前工作区不是 Git 仓库<br/>
              <span style="font-size:11px">Worktree 管理仅适用于 Git 仓库</span>
            </div>
          </div>
        </Show>
        <Show when={!!ws && isGitRepo()}>
          <Show when={error()}>
            <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#f87171">{error()}</div>
          </Show>
          <div class="settings-group">
            <div class="settings-group-title">当前 Worktrees</div>
            <div class="settings-card">
              <Show when={loading()}>
                <div style="text-align:center;padding:20px;color:var(--text-muted)">
                  <span class="spinner" style="width:16px;height:16px" />
                </div>
              </Show>
              <Show when={!loading() && worktrees().length === 0}>
                <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">此仓库没有额外的 worktrees</div>
              </Show>
              <For each={worktrees()}>
                {(wt) => (
                  <div class="settings-row" style="align-items:flex-start;gap:8px">
                    <div class="settings-row-label" style="flex:1;min-width:0">
                      <div class="settings-row-name" style="font-family:monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        {wt.branch || '（分离 HEAD）'}
                      </div>
                      <div class="settings-row-desc" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">
                        {wt.path} · {wt.head}
                      </div>
                    </div>
                    <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
                      <Show when={wt.locked}>
                        <span style="font-size:10px;color:var(--text-faint);background:var(--bg-muted);padding:1px 5px;border-radius:3px">锁定</span>
                      </Show>
                      <button
                        class="btn btn-ghost"
                        style="font-size:11px;padding:3px 8px"
                        onClick={() => removeWorktree(wt.path)}
                        disabled={wt.locked}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="settings-group">
            <div class="settings-group-title">创建新 Worktree</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row-label">
                  <div class="settings-row-name">新分支名</div>
                  <div class="settings-row-desc">新 worktree 使用的分支名称</div>
                </div>
                <input
                  class="settings-input"
                  placeholder="feature/my-branch"
                  value={newBranch()}
                  onInput={(e) => setNewBranch(e.currentTarget.value)}
                />
              </div>
              <div class="settings-row">
                <div class="settings-row-label">
                  <div class="settings-row-name">基于分支</div>
                  <div class="settings-row-desc">从哪个分支创建</div>
                </div>
                <select
                  class="settings-select"
                  value={fromBranch()}
                  onChange={(e) => setFromBranch(e.currentTarget.value)}
                >
                  <For each={branches()}>
                    {(b) => <option value={b}>{b}</option>}
                  </For>
                </select>
              </div>
              <div class="settings-row" style="justify-content:flex-end">
                <button
                  class="btn btn-primary"
                  onClick={addWorktree}
                  disabled={!newBranch().trim() || creating()}
                >
                  <Show when={creating()} fallback="创建 Worktree">
                    <span class="spinner" style="width:12px;height:12px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />
                    创建中…
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </Show>
      </>
    )
  }

  // ─── MCP Server 管理设置面板 ──────────────────────────────────────────────
  /**
   * MCP Server 配置存储在 ~/.maxian/mcp-servers.json
   * 格式：[{ id, name, command, args, env, enabled }]
   */
  interface McpServer {
    id: string
    name: string
    command: string
    args: string[]
    env: Record<string, string>
    enabled: boolean
  }

  const MCP_CONFIG_KEY = 'maxian_mcp_servers'

  function loadMcpServers(): McpServer[] {
    try {
      const raw = localStorage.getItem(MCP_CONFIG_KEY)
      if (!raw) return []
      return JSON.parse(raw) as McpServer[]
    } catch { return [] }
  }

  function saveMcpServers(servers: McpServer[]) {
    localStorage.setItem(MCP_CONFIG_KEY, JSON.stringify(servers))
  }

  function SettingsMcp() {
    const [mcpServers, setMcpServers] = createSignal<McpServer[]>(loadMcpServers())
    const [showAddForm, setShowAddForm] = createSignal(false)
    const [newName, setNewName] = createSignal("")
    const [newCommand, setNewCommand] = createSignal("")
    const [newArgs, setNewArgs] = createSignal("")
    const [newEnv, setNewEnv] = createSignal("")

    function toggleServer(id: string) {
      const updated = mcpServers().map(s => s.id === id ? { ...s, enabled: !s.enabled } : s)
      setMcpServers(updated)
      saveMcpServers(updated)
    }

    function deleteServer(id: string) {
      const updated = mcpServers().filter(s => s.id !== id)
      setMcpServers(updated)
      saveMcpServers(updated)
    }

    function addServer() {
      const name = newName().trim()
      const command = newCommand().trim()
      if (!name || !command) return

      // 解析 args（按空格分割，支持引号）
      const args = newArgs().trim()
        ? newArgs().trim().split(/\s+/)
        : []

      // 解析 env（KEY=VALUE 格式，每行一个）
      const env: Record<string, string> = {}
      for (const line of newEnv().split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) {
          env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
      }

      const server: McpServer = {
        id: Math.random().toString(36).slice(2),
        name,
        command,
        args,
        env,
        enabled: true,
      }
      const updated = [...mcpServers(), server]
      setMcpServers(updated)
      saveMcpServers(updated)
      setNewName(""); setNewCommand(""); setNewArgs(""); setNewEnv("")
      setShowAddForm(false)
    }

    return (
      <>
        <div class="settings-title">MCP Servers</div>
        <div class="settings-group">
          <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>已配置的 MCP 服务器</span>
            <button class="btn btn-ghost" style="font-size:11px" onClick={() => setShowAddForm(v => !v)}>
              {showAddForm() ? '取消' : '+ 添加'}
            </button>
          </div>
          <div class="settings-card">
            <Show when={mcpServers().length === 0 && !showAddForm()}>
              <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">
                暂无 MCP 服务器配置<br/>
                <span style="font-size:11px">MCP (Model Context Protocol) 允许 AI 访问外部工具和数据源</span>
              </div>
            </Show>

            <For each={mcpServers()}>
              {(srv) => (
                <div class="settings-row" style="align-items:flex-start">
                  <div class="settings-row-label" style="flex:1;min-width:0">
                    <div class="settings-row-name">{srv.name}</div>
                    <div class="settings-row-desc" style="font-family:monospace;font-size:11px">
                      {srv.command} {srv.args.join(' ')}
                    </div>
                    <Show when={Object.keys(srv.env).length > 0}>
                      <div style="font-size:10px;color:var(--text-faint);margin-top:2px">
                        env: {Object.keys(srv.env).join(', ')}
                      </div>
                    </Show>
                  </div>
                  <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
                    {/* 启用/禁用 toggle */}
                    <button
                      class="btn btn-ghost"
                      style={`font-size:11px;${srv.enabled ? 'color:var(--accent)' : ''}`}
                      onClick={() => toggleServer(srv.id)}
                    >
                      {srv.enabled ? '已启用' : '已禁用'}
                    </button>
                    <button
                      class="btn btn-ghost"
                      style="font-size:11px;color:var(--error)"
                      onClick={() => deleteServer(srv.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )}
            </For>

            <Show when={showAddForm()}>
              <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:8px;display:flex;flex-direction:column;gap:10px">
                <div style="font-size:12px;font-weight:600;color:var(--text-muted)">添加 MCP 服务器</div>
                <div class="settings-row">
                  <span class="settings-row-name" style="width:80px;flex-shrink:0">名称</span>
                  <input class="settings-input" placeholder="My MCP Server" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
                </div>
                <div class="settings-row">
                  <span class="settings-row-name" style="width:80px;flex-shrink:0">命令</span>
                  <input class="settings-input" placeholder="npx @modelcontextprotocol/server-filesystem" value={newCommand()} onInput={(e) => setNewCommand(e.currentTarget.value)} />
                </div>
                <div class="settings-row">
                  <span class="settings-row-name" style="width:80px;flex-shrink:0">参数</span>
                  <input class="settings-input" placeholder="/path/to/dir" value={newArgs()} onInput={(e) => setNewArgs(e.currentTarget.value)} />
                </div>
                <div class="settings-row" style="align-items:flex-start">
                  <span class="settings-row-name" style="width:80px;flex-shrink:0;padding-top:4px">环境变量</span>
                  <textarea
                    class="settings-input"
                    style="height:60px;resize:vertical;font-family:monospace;font-size:11px"
                    placeholder={"API_KEY=your_key\nANOTHER=value"}
                    value={newEnv()}
                    onInput={(e) => setNewEnv(e.currentTarget.value)}
                  />
                </div>
                <div style="display:flex;justify-content:flex-end">
                  <button class="btn btn-primary" style="font-size:12px" onClick={addServer} disabled={!newName().trim() || !newCommand().trim()}>
                    添加
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">说明</div>
          <div class="settings-card">
            <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px">
              <div class="settings-row-desc" style="line-height:1.7">
                MCP (Model Context Protocol) 是 Anthropic 提供的标准协议，允许 AI 与外部工具和数据源交互。
                配置的 MCP 服务器将在 AI 会话中自动可用。<br/>
                <a href="https://modelcontextprotocol.io" target="_blank" style="color:var(--accent);text-decoration:none">了解更多 →</a>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ─── SettingsKeybinds（自定义快捷键）─────────────────────────────────
  function SettingsKeybinds() {
    const [recording, setRecording] = createSignal<KeybindAction | null>(null)
    const onKey = (e: KeyboardEvent) => {
      const action = recording()
      if (!action) return
      e.preventDefault()
      if (e.key === 'Escape') { setRecording(null); return }
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        setKeybind(action, eventToKeybind(e))
        setRecording(null)
      }
    }
    createEffect(() => {
      if (recording()) {
        window.addEventListener('keydown', onKey, true)
        onCleanup(() => window.removeEventListener('keydown', onKey, true))
      }
    })
    return (
      <>
        <div class="settings-title">键盘快捷键</div>
        <div class="settings-group">
          <div class="settings-group-title">绑定（点击录制新组合键，Esc 取消，macOS 的 mod = Cmd；其他 = Ctrl）</div>
          <div class="settings-card">
            <For each={KEYBIND_DEFAULTS}>
              {(kb) => {
                const current = () => getKeybind(kb.action)
                const isCustom = () => customKeybinds()[kb.action] !== undefined
                return (
                  <div class="settings-row">
                    <div class="settings-row-label">
                      <div class="settings-row-name">{kb.label}</div>
                      <div class="settings-row-desc">默认: <code>{kb.defaultKey}</code></div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center">
                      <kbd class="keybind-keys" style="min-width:120px;text-align:center">
                        {recording() === kb.action ? '正在录制… (Esc 取消)' : current()}
                      </kbd>
                      <button class="btn btn-ghost"
                        onClick={() => setRecording(r => r === kb.action ? null : kb.action)}>
                        {recording() === kb.action ? '取消' : '录制'}
                      </button>
                      <Show when={isCustom()}>
                        <button class="btn btn-ghost" onClick={() => resetKeybind(kb.action)}>重置</button>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </>
    )
  }

  // ─── SettingsTemplates（会话模板）────────────────────────────────────
  function SettingsTemplates() {
    const [newName, setNewName] = createSignal('')
    const [newContent, setNewContent] = createSignal('')
    function saveNew() {
      if (!newName().trim() || !newContent().trim()) return
      addSessionTemplate({ name: newName().trim(), content: newContent().trim() })
      setNewName(''); setNewContent('')
      showToast({ message: '模板已保存', kind: 'success' })
    }
    async function useTemplate(t: SessionTemplate) {
      await createSession()
      setInput(t.content)
      setShowSettings(false)
      showToast({ message: `已应用模板「${t.name}」`, kind: 'success', duration: 2500 })
    }
    return (
      <>
        <div class="settings-title">会话模板</div>
        <div class="settings-group">
          <div class="settings-group-title">已保存的模板</div>
          <div class="settings-card">
            <Show when={sessionTemplates().length === 0}>
              <div class="settings-row"><div class="settings-row-desc">暂无模板</div></div>
            </Show>
            <For each={sessionTemplates()}>
              {(t) => (
                <div class="settings-row">
                  <div class="settings-row-label">
                    <div class="settings-row-name">{t.name}</div>
                    <div class="settings-row-desc" style="white-space:pre-wrap;max-width:500px">
                      {t.content.slice(0, 160)}{t.content.length > 160 ? '…' : ''}
                    </div>
                  </div>
                  <div style="display:flex;gap:6px">
                    <button class="btn btn-primary" onClick={() => useTemplate(t)}>使用</button>
                    <button class="btn btn-ghost" style="color:#f87171" onClick={() => removeSessionTemplate(t.name)}>删除</button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">新建模板</div>
          <div class="settings-card">
            <div class="settings-row">
              <div style="flex:1;display:flex;flex-direction:column;gap:6px">
                <input class="login-input" placeholder="模板名称"
                  value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
                <textarea class="login-input" placeholder="模板内容（prompt 文本）"
                  style="min-height:120px;font-family:inherit"
                  value={newContent()} onInput={(e) => setNewContent(e.currentTarget.value)} />
                <button class="btn btn-primary" disabled={!newName().trim() || !newContent().trim()}
                  onClick={saveNew}>保存模板</button>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ─── SettingsUsage（Token 用量 dashboard）────────────────────────────
  function SettingsUsage() {
    const totalInput  = createMemo(() => sessions().reduce((sum, s) => sum + (s.inputTokens  ?? 0), 0))
    const totalOutput = createMemo(() => sessions().reduce((sum, s) => sum + (s.outputTokens ?? 0), 0))
    const byMode = createMemo(() => {
      const stats: Record<string, { in: number; out: number; count: number }> = {}
      for (const s of sessions()) {
        const k = s.uiMode ?? 'code'
        if (!stats[k]) stats[k] = { in: 0, out: 0, count: 0 }
        stats[k].in  += s.inputTokens  ?? 0
        stats[k].out += s.outputTokens ?? 0
        stats[k].count++
      }
      return stats
    })
    const topSessions = createMemo(() =>
      [...sessions()]
        .sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)))
        .slice(0, 10)
    )
    return (
      <>
        <div class="settings-title">Token 用量</div>
        <div class="settings-group">
          <div class="settings-group-title">累计用量</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">输入 tokens</div>
                <div class="settings-row-desc">所有会话累计（流入 LLM 的 token）</div>
              </div>
              <div style="font-size:24px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">
                {totalInput().toLocaleString()}
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">输出 tokens</div>
                <div class="settings-row-desc">所有会话累计（LLM 生成的 token）</div>
              </div>
              <div style="font-size:24px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">
                {totalOutput().toLocaleString()}
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">合计</div>
                <div class="settings-row-desc">input + output</div>
              </div>
              <div style="font-size:28px;font-weight:700;color:var(--text-base);font-variant-numeric:tabular-nums">
                {(totalInput() + totalOutput()).toLocaleString()}
              </div>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">按模式分布</div>
          <div class="settings-card">
            <For each={Object.entries(byMode())}>
              {([mode, stats]) => (
                <div class="settings-row">
                  <div class="settings-row-label">
                    <div class="settings-row-name">{mode === 'chat' ? 'Chat' : 'Code'} 模式</div>
                    <div class="settings-row-desc">{stats.count} 个会话</div>
                  </div>
                  <div style="font-family:monospace;font-size:13px;color:var(--text-base)">
                    {stats.in.toLocaleString()} in · {stats.out.toLocaleString()} out
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Top 10 会话（按 token 消耗）</div>
          <div class="settings-card">
            <For each={topSessions()}>
              {(s) => (
                <div class="settings-row">
                  <div class="settings-row-label">
                    <div class="settings-row-name">{s.title || s.id.slice(0, 8)}</div>
                    <div class="settings-row-desc">{new Date(s.updatedAt).toLocaleString('zh-CN')} · {s.messageCount} 条</div>
                  </div>
                  <div style="font-family:monospace;font-size:12px;color:var(--text-muted)">
                    {((s.inputTokens ?? 0) + (s.outputTokens ?? 0)).toLocaleString()} tokens
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </>
    )
  }

  // ─── SettingsErrors（错误日志）──────────────────────────────────────
  function SettingsErrors() {
    return (
      <>
        <div class="settings-title">错误日志</div>
        <div class="settings-group">
          <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>最近 50 条</span>
            <Show when={errorLog().length > 0}>
              <button class="btn btn-ghost" onClick={() => setErrorLog([])}>清空</button>
            </Show>
          </div>
          <div class="settings-card">
            <Show when={errorLog().length === 0}>
              <div class="settings-row"><div class="settings-row-desc">暂无错误</div></div>
            </Show>
            <For each={errorLog()}>
              {(err) => (
                <div class="settings-row">
                  <div class="settings-row-label" style="min-width:0">
                    <div class="settings-row-name" style="color:#f87171">
                      [{err.source}] {err.message.slice(0, 200)}
                    </div>
                    <div class="settings-row-desc">
                      {new Date(err.ts).toLocaleString('zh-CN')}
                      {err.sessionId ? ` · session: ${err.sessionId.slice(0, 8)}` : ''}
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </>
    )
  }

  // ─── 更新日志（每发一版往前 unshift）──────────────────────────────────
  interface ChangelogEntry {
    version: string
    date:    string
    changes: string[]
  }
  const CHANGELOG: ChangelogEntry[] = [
    {
      version: '0.2.10',
      date: '2026-04-24',
      changes: [
        '🛡 修复：AI 修改代码会覆盖用户在其他 IDE 的手改（"写了 A/B 两个方法→我手改了→让 AI 优化 A→A/B 的手改都被删"）',
        '🛡 根因：FileTime.assert 只能拦"没读"或"读完后被外部改过"，拦不住"AI 读了但继续用旧脑子里的内容整体覆盖"',
        '🛡 write_to_file 新增 stale-overwrite 检测：对已存在文件，对比新内容 vs 磁盘现状；如果删除行数 > 10 且 > 新增行数的 2 倍 → 拦截',
        '🛡 拦截消息直接告诉 AI："用 edit/multiedit 做局部修改，不要 write_to_file 整体重写"',
        '🛡 系统提示词加硬规则：修改已存在文件一律用 edit/multiedit；write_to_file 仅限新建文件或用户明确要求整体重写',
        '🛡 TOOL SELECTION 表改注："改已存在文件的局部" → edit，"创建新文件" → write_to_file，明确写上"write_to_file 使用禁区"',
      ],
    },
    {
      version: '0.2.9',
      date: '2026-04-23',
      changes: [
        '📊 默认 CONTEXT_WINDOW 调回 1M（Qwen3-coder-plus / Claude 1M / Qwen-max-longcontext 标准）',
        '📊 L1 剪枝阈值 550K（55%），L2 总结阈值 850K（85%），跟 v0.2.0~v0.2.7 保持一致',
        '📊 小模型用户（Qwen-plus 128K 等）设 MAXIAN_CONTEXT_WINDOW=128000 环境变量即可',
        '💡 澄清：token_usage 的 used 字段是模型 tokenizer 真实计算结果（非估算），inputTokens = 整个对话历史 + system prompt 的真实长度',
      ],
    },
    {
      version: '0.2.8',
      date: '2026-04-23',
      changes: [
        '📊 修复：上下文进度条到头但实际没压缩 —— 进度条 limit（硬编码 200K）和压缩阈值（600K/850K）不一致',
        '📊 后端 CONTEXT_WINDOW 默认改为 128K（Qwen-plus / GPT-4o / Claude Sonnet 标准），阈值 L1=55%、L2=85% 跟着动',
        '📊 支持环境变量覆盖：MAXIAN_CONTEXT_WINDOW / MAXIAN_COMPACT_L1_THRESHOLD / MAXIAN_COMPACT_L2_THRESHOLD（1M context 模型设 MAXIAN_CONTEXT_WINDOW=1000000）',
        '📊 后端 token_usage 事件上报的 limit 字段跟 CONTEXT_WINDOW 一致（之前硬编码 200K）',
        '📊 前端接收后端上报的 limit 动态设置 tokenLimit（之前硬编码 200K 独立一份）',
        '📊 效果：进度条真实反映当前模型窗口占用率；到 55% 触发 L1 压缩；触发前不会出现"进度条满但未压缩"的错觉',
      ],
    },
    {
      version: '0.2.7',
      date: '2026-04-23',
      changes: [
        '🧠 修复：same_error_loop 导致 AI 误判"文件损坏"并螺旋升级（换工具绕过）',
        '🧠 A. 重写 block 文案：从"🔴 same_error_loop 签名 XXX"改为第二人称直接指令"🚫 你已经用相同参数调用 read_file 失败了 3 次 + 原因排查清单 + 禁止换工具绕过"',
        '🧠 A. 按工具类型定制排查清单：read_file 提示用 glob 搜、edit 提示先 read_file 重读、execute_command 提示 Windows 命令等价等',
        '🧠 B. 原始错误透传：存最近 3 次完整 error（每次前 500 字），在 block 消息里全部返给 AI（之前只给 100 字签名让 AI 猜）',
        '🧠 D. readFileTool 首次失败就引导：根据父目录是否存在 / ENOENT / EACCES / EISDIR / 编码错误 给出针对性提示，指向正确工具（glob / list_files），避免 AI 原参数重试',
      ],
    },
    {
      version: '0.2.6',
      date: '2026-04-23',
      changes: [
        '🛑 修复：思考阶段点停止后端 AI 还在输出 —— 对照码弦 IDE 实现，前端缺少"事件硬隔离"',
        '🛑 后端 cancelTask 触发后立刻 emit task_aborted + task_status:aborted 给前端',
        '🛑 前端收到 task_aborted → 立刻 setSending(false)、收尾所有 isPartial 消息、清 rateLimit',
        '🛑 全局 _abortedAt 时间戳：abort 后 1500ms 内的 reasoning_delta / assistant_message / tool_input_delta / tool_call_start / tool_call_result / tool_output_chunk / todos_updated 全部静默丢弃（防 SSE buffer 残留事件继续显示）',
        '🛑 新任务发送时自动 reset _abortedAt=0',
        '🛑 完整 stop 链路 = AbortController.abort() + POST /ai/proxy/stop/{id} + task_aborted 广播 + 前端事件丢弃，对照码弦 IDE 三层防线齐全',
      ],
    },
    {
      version: '0.2.5',
      date: '2026-04-23',
      changes: [
        '🛑 修复：思考过程中点"停止"按钮无效，AI 仍继续输出',
        '🛑 根因：原 cancel 检查只在两块 chunk 之间生效，但思考流的 chunk 可能间隔几秒（R1/QwQ 慢思考），await 阻塞期间 cancel 完全无感',
        '🛑 新增 active handler 注册表：sessionId → 当前正在 LLM 流的 AiProxyHandler',
        '🛑 sessionManager.onCancel 注册全局 hook：cancelTask 一触发就主动调 handler.stopCurrentRequest() → AbortController.abort() → fetch 立刻抛 AbortError → for-await 立即退出',
        '🛑 主路径 + 限流重试路径两个 for-await 都加 register/finally 包裹，确保 abort 能命中',
      ],
    },
    {
      version: '0.2.4',
      date: '2026-04-23',
      changes: [
        '📜 修复：向上翻聊天历史时，新任务的流式消息会强制把页面滚回底部，打断阅读',
        '📜 新增 stickToBottom 跟踪：仅当用户在底部 80px 内时才自动滚到底，否则保持当前阅读位置',
        '📜 切换会话 / 用户主动发消息 → 重置 stickToBottom=true，下次消息自动滚底（符合预期）',
        '📜 SSE 事件处理路径改用 maybeScrollToBottom()，不再无条件 scrollIntoView',
      ],
    },
    {
      version: '0.2.3',
      date: '2026-04-22',
      changes: [
        '🔌 修复：关闭 app 再启动连不上服务（需手动 kill node 进程）',
        '🔌 Tauri 主端：监听 WindowEvent::CloseRequested 关窗即 kill sidecar（原来只在 RunEvent::Exit 里 kill，关 × 根本不触发）',
        '🔌 硬 kill 升级：Windows 用 taskkill /T /F 杀进程树，Unix 先 SIGTERM 释放端口→250ms 后 SIGKILL 保底',
        '🔌 maxian-server 优雅关闭升级：listener.stop(false) 立即 close socket，2s 超时+3s 硬退出，保证端口一定释放',
        '🔌 启动前端口探活：能连 /health=200 就直接复用已有 sidecar，不再重复 spawn',
        '🔌 双重保险：CloseRequested + RunEvent::Exit 两条路径都 kill，任一触发都能杀干净',
      ],
    },
    {
      version: '0.2.2',
      date: '2026-04-22',
      changes: [
        '🛑 修复：点"结束"按钮后任务不停止 —— cancelTask 只设了内部 flag，agent loop 从不检查',
        '🛑 runAgentLoop 三处检查点：每轮迭代开始前、LLM 流式输出每一块、工具执行前',
        '🛑 流中取消时调用 AiProxyHandler.stopCurrentRequest() 立即 AbortController 中止 HTTP 请求',
        '🛑 cancelTask 同时唤醒挂起的 question / plan_exit / approval 对话框（不然会一直 await）',
        '🔁 runAgentLoop 开头自动 reset cancelled 标志，避免上次任务的 cancel 状态影响新任务启动',
      ],
    },
    {
      version: '0.2.1',
      date: '2026-04-22',
      changes: [
        '💰 E. Prompt 静态/动态分离：静态规则前置（哈希稳定），动态信息（workspacePath/platform/项目配置/skills）附加末尾',
        '💰 DashScope/Qwen 的隐式前缀缓存现在能可靠命中 → 长对话 token 成本预计降低 40-60%',
        '💰 新增静态段哈希追踪日志：每次调用打出「静态 prompt 前缀哈希一致」→ 直观看到缓存状态',
        '🗜 F. contextCompaction 精细化占位符：从「已清理 edit 第 3/5 次（1200 字）」升级为「已清理 edit 第 3/5 次 | path=src/foo.ts | 结果摘要：Successfully edited ...」',
        '🗜 保留工具名 + 序号 + 关键参数（path/command/pattern 等）+ 结果首 60% + 尾 40%（约 200 字）',
        '🗜 每种工具专属参数摘要规则（read_file 取 path、bash 取 command、grep 取 pattern+path、web_fetch 取 url）',
      ],
    },
    {
      version: '0.2.0',
      date: '2026-04-22',
      changes: [
        '🎯 Edit 工具启用 9-strategy 级联匹配（对标 OpenCode）：SimpleReplacer / LineTrimmed / BlockAnchor（Levenshtein 距离）/ WhitespaceNormalized / IndentationFlexible / EscapeNormalized / TrimmedBoundary / ContextAware / MultiOccurrence',
        '📈 编辑成功率预估提升 2-3x —— AI 生成缩进差 2 空格、混用 tab/space、多/少空行的 old_string 都能匹配成功',
        '🛡 FileTime.assert() 文件陈旧检测：read 时记录 mtime+size，edit 前验证"必须读过"+"未被外部改过"，消除一整类"陈旧内容覆盖用户编辑"bug',
        '⚡ 工具执行三层调度：只读工具全部并行；不同文件的破坏性工具并行，同文件串行；bash/execute_command 全局串行',
        '🤖 Agent-specific prompts：新增 explore 子 agent 模式（精简 prompt + 只读工具集），task 工具派发 subagentType=explore 时自动启用',
        '🧹 session 删除时自动清理 FileTime 内部状态，防止长期运行内存泄漏',
      ],
    },
    {
      version: '0.1.3',
      date: '2026-04-22',
      changes: [
        '🪟 Windows / Linux 隐藏自定义标题栏，改用系统原生标题栏（修复双标题栏重叠）',
        '🔓 Tauri HTTP 插件白名单放行任意 http/https host，修复打包后内网 HTTP 后端登录被拦',
        '💬 登录错误提示显示真实原因（plugin-http 权限拒绝 / 网络不通 / 账号密码错误）而不是固定 fallback',
        '📦 Sidecar 机制：maxian-server 用 Bun --compile 打包成 58MB 单文件二进制',
        '🎯 跨平台支持：Tauri externalBin 自动按平台选 bin，用户无需单独装 Node.js',
        '🚀 GitHub Actions CI：macOS(arm64/x64) + Windows + Linux 四平台矩阵自动打包',
        '💿 macOS DMG 用 hdiutil 手工打包（绕开 create-dmg 中文 productName 的 bug）',
        '📏 Node.js 20 → 22 LTS，加 FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 消除 deprecation 警告',
      ],
    },
    {
      version: '0.1.1',
      date: '2026-04-22',
      changes: [
        '🔗 聊天里 `file.ext:42` 自动识别成可点击链接，点击直接在预览面板打开并高亮定位到指定行',
        '📥 Markdown 代码块新增"应用到文件…"按钮：选择目标路径 / 覆盖 or 追加 / 实时预览内容后一键写入',
        '🔍 会话内 Cmd+F / Ctrl+F 搜索：实时命中计数（n/N）、Enter 下一个、Shift+Enter 上一个、Esc 关闭',
        '👀 预览面板外部变更检测：每 3s 轮询 mtime，检测到外部修改显示黄色 banner（重新加载 / 忽略）',
        '💡 AI followup 建议区块：chat 模式下 AI 可通过 `<<<FOLLOWUP>>>` 追加建议问题，前端渲染为可点击按钮',
        '⚡ 消息列表软截断：超过 600 条只渲染最近 600 条，顶部"展开全部"按钮（避免超长会话卡顿）',
        '📚 插件开发完整文档 + 设置页"插件开发"标签：一键打开 `~/.maxian/plugins/`、复制文档到剪贴板',
        '▶️ bash / execute_command 实时流式输出：工具卡片内嵌终端面板，stdout/stderr 实时刷新 + 绿色呼吸灯 + 自动滚动到底',
        '🧹 ANSI 色码自动剥离 + `TERM=dumb / NO_COLOR=1 / FORCE_COLOR=0` 环境变量保护',
        '🛰 dev server 智能托管：识别 `npm/yarn/pnpm dev|start|watch`、`vite`、`next dev`、`tail -f`、`nodemon` 等模式，3 秒空闲即 detach，进程后台继续运行不被杀',
        '🔁 限流重试正则扩展：覆盖 429 / rate limit / too many requests / throttled / capacity limits / InternalError.Algo，真正重试满 3 次',
        '♻️ AiProxyHandler 实例池复用（按 apiUrl + username + businessCode 缓存），修复每请求 new 实例导致客户端缓存统计永远 0% 的 bug',
        '💓 SSE 心跳 keepalive（服务端每 15s）：防止限流静默期被代理/防火墙/HTTP idle 断连',
        '🩺 任务卡死 watchdog：60s 未收到任何 SSE 事件时自动补拉消息快照，避免"回复中"卡壳需手动切会话',
        '🧼 错误事件智能收尾：所有 isPartial 的 reasoning/tool/assistant 统一标记完成 + 清除 rateLimit 残留状态',
        '💾 修复历史思考过程不显示：isChatMode 不再短路 reasoning 持久化（messages / history 两表解耦）',
        '🖱 修复 reasoning/tool 流式更新时滚动条被重置：viewGroups wrapper 引用缓存，msg 引用不变则复用，For 不重建 DOM',
        '📏 思考过程块移除 280px 高度限制 + 内部滚动条，完整展开随页面滚动',
      ],
    },
    {
      version: '0.1.0',
      date: '2026-04-22',
      changes: [
        '🎯 read_file 专业化：图片直接以 data URL 渲染、PDF 提示、超长行 2000 字符截断',
        '🔧 LSP 新增 4 个编辑动作：rename / codeAction / formatDocument / organizeImports',
        '📋 edit 工具返回 LSP 诊断摘要（error/warning 前 20 条）+ 自动保留 CRLF 行尾符',
        '🗜 上下文压缩进度 banner（实时耗时 + 级别提示）+ 完成系统消息',
        '⚙️  项目级配置 .maxian/config.json + 自定义 agent/command（.maxian/agents|commands/*.md）',
        '🔌 Plugin 生命周期 hooks：tool.execute.before/after、session.created、message.sent、agent.iteration',
        '💬 消息操作：编辑重跑、重新生成、从消息 fork 新会话、删除单条',
        '📌 会话归档/置顶 + 独立归档视图',
        '🎹 全局 ⌘P 命令面板：搜索会话/文件/符号/斜杠命令',
        '🔍 符号搜索（LSP workspaceSymbol + 文件名 fallback）',
        '⌨️  自定义快捷键 UI：录制按键 + 重置默认',
        '📄 会话模板系统（localStorage 持久化）',
        '📊 Token 用量 dashboard + 错误日志页',
        '🖱 Vim 模式（h/j/k/l/i/a/o/x/D/p/w/b/0/$ 基础 modal 编辑）',
        '🏷 消息时间戳显示（yyyy-mm-dd hh:mm:ss）hover 高亮',
        '📁 工具调用显示完整 diff + 点击跳转预览面板',
        '🔐 Tauri 签名 & 增量更新包配置',
      ],
    },
    {
      version: '0.0.9',
      date: '2026-04-21',
      changes: [
        '🧠 上下文自动压缩（1M 窗口）：Level 1 按工具类型剪枝 + Level 2 LLM 总结',
        '/compact 斜杠命令手动触发压缩',
        '💾 Tool / reasoning / assistant 全部持久化到 DB（切会话完整还原）',
        '📡 流式 tool input 推送：实时看到工具 JSON 生成进度（修累积 delta 翻倍 bug）',
        '⚡ 工具并行执行（只读并行 + 破坏性串行）',
        '📖 AGENTS.md / CLAUDE.md 自动加载到 system prompt',
        '🌟 Skills 列表预注入 system prompt（AI 知道有哪些技能可用）',
        '🔁 doom-loop 检测接入（ToolRepetitionDetector 字节级+窗口+签名三重保护）',
      ],
    },
    {
      version: '0.0.8',
      date: '2026-04-21',
      changes: [
        '🛠 新增 9 个工具：bash / grep / glob / ls / apply_patch / lsp（完整 LSP）/ question / plan_exit / task（子 Agent）',
        '🧩 Plugin 系统（~/.maxian/plugins/*.js 动态加载）',
        '🔒 per-tool 权限记忆（session + 全局 Always Allow）',
        '💡 工具输出截断服务（2000 行/50KB 写盘避免 token 爆炸）',
        '🎛 会话搜索 + 消息过滤器 + 权限记忆 + 快捷键速查面板 ⌘/',
        '🎨 diff 视图 Split/Unified 切换 + 预览标签拖拽重排',
        '🔔 Toast 带 action 按钮 + 动画数字计数器',
        '📈 Prompt 历史上下箭头 + 消息 j/k 键盘导航',
      ],
    },
    {
      version: '0.0.7',
      date: '2026-04-21',
      changes: [
        '📄 文件预览面板：语法高亮（highlight.js）+ Diff + Image + Markdown 多视图',
        '🗂 工作区文件浏览器（层级树 + 搜索）',
        '⭐ Skills 面板（.maxian/skills + .claude/skills 扫描，frontmatter 解析）',
        '💓 心跳服务（每 60s POST /knowledge/userOnline/heartbeat）',
        '📝 AI 调用日志推送（POST /ai/call-log）',
      ],
    },
    {
      version: '0.0.6',
      date: '2026-04-21',
      changes: [
        '🎬 OpenCode 风格功能对标首批：权限审批、文件变更面板、文件快照/撤销、Context 条',
        '🔀 Git Worktree 管理 + 分支切换',
        '🖥 集成终端（xterm.js + node-pty）多标签',
        '🔄 自动更新（tauri-plugin-updater）',
        '🌍 i18n（中/英）+ Plan 模式（只规划不执行）',
        '⌘+ 快捷键体系（N/W/[/]/K/`/,）',
        '🖼 图片粘贴/拖拽作为多模态输入',
      ],
    },
  ]

  // ─── SettingsPlugins：插件开发文档（P1-14）────────────────────────────────
  const PLUGIN_DEV_MD = `# 码弦（Maxian）插件开发指南

## 1. 插件存放位置

所有插件放在 \`~/.maxian/plugins/\`：

- **单文件插件**：\`*.js\` / \`*.mjs\` / \`*.cjs\`（如 \`~/.maxian/plugins/my-plugin.mjs\`）
- **目录插件**：目录下含 \`package.json\`（\`main\` 字段指向入口），入口必须是 ESM 格式

服务端启动时自动扫描加载；加载失败不会中断服务。

## 2. 插件模块结构

\`\`\`js
export default {
  name:    'my-plugin',
  version: '1.0.0',

  // 自定义工具（AI Agent 可调用）
  tools: [
    {
      name:        'hello_world',
      description: '打印问候语；参数 name: 收件人名字',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async execute(params, ctx) {
        return \`你好, \${params.name}！\`;
      },
    },
  ],

  // 生命周期 Hooks（可选）
  hooks: {
    async 'session.created'(ctx) {
      console.log('新会话:', ctx.sessionId);
    },
    async 'tool.execute.before'(ctx) {
      // 返回 false 可取消该工具调用
      if (ctx.toolName === 'bash' && String(ctx.params.command).includes('rm -rf /')) {
        return false;
      }
    },
  },
};
\`\`\`

## 3. 工具规范

| 字段 | 类型 | 说明 |
|------|------|------|
| \`name\` | string | 工具名（snake_case，不能与内置工具重名） |
| \`description\` | string | 给 AI 看的工具用途 |
| \`parameters\` | JSONSchema | 参数 Schema（\`type: 'object'\` + \`properties\` + \`required\`） |
| \`execute\` | function | \`(params, ctx) => Promise<string\\|unknown>\` |

**返回值**：字符串直接作为工具输出；对象会 \`JSON.stringify\`；抛异常转为错误字符串。

## 4. Hooks 事件

| 事件 | 触发时机 | Context | 特殊行为 |
|------|---------|---------|----------|
| \`session.created\` | 新会话创建 | \`{ sessionId }\` | — |
| \`message.sent\` | 用户消息发送 | \`{ sessionId, content }\` | — |
| \`tool.execute.before\` | 工具执行前 | \`{ toolName, params, sessionId }\` | 返回 \`false\` 可取消 |
| \`tool.execute.after\` | 工具执行后 | \`{ toolName, params, result, success, sessionId }\` | — |
| \`agent.iteration\` | 每轮迭代结束 | \`{ sessionId, iter, toolCalls }\` | — |

## 5. 示例：埋点插件

\`\`\`js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const logFile = path.join(os.homedir(), '.maxian', 'agent-metrics.jsonl');

export default {
  name: 'metrics-logger',
  version: '0.1.0',
  tools: [],
  hooks: {
    async 'agent.iteration'(ctx) {
      const row = { ts: Date.now(), ...ctx };
      try { await fs.appendFile(logFile, JSON.stringify(row) + '\\n', 'utf8'); } catch {}
    },
  },
};
\`\`\`

## 6. 示例：HTTP 查询工具

\`\`\`js
export default {
  name: 'http-fetch-plugin',
  version: '0.1.0',
  tools: [
    {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      async execute({ city }) {
        const res = await fetch(\`https://wttr.in/\${encodeURIComponent(city)}?format=%l:+%C+%t+%w\`);
        if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
        return await res.text();
      },
    },
  ],
};
\`\`\`

## 7. 安全与限制

- 插件在服务端 Node.js 进程中运行，拥有完整 FS/网络/子进程权限——只加载信任的插件
- 不要在 hook 中触发新的工具调用（可能无限递归）
- 工具名与内置工具冲突时，**内置工具优先**，插件工具会被忽略
- 不建议在 \`tool.execute.before\` 做重计算（会阻塞工具调用）

## 8. 调试建议

1. 启动时观察控制台：\`[Plugin] 加载 N 个插件\`
2. 若加载失败，插件管理列表的 \`error\` 字段会显示错误信息
3. ESM 格式要求：\`.mjs\` 或 \`package.json\` 里 \`"type": "module"\`

## 内置工具清单（请勿重名）

\`read_file\`, \`write_to_file\`, \`edit_file\`, \`multiedit_file\`, \`list_files\`, \`search_files\`, \`grep_search\`, \`bash\`, \`todo_write\`, \`web_fetch\`, \`web_search\`, \`lsp\`, \`load_skill\`, \`update_todo_list\`, \`ask_followup_question\`, \`plan_exit\`
`

  function SettingsPlugins() {
    const [pluginDir] = createSignal<string>('~/.maxian/plugins/')
    async function openPluginDir() {
      try {
        const { Command } = await import('@tauri-apps/plugin-shell' as any)
        const home = (await import('@tauri-apps/api/path' as any)).homeDir
          ? await (await import('@tauri-apps/api/path' as any)).homeDir()
          : ''
        const target = `${home}/.maxian/plugins/`
        // macOS open; Windows start; Linux xdg-open
        const cmd = new Command('open', [target])
        await cmd.execute()
      } catch (e) {
        showToast({ message: '打开目录失败：请手动定位 ~/.maxian/plugins/', kind: 'warn' })
      }
    }
    async function copyDevDoc() {
      try {
        await navigator.clipboard.writeText(PLUGIN_DEV_MD)
        showToast({ message: '插件开发文档已复制到剪贴板', kind: 'success', duration: 2000 })
      } catch {
        showToast({ message: '复制失败', kind: 'error' })
      }
    }
    return (
      <div class="settings-page">
        <h3>插件开发</h3>
        <div class="settings-section">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <button class="btn btn-primary" onClick={openPluginDir}>📁 打开插件目录</button>
            <button class="btn btn-ghost" onClick={copyDevDoc}>📋 复制完整文档</button>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
            插件目录：<code style="background:var(--bg-subtle);padding:1px 5px;border-radius:3px">{pluginDir()}</code>
          </div>
        </div>
        <div
          class="md markdown-body"
          style="font-size:13px;line-height:1.7;padding:12px 14px;background:var(--bg-subtle);border-radius:8px;max-height:68vh;overflow:auto"
          innerHTML={renderMarkdown(PLUGIN_DEV_MD)}
        />
      </div>
    )
  }

  function SettingsAbout() {
    const [updateStatus, setUpdateStatus] = createSignal<'idle' | 'checking' | 'available' | 'none' | 'installing' | 'error'>('idle')
    const [updateMsg, setUpdateMsg] = createSignal("")

    async function checkForUpdates() {
      setUpdateStatus('checking')
      setUpdateMsg("")
      try {
        if ((window as any).__TAURI_INTERNALS__) {
          const { check } = await import('@tauri-apps/plugin-updater' as any)
          const update = await check()
          if (update?.available) {
            setUpdateStatus('available')
            setUpdateMsg(`发现新版本 ${update.version}：${update.body ?? ''}`)
          } else {
            setUpdateStatus('none')
            setUpdateMsg("已是最新版本")
          }
        } else {
          setUpdateStatus('none')
          setUpdateMsg("浏览器环境不支持自动更新")
        }
      } catch (e) {
        setUpdateStatus('error')
        setUpdateMsg(String((e as Error)?.message ?? e))
      }
    }

    async function installUpdate() {
      setUpdateStatus('installing')
      try {
        const { check } = await import('@tauri-apps/plugin-updater' as any)
        const update = await check()
        if (update?.available) {
          await update.downloadAndInstall()
          // 安装完成后重启
          const { relaunch } = await import('@tauri-apps/plugin-process' as any)
          await relaunch()
        }
      } catch (e) {
        setUpdateStatus('error')
        setUpdateMsg(String((e as Error)?.message ?? e))
      }
    }

    return (
      <>
        <div class="settings-title">关于</div>
        <div style="display:flex;flex-direction:column;align-items:center;padding:32px 0 24px;gap:12px">
          <img class="about-logo" src={logoUrl} alt="Maxian" />
          <div style="font-size:20px;font-weight:700;color:var(--text-base)">码弦 Maxian</div>
          <div style="font-size:13px;color:var(--text-muted)">智能 AI 编程助手</div>
          <div style="font-size:12px;color:var(--text-faint)">版本 0.2.10</div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">软件更新</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">检查更新</div>
                <div class="settings-row-desc">
                  <Show when={updateMsg()}>
                    <span style={updateStatus() === 'error' ? 'color:var(--error)' : updateStatus() === 'available' ? 'color:var(--accent)' : 'color:var(--text-muted)'}>
                      {updateMsg()}
                    </span>
                  </Show>
                  <Show when={!updateMsg()}>
                    当前版本 0.2.10
                  </Show>
                </div>
              </div>
              <div style="display:flex;gap:6px">
                <Show when={updateStatus() === 'available'}>
                  <button class="btn btn-primary" style="font-size:11px" onClick={installUpdate}>
                    立即更新
                  </button>
                </Show>
                <button
                  class="btn btn-ghost"
                  style="font-size:11px"
                  onClick={checkForUpdates}
                  disabled={updateStatus() === 'checking' || updateStatus() === 'installing'}
                >
                  <Show when={updateStatus() === 'checking'} fallback="检查更新">
                    <span class="spinner" style="width:10px;height:10px;border-width:1.5px" />
                    检查中…
                  </Show>
                  <Show when={updateStatus() === 'installing'}>
                    安装中…
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">更新日志</div>
          <div class="settings-card">
            <For each={CHANGELOG}>
              {(entry, i) => (
                <div class="changelog-entry" classList={{ latest: i() === 0 }}>
                  <div class="changelog-header">
                    <span class="changelog-version">v{entry.version}</span>
                    <Show when={i() === 0}>
                      <span class="changelog-latest-badge">最新</span>
                    </Show>
                    <span class="changelog-date">{entry.date}</span>
                  </div>
                  <ul class="changelog-list">
                    <For each={entry.changes}>
                      {(c) => <li>{c}</li>}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">开源信息</div>
          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">构建于</div>
                <div class="settings-row-desc">Tauri 2 · SolidJS · Hono · Claude Sonnet</div>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row-label">
                <div class="settings-row-name">版权</div>
                <div class="settings-row-desc">© 2025 天和智开 All rights reserved</div>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ─── Sidebar ──────────────────────────────────────────────────────────────
  function toggleGroupCollapse(wsId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  // ─── 会话条目（chat/code 通用） ──────────────────────────────────────────────
  function SessionItem(props: { s: SessionSummary }) {
    const s = props.s
    return (
      <div
        class="session-item"
        classList={{ active: activeSessionId() === s.id && !showSettings() }}
        onClick={() => { if (editingSessionId() !== s.id) selectSession(s.id) }}
      >
        {/* Status indicator */}
        <div class="session-status">
          <Show
            when={s.status === "running"}
            fallback={
              <div
                class="session-status-dot"
                classList={{ error: s.status === "error", done: s.status === "done" }}
              />
            }
          >
            <div class="session-status-spinner" />
          </Show>
        </div>

        {/* Title or rename input (双击标题直接改名) */}
        <Show
          when={editingSessionId() === s.id}
          fallback={
            <span
              class="session-title"
              onDblClick={(e) => startRenameSession(e, s)}
            >{s.title || s.id.slice(0, 8)}</span>
          }
        >
          <input
            class="rename-input"
            value={editingSessionTitle()}
            onInput={(e) => setEditingSessionTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter")  commitRenameSession(s.id)
              if (e.key === "Escape") cancelRenameSession()
            }}
            onBlur={() => commitRenameSession(s.id)}
            onClick={(e) => e.stopPropagation()}
            ref={(el) => { setTimeout(() => { el?.focus(); el?.select() }, 10) }}
          />
        </Show>

        {/* 置顶图标（始终显示，已置顶才亮） */}
        <Show when={s.pinned}>
          <span class="session-pin-badge" title="已置顶">📌</span>
        </Show>
        <Show when={s.archived}>
          <span class="session-archive-badge" title="已归档">🗃</span>
        </Show>

        {/* Hover actions */}
        <div class="session-item-actions">
          <button
            class="item-action-btn"
            onClick={(e) => { e.stopPropagation(); togglePinSession(s.id, !s.pinned) }}
            title={s.pinned ? "取消置顶" : "置顶"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={s.pinned ? "var(--accent)" : "currentColor"} stroke-width="2">
              <line x1="12" y1="17" x2="12" y2="22"/>
              <path d="M5 17h14a2 2 0 0 0 1.84-2.75L17 7h-10L3.16 14.25A2 2 0 0 0 5 17z"/>
            </svg>
          </button>
          <button
            class="item-action-btn"
            onClick={(e) => { e.stopPropagation(); toggleArchiveSession(s.id, !s.archived) }}
            title={s.archived ? "取消归档" : "归档"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="21 8 21 21 3 21 3 8"/>
              <rect x="1" y="3" width="22" height="5"/>
              <line x1="10" y1="12" x2="14" y2="12"/>
            </svg>
          </button>
          <button
            class="item-action-btn"
            onClick={(e) => startRenameSession(e, s)}
            title="重命名"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button
            class="item-action-btn del"
            onClick={(e) => deleteSession(e, s.id)}
            title="删除"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
      </div>
    )
  }

  function Sidebar() {
    const user = currentUser()

    // chat 模式下的平铺会话列表（置顶优先，按时间降序）+ 搜索 + 归档过滤
    const chatSessions = createMemo(() => {
      const q = sessionSearch().trim().toLowerCase()
      return sessions()
        .filter(s => (s.uiMode ?? 'code') === 'chat')
        .filter(s => showArchived() ? !!s.archived : !s.archived)
        .filter(s => !q || (s.title ?? '').toLowerCase().includes(q))
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
    })

    return (
      <aside class="sidebar">
        {/* Header */}
        <div class="sidebar-header">
          {/* 分段模式切换 */}
          <div class="mode-segmented">
            <button
              class="mode-seg-btn"
              classList={{ active: globalMode() === 'chat' }}
              onClick={() => setGlobalMode('chat')}
              title="Chat — 智能对话"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Chat
            </button>
            <button
              class="mode-seg-btn"
              classList={{ active: globalMode() === 'code' }}
              onClick={() => setGlobalMode('code')}
              title="Code — 智能编码 Agent"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
              Code
            </button>
          </div>

          {/* 右侧操作按钮 */}
          <div class="sidebar-actions">
            <Show when={globalMode() === 'chat'}>
              {/* Chat 模式：新建对话 */}
              <button class="icon-btn" onClick={createSession} title="新建对话 (⌘N)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            </Show>
            <Show when={globalMode() === 'code'}>
              {/* Code 模式：添加项目 */}
              <button class="icon-btn" onClick={pickFolder} title="添加项目">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
                </svg>
              </button>
            </Show>
          </div>
        </div>

        {/* 会话搜索 + 归档切换 */}
        <div class="sidebar-search-wrap">
          <svg class="sidebar-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            class="sidebar-search-input"
            placeholder={showArchived() ? "在归档里搜索…" : "搜索会话…"}
            value={sessionSearch()}
            onInput={(e) => setSessionSearch(e.currentTarget.value)}
          />
          <button
            class="sidebar-archive-toggle"
            classList={{ active: showArchived() }}
            onClick={() => setShowArchived(v => !v)}
            title={showArchived() ? "查看活跃会话" : "查看已归档"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="21 8 21 21 3 21 3 8"/>
              <rect x="1" y="3" width="22" height="5"/>
              <line x1="10" y1="12" x2="14" y2="12"/>
            </svg>
          </button>
          <Show when={sessionSearch()}>
            <button
              class="sidebar-search-clear"
              onClick={() => setSessionSearch('')}
              title="清除"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </Show>
        </div>

        {/* ── Chat 模式：平铺会话列表 ── */}
        <Show when={globalMode() === 'chat'}>
          <div class="sidebar-sessions">
            <Show when={chatSessions().length === 0}>
              <div class="sessions-empty-hint">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color:var(--text-faint)">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <span>点击 + 新建对话</span>
              </div>
            </Show>
            <For each={chatSessions()}>
              {(s) => <SessionItem s={s} />}
            </For>
          </div>
        </Show>

        {/* ── Code 模式：按工作区分组 ── */}
        <Show when={globalMode() === 'code'}>
          <div class="sidebar-sessions">
            <Show when={workspaces().length === 0 && sessions().filter(s => (s.uiMode ?? 'code') === 'code').length === 0}>
              <div class="sessions-empty-hint">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="color:var(--text-faint)">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>点击右上角 + 添加项目</span>
              </div>
            </Show>

            <For each={groupedSessions()}>
              {(group) => {
                const wsId = group.workspace?.id ?? group.workspacePath
                const isCollapsed = () => collapsedGroups().has(wsId)
                return (
                  <div class="session-group">
                    {/* Workspace group header */}
                    <div
                      class="session-group-header"
                      onClick={() => toggleGroupCollapse(wsId)}
                      title={group.workspacePath}
                    >
                      {/* Collapse arrow */}
                      <svg
                        class="group-collapse-arrow"
                        classList={{ collapsed: isCollapsed() }}
                        width="10" height="10" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" stroke-width="2.5"
                      >
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>

                      {/* Name or rename input */}
                      <Show
                        when={editingWorkspaceId() === group.workspace?.id}
                        fallback={
                          <span class="session-group-name">
                            {group.workspace?.name ?? shortPath(group.workspacePath)}
                          </span>
                        }
                      >
                        <input
                          class="rename-input"
                          value={editingWorkspaceName()}
                          onInput={(e) => setEditingWorkspaceName(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === "Enter")  commitRenameWorkspace(group.workspace!.id)
                            if (e.key === "Escape") cancelRenameWorkspace()
                          }}
                          onBlur={() => commitRenameWorkspace(group.workspace!.id)}
                          onClick={(e) => e.stopPropagation()}
                          ref={(el) => { setTimeout(() => { el?.focus(); el?.select() }, 10) }}
                        />
                      </Show>

                      {/* Hover actions: new session + rename */}
                      <Show when={group.workspace && editingWorkspaceId() !== group.workspace.id}>
                        <div class="session-group-actions">
                          <button
                            class="group-action-btn"
                            onClick={(e) => { e.stopPropagation(); createSessionInWorkspace(e, group.workspace!) }}
                            title="新建会话"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                          </button>
                          <button
                            class="group-action-btn"
                            onClick={(e) => { e.stopPropagation(); startRenameWorkspace(e, group.workspace!) }}
                            title="重命名项目"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                          <button
                            class="group-action-btn del"
                            onClick={(e) => deleteWorkspace(e, group.workspace!)}
                            title="移除项目"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                              <path d="M10 11v6"/><path d="M14 11v6"/>
                              <path d="M9 6V4h6v2"/>
                            </svg>
                          </button>
                        </div>
                      </Show>
                    </div>

                    {/* Sessions in this group (hidden when collapsed) */}
                    <Show when={!isCollapsed()}>
                      <For each={group.sessions}>
                        {(s) => <SessionItem s={s} />}
                      </For>
                      <Show when={group.sessions.length === 0 && group.workspace}>
                        <div class="session-group-empty">暂无会话</div>
                      </Show>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* Bottom: User (collapsible) */}
        <div class="sidebar-user">
          <Show when={user}>
            <div
              class="sidebar-user-collapsed"
              classList={{ expanded: userExpanded() }}
              onClick={() => setUserExpanded(v => !v)}
            >
              <div class="sidebar-user-avatar">{userInitials(user!)}</div>
              <span class="sidebar-user-name-min">{user!.nickName || user!.userName}</span>
              <svg
                class="sidebar-chevron"
                classList={{ up: userExpanded() }}
                width="12" height="12" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5"
              >
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </div>

            <Show when={userExpanded()}>
              <div class="sidebar-user-expanded">
                <div class="sidebar-user-details">
                  <div class="sidebar-user-avatar large">{userInitials(user!)}</div>
                  <div class="sidebar-user-text">
                    <div class="sidebar-user-fullname">{user!.nickName || user!.userName}</div>
                    <div class="sidebar-user-email">{user!.email || user!.userName}</div>
                  </div>
                </div>
                <div class="sidebar-user-actions">
                  <button
                    class="sidebar-action-btn"
                    classList={{ active: showSettings() }}
                    onClick={() => { setShowSettings(true); setSettingsTab("appearance"); setUserExpanded(false) }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    设置
                  </button>
                  <button class="sidebar-action-btn danger" onClick={handleLogout}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                      <polyline points="16 17 21 12 16 7"/>
                      <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    退出登录
                  </button>
                </div>
              </div>
            </Show>
          </Show>
        </div>
      </aside>
    )
  }

  // ─── ApprovalDialog ───────────────────────────────────────────────────────
  function ApprovalDialog() {
    const req = approvalRequest()
    if (!req) return null
    const isRisky = ['write_to_file', 'execute_command'].includes(req.toolName)
    return (
      <div class="approval-overlay">
        <div class="approval-dialog">
          <div class="approval-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isRisky ? "#f59e0b" : "#6366f1"} stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span class="approval-title">工具调用审批</span>
          </div>
          <div class="approval-body">
            <div class="approval-tool-name">{TOOL_LABELS[req.toolName] ?? req.toolName}</div>
            <div class="approval-params">
              {Object.entries(req.toolParams).slice(0, 3).map(([k, v]) => (
                <div class="approval-param-row">
                  <span class="approval-param-key">{k}</span>
                  <span class="approval-param-val">
                    {typeof v === 'string' ? (v.length > 100 ? v.slice(0, 100) + '…' : v) : JSON.stringify(v).slice(0, 100)}
                  </span>
                </div>
              ))}
            </div>
            <Show when={isRisky}>
              <div class="approval-risk-hint">⚠ 此操作可能修改文件或执行系统命令</div>
            </Show>
          </div>
          <div class="approval-footer approval-footer-3col">
            <button class="approval-btn deny" onClick={() => handleApprove(false)}>拒绝</button>
            <button class="approval-btn allow" onClick={() => handleApprove(true)}>允许一次</button>
            <button
              class="approval-btn allow-session"
              onClick={() => handleApprove(true, 'session')}
              title="本会话内后续此工具不再询问"
            >本会话允许</button>
            <button
              class="approval-btn allow-always"
              onClick={() => handleApprove(true, 'always')}
              title="所有会话永久允许此工具"
            >总是允许</button>
          </div>
        </div>
      </div>
    )
  }

  // ─── QuestionDialog（Agent 调用 question 工具时弹出） ──────────────────
  function QuestionDialog() {
    const req = questionRequest()
    if (!req) return null
    const toggleOption = (o: string) => {
      setQuestionSelected(prev => {
        if (req.multi) {
          return prev.includes(o) ? prev.filter(x => x !== o) : [...prev, o]
        }
        return prev.includes(o) ? [] : [o]
      })
    }
    return (
      <div class="approval-overlay">
        <div class="approval-dialog" style="max-width:560px;width:90vw">
          <div class="approval-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span class="approval-title">AI 请求澄清</span>
          </div>
          <div class="approval-body">
            <div style="white-space:pre-wrap;line-height:1.6;color:var(--text-base);font-size:13.5px;margin-bottom:12px">
              {req.question}
            </div>
            <Show when={req.options.length > 0}>
              <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
                <For each={req.options}>
                  {(o) => {
                    const checked = () => questionSelected().includes(o)
                    return (
                      <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--bg-subtle)"
                        classList={{ 'question-option-checked': checked() }}>
                        <input
                          type={req.multi ? 'checkbox' : 'radio'}
                          checked={checked()}
                          onChange={() => toggleOption(o)}
                          name="qq-opt"
                        />
                        <span style="flex:1;font-size:12.5px">{o}</span>
                      </label>
                    )
                  }}
                </For>
              </div>
            </Show>
            <textarea
              style="width:100%;min-height:60px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-subtle);font-size:12.5px;color:var(--text-base);outline:none;font-family:var(--font-sans);resize:vertical"
              placeholder={req.options.length > 0 ? '可选：补充说明…' : '回答…'}
              value={questionAnswer()}
              onInput={(e) => setQuestionAnswer(e.currentTarget.value)}
            />
          </div>
          <div class="approval-footer">
            <button class="approval-btn deny" onClick={() => handleAnswerQuestion(true)}>取消</button>
            <button
              class="approval-btn allow"
              disabled={questionAnswer().trim().length === 0 && questionSelected().length === 0}
              onClick={() => handleAnswerQuestion(false)}
            >提交</button>
          </div>
        </div>
      </div>
    )
  }

  // ─── PlanExitDialog（Agent 调用 plan_exit 工具时弹出） ───────────────
  function PlanExitDialog() {
    const req = planExitRequest()
    if (!req) return null
    return (
      <div class="approval-overlay">
        <div class="approval-dialog" style="max-width:640px;width:90vw;max-height:80vh;display:flex;flex-direction:column">
          <div class="approval-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            <span class="approval-title">AI 计划已就绪 — 是否切换到 Build 模式执行？</span>
          </div>
          <div class="approval-body" style="overflow-y:auto;flex:1">
            <div style="font-size:13px;color:var(--text-base);line-height:1.6;margin-bottom:12px">
              <strong>摘要</strong>
              <div style="margin-top:4px;padding:8px 10px;background:var(--bg-subtle);border-radius:6px;white-space:pre-wrap">
                {req.summary}
              </div>
            </div>
            <Show when={req.steps}>
              <div style="font-size:12.5px;color:var(--text-base);line-height:1.6">
                <strong>详细步骤</strong>
                <div class="md" innerHTML={renderMarkdown(req.steps)} style="margin-top:6px;padding:10px;background:var(--bg-subtle);border-radius:6px" />
              </div>
            </Show>
            <div style="margin-top:12px">
              <label style="font-size:12px;color:var(--text-muted)">若不同意，请填写反馈让 AI 重新规划：</label>
              <textarea
                style="width:100%;min-height:50px;padding:8px 10px;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);font-size:12.5px;color:var(--text-base);outline:none;font-family:var(--font-sans);resize:vertical"
                placeholder="反馈（可选）…"
                value={planExitFeedback()}
                onInput={(e) => setPlanExitFeedback(e.currentTarget.value)}
              />
            </div>
          </div>
          <div class="approval-footer">
            <button class="approval-btn deny" onClick={() => handlePlanExit(false)}>拒绝并反馈</button>
            <button class="approval-btn allow" onClick={() => handlePlanExit(true)}>开始执行</button>
          </div>
        </div>
      </div>
    )
  }

  // ─── ApplyToFileDialog（P0-2: 把 AI 代码块写入指定文件） ──────────────────
  function ApplyToFileDialog() {
    const dlg = applyDialog()
    if (!dlg.open) return null
    return (
      <div class="approval-overlay" onClick={(e) => {
        if (e.target === e.currentTarget) setApplyDialog({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })
      }}>
        <div class="approval-dialog" style="max-width:600px;width:90vw;max-height:80vh;display:flex;flex-direction:column">
          <div class="approval-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            <span class="approval-title">应用代码到文件</span>
            <Show when={dlg.lang}>
              <span style="font-size:11px;color:var(--text-muted);margin-left:8px">({dlg.lang})</span>
            </Show>
          </div>
          <div class="approval-body" style="overflow-y:auto;flex:1">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">目标文件（相对路径）</div>
            <input
              type="text"
              style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-base);font-size:12.5px;color:var(--text-base);outline:none;font-family:ui-monospace,Menlo,monospace"
              value={dlg.target}
              placeholder="例如：src/components/Button.tsx"
              onInput={(e) => setApplyDialog(d => ({ ...d, target: e.currentTarget.value }))}
            />
            <div style="display:flex;gap:10px;margin-top:10px;font-size:12px;color:var(--text-base)">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                <input
                  type="radio"
                  name="apply-mode"
                  checked={dlg.mode === 'overwrite'}
                  onChange={() => setApplyDialog(d => ({ ...d, mode: 'overwrite' }))}
                /> 覆盖写入
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                <input
                  type="radio"
                  name="apply-mode"
                  checked={dlg.mode === 'append'}
                  onChange={() => setApplyDialog(d => ({ ...d, mode: 'append' }))}
                /> 追加到末尾
              </label>
            </div>
            <div style="margin-top:10px">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">代码预览（{dlg.code.split('\n').length} 行，{dlg.code.length} 字符）</div>
              <pre style="max-height:260px;overflow:auto;padding:10px;background:var(--bg-subtle);border-radius:6px;font-size:11.5px;line-height:1.45;font-family:ui-monospace,Menlo,monospace;color:var(--text-base);white-space:pre;border:1px solid var(--border-subtle)">{dlg.code}</pre>
            </div>
            <Show when={dlg.error}>
              <div style="margin-top:8px;padding:6px 10px;background:rgba(255,80,80,0.12);color:#ffb0b0;border-radius:4px;font-size:12px">
                {dlg.error}
              </div>
            </Show>
          </div>
          <div class="approval-footer">
            <button
              class="approval-btn deny"
              disabled={dlg.loading}
              onClick={() => setApplyDialog({ open: false, code: '', lang: undefined, target: '', mode: 'overwrite', loading: false })}
            >取消</button>
            <button
              class="approval-btn allow"
              disabled={dlg.loading || !dlg.target.trim()}
              onClick={() => void confirmApplyToFile()}
            >{dlg.loading ? '写入中…' : '写入文件'}</button>
          </div>
        </div>
      </div>
    )
  }

  // ─── FileTreePanel ────────────────────────────────────────────────────────
  function FileTreePanel() {
    const files = () => Array.from(changedFiles().values())
    return (
      <div class="file-tree-panel">
        <div class="file-tree-header">
          <span class="file-tree-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            文件变更 ({files().length})
          </span>
          <button class="icon-btn" onClick={() => setShowFileTree(false)} title="关闭">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="file-tree-body">
          <Show
            when={files().length > 0}
            fallback={<div class="file-tree-empty">本次会话暂无文件变更</div>}
          >
            <For each={files()}>
              {(entry) => {
                const filename = entry.path.split('/').pop() ?? entry.path
                const shortPathVal = entry.path.length > 50
                  ? '…' + entry.path.slice(-47)
                  : entry.path
                return (
                  <div class="file-tree-item" onClick={() => openPreview(entry.path, { viewMode: 'diff' })} style="cursor:pointer">
                    <span class={`file-status-badge file-status-${entry.action}`}>
                      {entry.action === 'created' ? 'A' : entry.action === 'deleted' ? 'D' : 'M'}
                    </span>
                    <div class="file-tree-item-info">
                      <span class="file-tree-filename">{filename}</span>
                      <span class="file-tree-path" title={entry.path}>{shortPathVal}</span>
                    </div>
                    {/* 在外部编辑器打开 */}
                    <button
                      class="file-open-btn"
                      onClick={(e) => { e.stopPropagation(); openInEditor(entry.path) }}
                      title="在编辑器中打开"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                    </button>
                    <Show when={entry.action !== 'deleted'}>
                      <button
                        class="file-revert-btn"
                        onClick={(e) => { e.stopPropagation(); revertFile(entry.path) }}
                        title="撤销此文件的修改"
                      >
                        ↩
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    )
  }

  // ─── 工作区浏览器面板（列出所有工作区文件，点击打开预览）──────────────
  // 层级文件树节点
  interface FileTreeNode {
    name:     string
    path:     string               // 相对工作区的完整路径
    isDir:    boolean
    children: FileTreeNode[]
  }

  function buildFileTree(paths: string[]): FileTreeNode {
    const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] }
    for (const fullPath of paths) {
      const parts = fullPath.split('/').filter(Boolean)
      let cur = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isLast = i === parts.length - 1
        let child = cur.children.find(c => c.name === part)
        if (!child) {
          child = {
            name:     part,
            path:     parts.slice(0, i + 1).join('/'),
            isDir:    !isLast,
            children: [],
          }
          cur.children.push(child)
        }
        cur = child
      }
    }
    // 排序：目录优先，同类按字母
    const sortRec = (n: FileTreeNode) => {
      n.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      n.children.forEach(sortRec)
    }
    sortRec(root)
    return root
  }

  // 展开的目录路径
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set())
  function toggleDir(path: string) {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function WorkspaceExplorerPanel() {
    const q = () => explorerSearch().trim().toLowerCase()
    const allFiles = () => wsFileCache()?.files ?? []

    // 搜索模式 vs 树模式
    const isSearching = () => q().length > 0
    const searchResults = () => {
      if (!isSearching()) return []
      return allFiles()
        .filter(f => f.toLowerCase().includes(q()))
        .slice(0, 300)
    }
    const tree = createMemo(() => buildFileTree(allFiles()))

    // 渲染节点（递归）
    function renderNode(node: FileTreeNode, depth: number): any {
      if (!node.isDir) {
        const changed = changedFiles().get(node.path)?.action
        return (
          <div
            class="file-tree-item"
            onClick={() => openPreview(node.path)}
            style={`cursor:pointer;padding-left:${8 + depth * 14}px`}
            title={node.path}
          >
            <Show when={changed} fallback={
              <span class="explorer-file-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </span>
            }>
              <span class={`file-status-badge file-status-${changed}`}>
                {changed === 'created' ? 'A' : changed === 'deleted' ? 'D' : 'M'}
              </span>
            </Show>
            <span class="file-tree-filename">{node.name}</span>
          </div>
        )
      }
      const open = () => expandedDirs().has(node.path)
      return (
        <>
          <div
            class="file-tree-item file-tree-dir"
            onClick={() => toggleDir(node.path)}
            style={`cursor:pointer;padding-left:${8 + depth * 14}px`}
            title={node.path}
          >
            <svg class="file-tree-arrow" classList={{ open: open() }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent);flex-shrink:0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="file-tree-filename">{node.name}</span>
            <span class="file-tree-dir-count">{node.children.length}</span>
          </div>
          <Show when={open()}>
            <For each={node.children}>
              {(child) => renderNode(child, depth + 1)}
            </For>
          </Show>
        </>
      )
    }

    return (
      <div class="file-tree-panel explorer-panel">
        <div class="file-tree-header">
          <span class="file-tree-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            工作区文件 ({allFiles().length})
          </span>
          <button class="icon-btn" onClick={() => setShowExplorer(false)} title="关闭">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="explorer-search-wrap">
          <input
            class="explorer-search"
            placeholder="搜索文件…"
            value={explorerSearch()}
            onInput={(e) => setExplorerSearch(e.currentTarget.value)}
          />
        </div>
        <div class="file-tree-body">
          <Show when={wsFileCacheLoading()}>
            <div class="file-tree-empty">加载中…</div>
          </Show>

          {/* 搜索模式：扁平列表 */}
          <Show when={!wsFileCacheLoading() && isSearching()}>
            <Show when={searchResults().length === 0}>
              <div class="file-tree-empty">无匹配文件</div>
            </Show>
            <For each={searchResults()}>
              {(filePath) => {
                const filename = filePath.split('/').pop() ?? filePath
                const dir = filePath.slice(0, filePath.length - filename.length).replace(/\/$/, '')
                const changed = changedFiles().get(filePath)?.action
                return (
                  <div
                    class="file-tree-item"
                    onClick={() => openPreview(filePath)}
                    style="cursor:pointer"
                    title={filePath}
                  >
                    <Show when={changed} fallback={
                      <span class="explorer-file-icon">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                      </span>
                    }>
                      <span class={`file-status-badge file-status-${changed}`}>
                        {changed === 'created' ? 'A' : changed === 'deleted' ? 'D' : 'M'}
                      </span>
                    </Show>
                    <div class="file-tree-item-info">
                      <span class="file-tree-filename">{filename}</span>
                      <Show when={dir}>
                        <span class="file-tree-path">{dir}</span>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
            <Show when={searchResults().length === 300}>
              <div class="file-tree-empty" style="font-size:11px;padding:8px 12px">
                仅显示前 300 条，请用搜索进一步过滤
              </div>
            </Show>
          </Show>

          {/* 树模式（默认） */}
          <Show when={!wsFileCacheLoading() && !isSearching()}>
            <Show when={allFiles().length === 0}>
              <div class="file-tree-empty">工作区为空</div>
            </Show>
            <For each={tree().children}>
              {(node) => renderNode(node, 0)}
            </For>
          </Show>
        </div>
      </div>
    )
  }

  // ─── Skills 面板 ─────────────────────────────────────────────────────────
  async function loadSkills() {
    const ws = activeWorkspace()
    if (!ws) return
    setSkillsLoading(true)
    try {
      const c = await getClient()
      const res = await c.listSkills(ws.id)
      setSkillsList(res.skills)
      setSkillsSearchedDirs(res.searchedDirs)
    } catch (e) {
      setSkillsList([])
      setSkillsSearchedDirs([])
    } finally {
      setSkillsLoading(false)
    }
  }

  // 打开 Skills 面板时自动加载一次
  createEffect(() => {
    if (showSkillsPanel() && activeWorkspace()) {
      void loadSkills()
    }
  })

  function SkillsPanel() {
    const sourceLabel = (s: string) =>
      s === 'workspace-maxian' ? '项目 .maxian' :
      s === 'workspace-claude' ? '项目 .claude' :
      s === 'user-maxian'      ? '用户 ~/.maxian' :
      s === 'user-claude'      ? '用户 ~/.claude' : s

    return (
      <div class="file-tree-panel skills-panel">
        <div class="file-tree-header">
          <span class="file-tree-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z"/>
            </svg>
            Skills ({skillsList().length})
          </span>
          <div style="display:flex;gap:4px;align-items:center">
            <button class="icon-btn" onClick={() => void loadSkills()} title="刷新">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
            <button class="icon-btn" onClick={() => setShowSkillsPanel(false)} title="关闭">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="file-tree-body">
          <Show when={skillsLoading()}>
            <div class="file-tree-empty">扫描中…</div>
          </Show>
          <Show when={!skillsLoading() && skillsList().length === 0}>
            <div class="skills-empty">
              <div style="margin-bottom:10px;color:var(--text-muted)">未找到任何技能文档</div>
              <div style="font-size:11px;color:var(--text-faint);line-height:1.7;text-align:left;padding:0 4px">
                在以下任一目录中创建 <code>.md</code> 文件：
                <ul style="padding-left:18px;margin:6px 0">
                  <For each={skillsSearchedDirs()}>
                    {(d) => (
                      <li style={`color:${d.exists ? 'var(--text-base)' : 'var(--text-faint)'}`}>
                        <code style="font-size:10px">{d.path}</code>
                        <Show when={d.exists}><span style="color:#22c55e;margin-left:4px">✓</span></Show>
                      </li>
                    )}
                  </For>
                </ul>
                每个 md 文件顶部建议使用 YAML frontmatter：
                <pre style="background:var(--bg-subtle);padding:6px;border-radius:4px;margin-top:4px;font-size:10px">---{'\n'}name: my-skill{'\n'}description: 简短描述{'\n'}---{'\n'}
# Skill Content…</pre>
              </div>
            </div>
          </Show>
          <For each={skillsList()}>
            {(skill) => (
              <div
                class="file-tree-item skill-item"
                onClick={() => openPreview(skill.path)}
                style="cursor:pointer;align-items:flex-start;padding:8px 12px"
                title={skill.path}
              >
                <span class="skill-icon">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z"/>
                  </svg>
                </span>
                <div class="file-tree-item-info" style="gap:3px">
                  <span class="skill-name">{skill.name}</span>
                  <Show when={skill.description}>
                    <span class="skill-desc">{skill.description}</span>
                  </Show>
                  <span class="skill-source">{sourceLabel(skill.source)}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    )
  }

  // ─── 文件预览面板（右侧滑入，多标签）────────────────────────────────────
  // 辅助：LCS diff 算法（保留原有逻辑）
  type _DiffLine = { type: 'del' | 'add' | 'ctx'; text: string }

  function computeUnifiedDiff(orig: string, curr: string): _DiffLine[] {
    const origLines = orig.split('\n')
    const currLines = curr.split('\n')
    const result: _DiffLine[] = []
    const maxLines = 800
    const ao = origLines.slice(0, maxLines)
    const bo = currLines.slice(0, maxLines)

    const m = ao.length, n = bo.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = ao[i-1] === bo[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])

    // 迭代回溯，避免深递归 stack overflow
    let i = m, j = n
    const stack: _DiffLine[] = []
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && ao[i-1] === bo[j-1]) {
        stack.push({ type: 'ctx', text: ao[i-1] }); i--; j--
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        stack.push({ type: 'add', text: bo[j-1] }); j--
      } else {
        stack.push({ type: 'del', text: ao[i-1] }); i--
      }
    }
    for (let k = stack.length - 1; k >= 0; k--) result.push(stack[k])

    if (origLines.length > maxLines || currLines.length > maxLines) {
      result.push({ type: 'ctx', text: `… (仅显示前 ${maxLines} 行)` })
    }
    return result
  }

  /** 根据扩展名判定 highlight.js 语言（返回空则自动检测） */
  function hljsLangFromPath(p: string): string | undefined {
    const ext = p.split('.').pop()?.toLowerCase() ?? ''
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      mjs: 'javascript', cjs: 'javascript',
      py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
      c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
      cs: 'csharp', swift: 'swift', rb: 'ruby', php: 'php', scala: 'scala',
      sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
      xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
      css: 'css', scss: 'scss', less: 'less',
      sql: 'sql', dockerfile: 'dockerfile',
      vue: 'xml', svelte: 'xml',
    }
    return map[ext]
  }

  /** 文件预览面板 */
  function FilePreviewPanel() {
    const tabs = () => previewTabs()
    const active = () => tabs().find(t => t.path === activePreviewPath())

    // 拖动调整宽度
    let isDragging = false
    const onDragStart = (e: MouseEvent) => {
      e.preventDefault()
      isDragging = true
      const startX = e.clientX
      const startW = previewWidth()
      const onMove = (ev: MouseEvent) => {
        if (!isDragging) return
        const dx = startX - ev.clientX
        const next = Math.max(320, Math.min(1200, startW + dx))
        setPreviewWidth(next)
      }
      const onUp = () => {
        isDragging = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    return (
      <div class="preview-panel" style={{ width: `${previewWidth()}px` }}>
        <div class="preview-panel-resizer" onMouseDown={onDragStart} />

        {/* 标签栏 — 支持拖拽重排（P2-18） */}
        <div class="preview-tabs">
          <For each={tabs()}>
            {(tab, idx) => (
              <div
                class="preview-tab"
                classList={{ active: tab.path === activePreviewPath() }}
                onClick={() => setActivePreviewPath(tab.path)}
                title={tab.path}
                draggable={true}
                onDragStart={(e) => {
                  e.dataTransfer?.setData('text/x-tab-idx', String(idx()))
                  e.dataTransfer!.effectAllowed = 'move'
                  ;(e.currentTarget as HTMLElement).classList.add('dragging')
                }}
                onDragEnd={(e) => {
                  ;(e.currentTarget as HTMLElement).classList.remove('dragging')
                  document.querySelectorAll('.preview-tab.drag-over').forEach(el => el.classList.remove('drag-over'))
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer!.dropEffect = 'move'
                  ;(e.currentTarget as HTMLElement).classList.add('drag-over')
                }}
                onDragLeave={(e) => {
                  ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
                  const from = Number(e.dataTransfer?.getData('text/x-tab-idx'))
                  const to = idx()
                  if (Number.isNaN(from) || from === to) return
                  setPreviewTabs(prev => {
                    const next = [...prev]
                    const [moved] = next.splice(from, 1)
                    next.splice(to, 0, moved)
                    return next
                  })
                }}
              >
                <Show when={tab.changed}>
                  <span class={`preview-tab-badge badge-${tab.changed}`}>
                    {tab.changed === 'created' ? 'A' : tab.changed === 'deleted' ? 'D' : 'M'}
                  </span>
                </Show>
                <span class="preview-tab-title">{tab.title}</span>
                <button
                  class="preview-tab-close"
                  onClick={(e) => { e.stopPropagation(); closePreviewTab(tab.path) }}
                  title="关闭"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            )}
          </For>
          <div class="preview-tabs-spacer" />
          <button
            class="icon-btn preview-close-all"
            title="关闭所有标签"
            onClick={() => { setPreviewTabs([]); setActivePreviewPath(null) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* 活动标签工具栏 */}
        <Show when={active()}>
          {(a) => (
            <div class="preview-toolbar">
              <div class="preview-toolbar-path" title={a().path}>{a().path}</div>
              <div class="preview-toolbar-actions">
                {/* Markdown: 源码 / 预览 切换 */}
                <Show when={a().kind === 'markdown'}>
                  <div class="preview-segmented">
                    <button
                      classList={{ active: a().viewMode === 'rendered' }}
                      onClick={() => setTabViewMode(a().path, 'rendered')}
                    >预览</button>
                    <button
                      classList={{ active: a().viewMode === 'source' }}
                      onClick={() => setTabViewMode(a().path, 'source')}
                    >源码</button>
                  </div>
                </Show>
                {/* 变更文件：源码 / Diff 切换 */}
                <Show when={a().changed && a().kind !== 'image' && a().kind !== 'binary'}>
                  <div class="preview-segmented">
                    <button
                      classList={{ active: a().viewMode === 'diff' }}
                      onClick={() => setTabViewMode(a().path, 'diff')}
                    >Diff</button>
                    <button
                      classList={{ active: a().viewMode === 'source' }}
                      onClick={() => setTabViewMode(a().path, 'source')}
                    >源码</button>
                  </div>
                </Show>
                {/* Diff 视图子模式：Unified / Split */}
                <Show when={a().viewMode === 'diff' && a().changed}>
                  <div class="preview-segmented">
                    <button
                      classList={{ active: diffViewMode() === 'unified' }}
                      onClick={() => setDiffViewMode('unified')}
                      title="单栏统一视图"
                    >Unified</button>
                    <button
                      classList={{ active: diffViewMode() === 'split' }}
                      onClick={() => setDiffViewMode('split')}
                      title="左右分栏对照"
                    >Split</button>
                  </div>
                </Show>
                {/* 外部编辑器 */}
                <button
                  class="icon-btn"
                  title="在编辑器中打开"
                  onClick={() => openInEditor(a().path)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </button>
                {/* 撤销（仅变更文件） */}
                <Show when={a().changed && a().changed !== 'deleted'}>
                  <button
                    class="approval-btn allow"
                    style="font-size:11px;padding:3px 10px"
                    onClick={() => revertFile(a().path)}
                  >↩ 撤销</button>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* 外部变更提示（P0-4） */}
        <Show when={active()?.extChangedAt}>
          <div class="preview-extchange-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span style="flex:1">该文件已被外部修改（本面板内容可能已过期）</span>
            <button onClick={() => { const p = activePreviewPath(); if (p) void reloadPreview(p) }}>重新加载</button>
            <button onClick={() => {
              const p = activePreviewPath()
              if (!p) return
              setPreviewTabs(prev => prev.map(t => t.path === p ? { ...t, extChangedAt: undefined } : t))
            }}>忽略</button>
          </div>
        </Show>

        {/* 内容区 */}
        <div class="preview-body">
          <Show when={active()} keyed fallback={
            <div class="preview-empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <div>未选择文件</div>
            </div>
          }>
            {(tab) => {
              if (tab.loading) return <div class="preview-loading">加载中…</div>
              if (tab.error && !tab.content) {
                return <div class="preview-error">{tab.error}</div>
              }

              // 二进制
              if (tab.kind === 'binary') {
                return (
                  <div class="preview-binary">
                    <div class="preview-binary-title">{tab.title}</div>
                    <div class="preview-binary-desc">
                      二进制文件（{(tab.size / 1024).toFixed(1)} KB · {tab.mimeType}）
                    </div>
                  </div>
                )
              }

              // 图片
              if (tab.kind === 'image') {
                const src = `data:${tab.mimeType};base64,${tab.content}`
                return (
                  <div class="preview-image-wrap">
                    <img class="preview-image" src={src} alt={tab.path} />
                    <div class="preview-image-info">
                      {tab.mimeType} · {(tab.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                )
              }

              // 音频
              if (tab.kind === 'audio') {
                const src = `data:${tab.mimeType};base64,${tab.content}`
                return (
                  <div class="preview-media-wrap">
                    <audio src={src} controls style="width:100%" />
                  </div>
                )
              }

              // 视频
              if (tab.kind === 'video') {
                const src = `data:${tab.mimeType};base64,${tab.content}`
                return (
                  <div class="preview-media-wrap">
                    <video src={src} controls style="max-width:100%;max-height:80vh" />
                  </div>
                )
              }

              // Diff 视图
              if (tab.viewMode === 'diff') {
                if (tab.diffLoading) return <div class="preview-loading">加载 diff…</div>
                if (tab.diffOriginal === undefined) return <div class="preview-loading">加载 diff…</div>
                if (tab.diffOriginal === null) {
                  // 新建文件
                  const lines = (tab.diffCurrent ?? '').split('\n')
                  return (
                    <div class="diff-table">
                      <div class="diff-legend">
                        <span class="diff-legend-add">+ 新建文件 ({lines.length} 行)</span>
                      </div>
                      <div class="diff-lines">
                        {lines.slice(0, 500).map((line, i) => (
                          <div class="diff-line diff-line-add">
                            <span class="diff-ln">{i + 1}</span>
                            <span class="diff-sign">+</span>
                            <code class="diff-text">{line}</code>
                          </div>
                        ))}
                        {lines.length > 500 && (
                          <div class="diff-line diff-line-ctx">
                            <span class="diff-ln">…</span><span class="diff-sign"> </span>
                            <code class="diff-text">… 还有 {lines.length - 500} 行</code>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                }
                const diffLines = computeUnifiedDiff(tab.diffOriginal, tab.diffCurrent ?? '')
                const hasChanges = diffLines.some(l => l.type !== 'ctx')
                if (!hasChanges) return <div class="diff-no-change">文件内容未发生变化</div>
                const CONTEXT = 3
                const show = diffLines.map((_l, i) => {
                  const start = Math.max(0, i - CONTEXT)
                  const end = Math.min(diffLines.length - 1, i + CONTEXT)
                  return diffLines.slice(start, end + 1).some(x => x.type !== 'ctx')
                })

                // ── Split 视图：左右分栏对照 ──
                if (diffViewMode() === 'split') {
                  // 成对还原为左右行（null 表示空行）
                  const leftCol:  Array<{ no: number; text: string; type: 'ctx'|'del' } | null> = []
                  const rightCol: Array<{ no: number; text: string; type: 'ctx'|'add' } | null> = []
                  let leftNo = 0, rightNo = 0
                  let i = 0
                  while (i < diffLines.length) {
                    if (diffLines[i].type === 'ctx') {
                      leftNo++; rightNo++
                      leftCol.push({  no: leftNo,  text: diffLines[i].text, type: 'ctx' })
                      rightCol.push({ no: rightNo, text: diffLines[i].text, type: 'ctx' })
                      i++
                    } else {
                      // 收集连续 del/add 块
                      const dels: Array<{ no: number; text: string }> = []
                      const adds: Array<{ no: number; text: string }> = []
                      while (i < diffLines.length && diffLines[i].type === 'del') {
                        leftNo++
                        dels.push({ no: leftNo, text: diffLines[i].text }); i++
                      }
                      while (i < diffLines.length && diffLines[i].type === 'add') {
                        rightNo++
                        adds.push({ no: rightNo, text: diffLines[i].text }); i++
                      }
                      const pairLen = Math.max(dels.length, adds.length)
                      for (let k = 0; k < pairLen; k++) {
                        leftCol.push(dels[k]  ? { no: dels[k].no,  text: dels[k].text,  type: 'del' } : null)
                        rightCol.push(adds[k] ? { no: adds[k].no, text: adds[k].text, type: 'add' } : null)
                      }
                    }
                  }
                  return (
                    <div class="diff-table">
                      <div class="diff-legend">
                        <span class="diff-legend-del">− 原始</span>
                        <span class="diff-legend-add">+ 当前</span>
                      </div>
                      <div class="diff-split">
                        <div class="diff-split-col">
                          <For each={leftCol}>
                            {(row) => row ? (
                              <div class={`diff-line diff-line-${row.type}`}>
                                <span class="diff-ln">{row.no}</span>
                                <span class="diff-sign">{row.type === 'del' ? '−' : ' '}</span>
                                <code class="diff-text">{row.text}</code>
                              </div>
                            ) : (
                              <div class="diff-line diff-line-empty">&nbsp;</div>
                            )}
                          </For>
                        </div>
                        <div class="diff-split-col">
                          <For each={rightCol}>
                            {(row) => row ? (
                              <div class={`diff-line diff-line-${row.type}`}>
                                <span class="diff-ln">{row.no}</span>
                                <span class="diff-sign">{row.type === 'add' ? '+' : ' '}</span>
                                <code class="diff-text">{row.text}</code>
                              </div>
                            ) : (
                              <div class="diff-line diff-line-empty">&nbsp;</div>
                            )}
                          </For>
                        </div>
                      </div>
                    </div>
                  )
                }

                // Unified 视图（默认）
                return (
                  <div class="diff-table">
                    <div class="diff-legend">
                      <span class="diff-legend-del">− 删除</span>
                      <span class="diff-legend-add">+ 新增</span>
                    </div>
                    <div class="diff-lines">
                      <For each={diffLines}>
                        {(line, idx) => (
                          <Show when={show[idx()]}>
                            <div class={`diff-line diff-line-${line.type}`}>
                              <span class="diff-sign">{line.type === 'del' ? '−' : line.type === 'add' ? '+' : ' '}</span>
                              <code class="diff-text">{line.text}</code>
                            </div>
                          </Show>
                        )}
                      </For>
                    </div>
                  </div>
                )
              }

              // Markdown 渲染模式（使用应用统一的 renderMarkdown，带 DOMPurify 清洗）
              if (tab.kind === 'markdown' && tab.viewMode === 'rendered') {
                const html = renderMarkdown(tab.content)
                return (
                  <div class="preview-markdown-rendered markdown-body" innerHTML={html} />
                )
              }

              // 文本源码（含 markdown 源码）
              const lang = hljsLangFromPath(tab.path)
              let highlighted: string
              try {
                highlighted = lang
                  ? hljs.highlight(tab.content, { language: lang, ignoreIllegals: true }).value
                  : hljs.highlightAuto(tab.content).value
              } catch {
                highlighted = escapeHtml(tab.content)
              }
              const lineCount = tab.content.split('\n').length
              const lineNums = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')
              return (
                <div class="preview-code-wrap">
                  <pre class="preview-code-lineno">{lineNums}</pre>
                  <pre class="preview-code"><code class="hljs" innerHTML={highlighted} /></pre>
                </div>
              )
            }}
          </Show>
        </div>
      </div>
    )
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] as string))
  }

  // ─── TokenUsageBar（带动画数字）────────────────────────────────────────
  function TokenUsageBar() {
    const pct = () => Math.min(100, (tokenUsed() / tokenLimit()) * 100)
    const color = () => pct() < 50 ? '#22c55e' : pct() < 80 ? '#f59e0b' : '#ef4444'
    return (
      <Show when={tokenUsed() > 0}>
        <div class="token-usage-bar" title={`已使用 ${tokenUsed().toLocaleString()} / ${tokenLimit().toLocaleString()} tokens (${pct().toFixed(1)}%)`}>
          <div class="token-usage-fill" style={{ width: `${pct()}%`, background: color(), transition: 'width 400ms ease-out, background 300ms' }} />
        </div>
      </Show>
    )
  }

  // ─── TodoDock（P0-1）: 在 composer 上方显示当前 todos 进度 ─────────────
  function TodoDock() {
    const total = () => todos().length
    const completed = () => todos().filter(t => t.status === 'completed').length
    const inProgress = () => todos().find(t => t.status === 'in_progress')
    const pct = () => total() === 0 ? 0 : Math.round((completed() / total()) * 100)
    return (
      <div class="todo-dock">
        <div class="todo-dock-header" onClick={() => setTodoDockCollapsed(v => !v)}>
          <svg class="todo-dock-arrow" classList={{ open: !todoDockCollapsed() }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
            <polyline points="9 11 12 14 22 4"/>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
          </svg>
          <span class="todo-dock-title">任务清单</span>
          <span class="todo-dock-counter">
            <AnimatedNumber value={completed()} duration={400} /> / {total()}
          </span>
          <div class="todo-dock-progress">
            <div class="todo-dock-progress-fill" style={{ width: `${pct()}%` }} />
          </div>
          <Show when={inProgress() && todoDockCollapsed()}>
            <span class="todo-dock-current" title={inProgress()!.content}>
              · {inProgress()!.content}
            </span>
          </Show>
        </div>
        <Show when={!todoDockCollapsed()}>
          <div class="todo-dock-list">
            <For each={todos()}>
              {(t) => (
                <div class={`todo-item todo-${t.status}`}>
                  <span class="todo-checkbox">
                    <Show when={t.status === 'completed'}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                    </Show>
                    <Show when={t.status === 'in_progress'}>
                      <span class="todo-spinner" />
                    </Show>
                  </span>
                  <span class="todo-content">{t.content}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    )
  }

  // ─── FollowupDock（P0-2）: 建议追问 + 队列 ───────────────────────────────
  function FollowupDock() {
    const hasQueue = () => followupQueue().length > 0
    return (
      <div class="followup-dock">
        <div class="followup-dock-header" onClick={() => setFollowupCollapsed(v => !v)}>
          <svg class="todo-dock-arrow" classList={{ open: !followupCollapsed() }} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          <span class="followup-dock-title">
            建议 & 队列
            <Show when={followupSuggestions().length > 0}>
              <span class="followup-count">建议 {followupSuggestions().length}</span>
            </Show>
            <Show when={hasQueue()}>
              <span class="followup-count followup-count-queued">已排队 {followupQueue().length}</span>
            </Show>
          </span>
        </div>
        <Show when={!followupCollapsed()}>
          <div class="followup-body">
            <Show when={followupSuggestions().length > 0}>
              <div class="followup-section-title">AI 建议追问</div>
              <div class="followup-suggestions">
                <For each={followupSuggestions()}>
                  {(s) => (
                    <div class="followup-suggestion">
                      <span class="followup-text" onClick={() => setInput(s)}>{s}</span>
                      <div class="followup-actions">
                        <button class="followup-btn" onClick={() => setInput(s)} title="填入输入框">编辑</button>
                        <button class="followup-btn followup-btn-primary" onClick={() => {
                          setFollowupQueue(prev => [...prev, s])
                          setFollowupSuggestions(prev => prev.filter(x => x !== s))
                        }} title="加入队列">入队</button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={hasQueue()}>
              <div class="followup-section-title">待发送队列</div>
              <div class="followup-queue">
                <For each={followupQueue()}>
                  {(q, i) => (
                    <div class="followup-queue-item">
                      <span class="followup-queue-idx">{i() + 1}</span>
                      <span class="followup-text">{q}</span>
                      <div class="followup-actions">
                        <button class="followup-btn" onClick={() => {
                          setInput(q)
                          setFollowupQueue(prev => prev.filter((_, idx) => idx !== i()))
                        }}>取出</button>
                        <button class="followup-btn followup-btn-danger" onClick={() => {
                          setFollowupQueue(prev => prev.filter((_, idx) => idx !== i()))
                        }}>删除</button>
                      </div>
                    </div>
                  )}
                </For>
                <div class="followup-queue-actions">
                  <button class="followup-btn followup-btn-primary" onClick={async () => {
                    // 依次发送队列
                    const queue = followupQueue()
                    setFollowupQueue([])
                    for (const q of queue) {
                      if (sending()) break  // 若中途收到新消息，停止
                      setInput(q)
                      await send()
                      // 等待 AI 回完（简单轮询）
                      while (sending()) await new Promise(r => setTimeout(r, 500))
                    }
                  }} disabled={sending()}>依次发送</button>
                  <button class="followup-btn" onClick={() => setFollowupQueue([])}>清空</button>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  // ─── ContextPanel（P1-10）: 显示当前会话已附加的上下文 ──────────────────
  function ContextPanel() {
    return (
      <div class="file-tree-panel context-panel">
        <div class="file-tree-header">
          <span class="file-tree-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 7h-3V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
            </svg>
            会话上下文
          </span>
          <button class="icon-btn" onClick={() => setShowContextPanel(false)} title="关闭">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="file-tree-body">
          {/* 文件引用 */}
          <Show when={contextFiles().length > 0}>
            <div class="context-section-title">@ 文件引用 ({contextFiles().length})</div>
            <For each={contextFiles()}>
              {(f) => (
                <div class="file-tree-item" onClick={() => openPreview(f)} style="cursor:pointer" title={f}>
                  <span class="explorer-file-icon">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                  </span>
                  <span class="file-tree-filename">{f.split('/').pop()}</span>
                  <span class="file-tree-path" style="margin-left:auto;font-size:10px">{f}</span>
                </div>
              )}
            </For>
          </Show>

          {/* 当前输入框附加图片（未发送） */}
          <Show when={attachedImages().length > 0}>
            <div class="context-section-title">待发送图片 ({attachedImages().length})</div>
            <div style="padding:4px 12px;display:flex;flex-wrap:wrap;gap:6px">
              <For each={attachedImages()}>
                {(img) => (
                  <div style="position:relative">
                    <img src={img.dataUrl} style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" alt={img.name} />
                    <button
                      style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#ef4444;color:#fff;border:none;font-size:10px;cursor:pointer;line-height:1"
                      onClick={() => removeImage(img.id)}
                    >×</button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* 已变更文件（会话内） */}
          <Show when={changedFiles().size > 0}>
            <div class="context-section-title">已修改文件 ({changedFiles().size})</div>
            <For each={[...changedFiles().values()]}>
              {(entry) => (
                <div class="file-tree-item" onClick={() => openPreview(entry.path, { viewMode: 'diff' })} style="cursor:pointer" title={entry.path}>
                  <span class={`file-status-badge file-status-${entry.action}`}>
                    {entry.action === 'created' ? 'A' : entry.action === 'deleted' ? 'D' : 'M'}
                  </span>
                  <span class="file-tree-filename">{entry.path.split('/').pop()}</span>
                </div>
              )}
            </For>
          </Show>

          <Show when={contextFiles().length === 0 && attachedImages().length === 0 && changedFiles().size === 0}>
            <div class="file-tree-empty">
              <div style="margin-bottom:10px">暂无附加上下文</div>
              <div style="font-size:11px;color:var(--text-faint);padding:0 12px;line-height:1.6">
                · 在输入框输入 <code style="background:var(--bg-subtle);padding:1px 4px;border-radius:3px">@</code> 引用工作区文件<br/>
                · 拖拽或粘贴图片到输入框<br/>
                · AI 修改的文件会自动追踪
              </div>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  // ─── RevertDock（P1-11）: 显示最近用户消息，一键回退到某条 ──────────────
  function RevertDock() {
    // 只显示 user 消息（回退点）
    const userMsgs = () => messages().filter(m => m.role === 'user').slice(-5).reverse()
    return (
      <div class="revert-dock">
        <div class="revert-dock-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          <span class="revert-dock-title">回退对话</span>
          <span class="revert-dock-hint">选择要回退到的用户消息（该消息及其后将被删除）</span>
          <button class="icon-btn" onClick={() => setShowRevertDock(false)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="revert-dock-list">
          <Show when={userMsgs().length === 0}>
            <div class="revert-dock-empty">暂无用户消息</div>
          </Show>
          <For each={userMsgs()}>
            {(m, i) => (
              <div class="revert-dock-item">
                <span class="revert-dock-idx">#{userMsgs().length - i()}</span>
                <span class="revert-dock-msg" title={m.content}>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</span>
                <button class="approval-btn deny" style="padding:4px 12px;font-size:12px" onClick={() => revertToMessage(m.id)}>
                  回退到这里
                </button>
              </div>
            )}
          </For>
        </div>
      </div>
    )
  }

  // ─── CompactingBanner（压缩进行中 banner，带耗时计数）──────────────────
  function CompactingBanner() {
    const [now, setNow] = createSignal(Date.now())
    createEffect(() => {
      if (!compactingState()) return
      const timer = setInterval(() => setNow(Date.now()), 200)
      onCleanup(() => clearInterval(timer))
    })
    const elapsed = () => {
      const s = compactingState()
      if (!s) return '0.0'
      return ((now() - s.startedAt) / 1000).toFixed(1)
    }
    const state = () => compactingState()!
    return (
      <div class="rate-limit-banner" style="background:color-mix(in srgb, var(--accent) 10%, transparent);border-color:color-mix(in srgb, var(--accent) 30%, transparent);color:var(--accent)">
        <span class="todo-spinner" style="border-top-color:var(--accent)" />
        <span class="rate-limit-msg">
          正在压缩上下文（{state().willLevel2 ? 'LLM 总结' : '按类型剪枝'}，当前 {state().tokensCurrent.toLocaleString()} tokens）…
        </span>
        <span class="rate-limit-countdown">{elapsed()}s</span>
      </div>
    )
  }

  // ─── RateLimitBanner（P0-6）: 限流倒计时 ─────────────────────────────────
  function RateLimitBanner() {
    const [now, setNow] = createSignal(Date.now())
    createEffect(() => {
      if (!rateLimit().active) return
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))
    })
    const secondsLeft = () => Math.max(0, Math.ceil((rateLimit().resetAt - now()) / 1000))
    return (
      <Show when={rateLimit().active}>
        <div class="rate-limit-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <span class="rate-limit-msg">{rateLimit().message}</span>
          <span class="rate-limit-countdown">
            <Show when={secondsLeft() > 0} fallback="正在重试…">
              剩余 <AnimatedNumber value={secondsLeft()} duration={200} /> 秒
            </Show>
          </span>
          <span class="rate-limit-attempt">第 {rateLimit().attempt} 次尝试</span>
          <button class="rate-limit-cancel" onClick={() => {
            setRateLimit({ active: false, resetAt: 0, attempt: 0, message: '' })
            void cancel()
          }}>取消</button>
        </div>
      </Show>
    )
  }

  // ─── ToastHost（全局 toast，支持 action 按钮）──────────────────────────
  function ToastHost() {
    return (
      <div class="toast-host">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast toast-${t.kind}`}>
              <div class="toast-icon">
                {t.kind === 'success' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
                {t.kind === 'error' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                )}
                {t.kind === 'warn' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                )}
                {t.kind === 'info' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                )}
              </div>
              <div class="toast-msg">{t.message}</div>
              <Show when={t.action}>
                <button
                  class="toast-action"
                  onClick={() => { t.action!.onClick(); dismissToast(t.id) }}
                >
                  {t.action!.label}
                </button>
              </Show>
              <button class="toast-close" onClick={() => dismissToast(t.id)} title="关闭">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          )}
        </For>
      </div>
    )
  }

  // ─── CommandPalette（⌘P 全局搜索：会话 / 文件 / 符号 / 命令）────────────
  function CommandPalette() {
    const items = () => cmdPaletteItems()
    return (
      <div class="keybind-overlay" onClick={() => setShowCmdPalette(false)}>
        <div class="keybind-modal" onClick={(e) => e.stopPropagation()} style="width:640px">
          <div class="keybind-header">
            <span class="keybind-title">⌘P · 全局搜索</span>
            <button class="icon-btn" onClick={() => setShowCmdPalette(false)} title="关闭 (Esc)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <input
            class="keybind-search"
            placeholder="搜索会话、文件、符号、命令…"
            value={cmdPaletteQuery()}
            onInput={(e) => setCmdPaletteQuery(e.currentTarget.value)}
            autofocus
            onKeyDown={(e) => {
              const list = items()
              if (e.key === 'ArrowDown') { e.preventDefault(); setCmdPaletteIdx(i => Math.min(i + 1, list.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdPaletteIdx(i => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') {
                e.preventDefault()
                const sel = list[cmdPaletteIdx()]
                if (sel) void sel.onSelect()
              }
              else if (e.key === 'Escape') { e.preventDefault(); setShowCmdPalette(false) }
            }}
          />
          <div class="keybind-body">
            <Show when={cmdPaletteLoading()}>
              <div class="keybind-empty" style="padding:10px">搜索中…</div>
            </Show>
            <Show when={!cmdPaletteLoading() && items().length === 0}>
              <div class="keybind-empty">无匹配</div>
            </Show>
            <For each={items()}>
              {(item, idx) => {
                const icon = item.type === 'session' ? '💬'
                  : item.type === 'file'    ? '📄'
                  : item.type === 'symbol'  ? '🔣'
                  : '⚡'
                return (
                  <div
                    class="cmd-palette-item"
                    classList={{ active: idx() === cmdPaletteIdx() }}
                    onMouseEnter={() => setCmdPaletteIdx(idx())}
                    onClick={() => item.onSelect()}
                  >
                    <span class="cmd-palette-icon">{icon}</span>
                    <div class="cmd-palette-text">
                      <div class="cmd-palette-label">{item.label}</div>
                      <Show when={item.desc}>
                        <div class="cmd-palette-desc">{item.desc}</div>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </div>
    )
  }

  // ─── KeybindHelpModal（⌘/ 触发，可搜索的快捷键速查）─────────────────────
  const KEYBINDS: Array<{ keys: string; desc: string; category: string }> = [
    { keys: '⌘N',      desc: '新建会话',           category: '会话' },
    { keys: '⌘W',      desc: '关闭当前会话',        category: '会话' },
    { keys: '⌘[',      desc: '上一个会话',          category: '会话' },
    { keys: '⌘]',      desc: '下一个会话',          category: '会话' },
    { keys: '⌘K',      desc: '打开命令面板（/）',   category: '会话' },
    { keys: '⌘Enter',  desc: '发送消息',            category: '输入' },
    { keys: 'Esc',     desc: '中断 AI 生成',        category: '输入' },
    { keys: '↑/↓',     desc: '输入框空时翻历史',    category: '输入' },
    { keys: '@',       desc: '文件引用',            category: '输入' },
    { keys: '/',       desc: '斜杠命令',            category: '输入' },
    { keys: '⌘`',      desc: '切换终端',            category: '面板' },
    { keys: '⌘,',      desc: '打开设置',            category: '面板' },
    { keys: '⌘/',      desc: '显示快捷键速查',      category: '面板' },
    { keys: 'j / k',   desc: '上下消息导航',        category: '消息' },
    { keys: '↑/↓',     desc: '消息列表聚焦时上下移动', category: '消息' },
    { keys: 'Enter',   desc: '展开/折叠当前消息',   category: '消息' },
  ]
  function KeybindHelpModal() {
    const q = () => keybindSearch().trim().toLowerCase()
    const filtered = () => q()
      ? KEYBINDS.filter(k => k.keys.toLowerCase().includes(q()) || k.desc.toLowerCase().includes(q()) || k.category.toLowerCase().includes(q()))
      : KEYBINDS
    const grouped = () => {
      const m = new Map<string, typeof KEYBINDS>()
      for (const k of filtered()) {
        if (!m.has(k.category)) m.set(k.category, [])
        m.get(k.category)!.push(k)
      }
      return Array.from(m.entries())
    }
    return (
      <div class="keybind-overlay" onClick={() => setShowKeybindHelp(false)}>
        <div class="keybind-modal" onClick={(e) => e.stopPropagation()}>
          <div class="keybind-header">
            <span class="keybind-title">键盘快捷键</span>
            <button class="icon-btn" onClick={() => setShowKeybindHelp(false)} title="关闭 (Esc)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <input
            class="keybind-search"
            placeholder="搜索快捷键或功能…"
            value={keybindSearch()}
            onInput={(e) => setKeybindSearch(e.currentTarget.value)}
            autofocus
          />
          <div class="keybind-body">
            <For each={grouped()}>
              {([category, items]) => (
                <div class="keybind-group">
                  <div class="keybind-group-title">{category}</div>
                  <For each={items}>
                    {(k) => (
                      <div class="keybind-row">
                        <span class="keybind-desc">{k.desc}</span>
                        <kbd class="keybind-keys">{k.keys}</kbd>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <div class="keybind-empty">无匹配</div>
            </Show>
          </div>
        </div>
      </div>
    )
  }

  // ─── AnimatedNumber: 平滑数字过渡（P2-20） ───────────────────────────────
  function AnimatedNumber(props: { value: number; duration?: number }) {
    const [display, setDisplay] = createSignal(props.value)
    createEffect(() => {
      const target = props.value
      const start = display()
      if (start === target) return
      const dur = props.duration ?? 500
      const t0 = performance.now()
      let rafId = 0
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / dur)
        const eased = 1 - Math.pow(1 - p, 3)  // easeOutCubic
        setDisplay(Math.round(start + (target - start) * eased))
        if (p < 1) rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
      onCleanup(() => cancelAnimationFrame(rafId))
    })
    return <>{display().toLocaleString()}</>
  }

  // ─── SlashCommandPalette ──────────────────────────────────────────────────
  function SlashCommandPalette() {
    const pos = paletteRect()
    return (
      <Show when={showSlash() && filteredSlash().length > 0}>
        <div
          class="slash-palette"
          style={`position:fixed;bottom:${pos.bottom}px;left:${pos.left}px;width:${pos.width}px;z-index:9999`}
        >
          <For each={filteredSlash()}>
            {(cmd, idx) => (
              <div
                class="slash-item"
                classList={{ active: slashIdx() === idx() }}
                onMouseEnter={() => setSlashIdx(idx())}
                onMouseDown={(e) => { e.preventDefault(); execSlashCommand(cmd.name) }}
              >
                <span class="slash-icon">{cmd.icon}</span>
                <div class="slash-item-text">
                  <span class="slash-cmd-name">/{cmd.name}</span>
                  <span class="slash-cmd-desc">{cmd.desc}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    )
  }

  // ─── FileMentionDropdown ──────────────────────────────────────────────────
  function FileMentionDropdown() {
    return (
      <Show when={showMention()}>
        <div
          class="slash-palette mention-palette"
          style={`position:fixed;bottom:${paletteRect().bottom}px;left:${paletteRect().left}px;width:${paletteRect().width}px;z-index:9999`}
        >
          {/* 加载中状态 */}
          <Show when={wsFileCacheLoading() && mentionFiles().length === 0}>
            <div class="slash-item mention-loading">
              <svg class="mention-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span style="color:var(--text-faint);font-size:12px">正在加载文件列表…</span>
            </div>
          </Show>
          {/* 无结果 */}
          <Show when={!wsFileCacheLoading() && mentionFiles().length === 0}>
            <div class="slash-item mention-empty">
              <span style="color:var(--text-faint);font-size:12px">未找到匹配文件</span>
            </div>
          </Show>
          {/* 文件列表 */}
          <Show when={mentionFiles().length > 0}>
            <div class="mention-header">
              <span>{activeWorkspace()?.name ?? '工作区'}</span>
              <span class="mention-count">{wsFileCache()?.files.length ?? 0} 个文件</span>
            </div>
            <div class="mention-list">
              <For each={mentionFiles()}>
                {(file, idx) => {
                  const parts = file.split('/')
                  const filename = parts.pop() ?? file
                  const dir = parts.length > 0 ? parts.join('/') : ''
                  // 高亮匹配部分
                  const q = mentionQuery().toLowerCase()
                  const hiName = () => {
                    if (!q) return filename
                    const i = filename.toLowerCase().indexOf(q)
                    if (i < 0) return filename
                    return `${filename.slice(0, i)}<mark>${filename.slice(i, i + q.length)}</mark>${filename.slice(i + q.length)}`
                  }
                  return (
                    <div
                      class="slash-item"
                      classList={{ active: mentionIdx() === idx() }}
                      onMouseEnter={() => setMentionIdx(idx())}
                      onMouseDown={(e) => { e.preventDefault(); insertMention(file) }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="1.8" style="flex-shrink:0">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <div class="slash-item-text">
                        <span class="slash-cmd-name" innerHTML={hiName()} />
                        <span class="slash-cmd-desc">{dir ? `/${dir}` : '/'}</span>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    )
  }

  // ─── ModeSelector ────────────────────────────────────────────────────────
  const MODE_OPTIONS: { id: ComposerMode; label: string; desc: string; color: string; paths: string[] }[] = [
    {
      id: 'ask',
      label: '询问权限',
      desc: '工具调用时请求许可',
      color: '#a78bfa',
      paths: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
    },
    {
      id: 'code',
      label: '接受编辑',
      desc: '自动接受文件修改（默认）',
      color: '#34d399',
      paths: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
    },
    {
      id: 'plan',
      label: '计划模式',
      desc: 'AI 只规划，不执行操作',
      color: '#fbbf24',
      paths: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8"],
    },
    {
      id: 'bypass',
      label: '跳过权限',
      desc: '跳过所有工具权限确认',
      color: '#f87171',
      paths: ["M5 12h14", "M12 5l7 7-7 7"],
    },
  ]

  function ModeSvgIcon(props: { paths: string[]; color: string; size?: number }) {
    const sz = props.size ?? 14
    return (
      <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke={props.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        {props.paths.map(p => <path d={p} />)}
      </svg>
    )
  }

  function ModeSelector() {
    const currentOpt = () => MODE_OPTIONS.find(o => o.id === composerMode()) ?? MODE_OPTIONS[1]
    return (
      <div class="mode-selector-wrap">
        <button
          class="mode-selector-btn"
          classList={{ open: showModeDropdown() }}
          onClick={(e) => {
            e.stopPropagation()
            setShowModeDropdown(v => !v)
          }}
          title="选择操作模式"
        >
          <ModeSvgIcon paths={currentOpt().paths} color={currentOpt().color} size={12} />
          <span class="mode-selector-label">{currentOpt().label}</span>
          <svg class="mode-selector-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <Show when={showModeDropdown()}>
          <div class="mode-selector-popup">
            <For each={MODE_OPTIONS}>
              {(opt, idx) => (
                <button
                  class="mode-option-item"
                  classList={{ active: composerMode() === opt.id }}
                  onClick={async (e) => {
                    e.stopPropagation()
                    const prevMode = composerMode()
                    if (prevMode === opt.id) { setShowModeDropdown(false); return }
                    setComposerMode(opt.id)
                    setShowModeDropdown(false)
                    const sid = activeSessionId()
                    if (sid) {
                      try {
                        const c = await getClient()
                        await c.updateSessionMode(sid, opt.id)
                      } catch { /* 忽略 */ }
                    }
                    // 仅在真正切换模式时才插入提示消息
                    if (opt.id === 'plan') {
                      setMessages(prev => [...prev, {
                        id: String(++msgId), role: "system",
                        createdAt: Date.now(),
                        content: "📋 已进入计划模式：AI 只规划，不执行文件操作"
                      }])
                    } else if (prevMode === 'plan') {
                      setMessages(prev => [...prev, {
                        id: String(++msgId), role: "system",
                        createdAt: Date.now(),
                        content: "⚡ 已退出计划模式"
                      }])
                    }
                  }}
                >
                  <span class="mode-option-num">{idx() + 1}</span>
                  <ModeSvgIcon paths={opt.paths} color={opt.color} size={13} />
                  <div class="mode-option-text">
                    <span class="mode-option-label">{opt.label}</span>
                    <span class="mode-option-desc">{opt.desc}</span>
                  </div>
                  <Show when={composerMode() === opt.id}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" style="flex-shrink:0;margin-left:auto">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    )
  }

  // ─── GitStatusBar ─────────────────────────────────────────────────────────
  let gitBranchBtnRef: HTMLButtonElement | undefined

  async function loadBranchPicker() {
    const ws = activeWorkspace()
    if (!ws) return
    setBranchPickerLoading(true)
    try {
      const c = await getClient()
      const br = await c.listBranches(ws.id)
      setBranchPickerBranches(br.branches ?? [])
    } catch { /* 忽略 */ } finally {
      setBranchPickerLoading(false)
    }
  }

  function openBranchPicker(e: MouseEvent) {
    e.stopPropagation()
    if (showBranchPicker()) { setShowBranchPicker(false); return }
    // 计算弹窗位置
    const btn = gitBranchBtnRef
    if (btn) {
      const rect = btn.getBoundingClientRect()
      setBranchPickerRect({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
    }
    setBranchPickerSearch("")
    setShowBranchPicker(true)
    void loadBranchPicker()
  }

  async function switchBranch(branch: string) {
    const ws = activeWorkspace()
    if (!ws || branch === currentBranch()) { setShowBranchPicker(false); return }
    setShowBranchPicker(false)
    try {
      const c = await getClient()
      const r = await c.checkoutBranch(ws.id, branch)
      if (r.ok) {
        setCurrentBranch(branch)
      } else {
        alert(`切换分支失败：${r.error ?? '未知错误'}`)
      }
    } catch (e) {
      alert(`切换分支失败：${(e as Error).message}`)
    }
  }

  function GitStatusBar() {
    return (
      <Show when={activeWorkspace()}>
        <div class="git-status-bar">
          <div class="git-status-left">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-faint);flex-shrink:0">
              <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            <Show when={currentBranch() !== null} fallback={
              <span class="git-status-text">非 Git 仓库</span>
            }>
              <button
                ref={gitBranchBtnRef}
                class="git-status-branch-btn"
                onClick={openBranchPicker}
                title="切换分支"
              >
                {currentBranch()}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
            </Show>
          </div>
        </div>
        {/* 分支选择弹窗 — fixed 定位避免被 overflow 裁剪 */}
        <Show when={showBranchPicker() && currentBranch() !== null}>
          <div
            class="branch-picker-popup"
            style={`position:fixed;bottom:${branchPickerRect().bottom}px;left:${branchPickerRect().left}px;z-index:9999`}
          >
            <div class="branch-picker-header">
              <input
                class="branch-picker-search"
                placeholder="搜索分支…"
                value={branchPickerSearch()}
                onInput={(e) => setBranchPickerSearch(e.currentTarget.value)}
                autofocus
              />
            </div>
            <div class="branch-picker-list">
              <Show when={branchPickerLoading()}>
                <div class="branch-picker-loading">
                  <span class="spinner" style="width:12px;height:12px;border-width:1.5px" />
                </div>
              </Show>
              <Show when={!branchPickerLoading()}>
                <For each={branchPickerBranches().filter(b => {
                  const q = branchPickerSearch().toLowerCase()
                  return !q || b.toLowerCase().includes(q)
                })}>
                  {(b) => (
                    <button
                      class="branch-picker-item"
                      classList={{ current: b === currentBranch() }}
                      onClick={() => switchBranch(b)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--text-faint)">
                        <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                      </svg>
                      <span class="branch-picker-name">{b}</span>
                      <Show when={b === currentBranch()}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--accent);flex-shrink:0;margin-left:auto">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={branchPickerBranches().filter(b => {
                  const q = branchPickerSearch().toLowerCase()
                  return !q || b.toLowerCase().includes(q)
                }).length === 0}>
                  <div style="padding:10px 12px;font-size:11px;color:var(--text-faint)">无匹配分支</div>
                </Show>
              </Show>
            </div>
            <div class="branch-picker-footer">
              <button
                class="branch-picker-create-btn"
                onClick={() => {
                  setShowBranchPicker(false)
                  setShowSettings(true)
                  setSettingsTab("worktree")
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                创建并检出新分支…
              </button>
            </div>
          </div>
        </Show>
      </Show>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* 登录/启动状态也需要给 traffic lights 留空（Overlay 模式） */}
      <Show when={appStatus() !== "ready"}>
        <div class="window-titlebar-placeholder" data-tauri-drag-region />
      </Show>

      {/* Login */}
      <Show when={appStatus() === "login"}>
        <div class="login-screen">
          <div class="login-card">
            <div class="login-hero">
              <img class="login-avatar" src={logoUrl} alt="Maxian" />
              <div class="login-brand">码弦</div>
              <div class="login-sub">智能 AI 编程助手</div>
            </div>
            <div class="login-form">
              <Show when={loginError()}>
                <div class="login-error">{loginError()}</div>
              </Show>
              <div class="login-field">
                <label class="login-label">服务器地址</label>
                <input class="login-input" type="url" placeholder="例如: http://10.205.81.162/api"
                  value={loginApiUrl()} onInput={(e) => setLoginApiUrl(e.currentTarget.value)}
                  disabled={loginLoading()} />
              </div>
              <div class="login-field">
                <label class="login-label">用户名</label>
                <input class="login-input" type="text" placeholder="请输入用户名" autocomplete="username"
                  value={loginUsername()} onInput={(e) => setLoginUsername(e.currentTarget.value)}
                  disabled={loginLoading()} />
              </div>
              <div class="login-field">
                <label class="login-label">密码</label>
                <input class="login-input" type="password" placeholder="请输入密码" autocomplete="current-password"
                  value={loginPassword()} onInput={(e) => setLoginPassword(e.currentTarget.value)}
                  disabled={loginLoading()}
                  onKeyDown={(e) => { if (e.key === "Enter") handleLogin() }} />
              </div>
              <label class="login-remember">
                <input type="checkbox" checked={loginRemember()}
                  onChange={(e) => setLoginRemember(e.currentTarget.checked)} disabled={loginLoading()} />
                记住登录状态
              </label>
              <button class="login-btn" onClick={handleLogin}
                disabled={loginLoading() || !loginUsername().trim() || !loginPassword()}>
                <Show when={loginLoading()} fallback="登录">
                  <span class="spinner" style="width:14px;height:14px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />
                  登录中…
                </Show>
              </button>
            </div>
            <div class="login-footer">首次登录？请联系管理员获取账号</div>
          </div>
        </div>
      </Show>

      {/* Booting */}
      <Show when={appStatus() === "booting"}>
        <div class="boot-screen">
          <img class="boot-logo" src={logoUrl} alt="Maxian" />
          <div class="spinner" />
          <span>正在连接 Maxian Server…</span>
        </div>
      </Show>

      {/* Error */}
      <Show when={appStatus() === "error"}>
        <div class="boot-screen">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span style="font-weight:600;color:var(--text-base)">启动失败</span>
          <pre>{bootError()}</pre>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" onClick={handleLogout}>重新登录</button>
            <button class="btn btn-primary" onClick={() => bootWithCredentials(loadSavedCredentials()!)}>重试</button>
          </div>
        </div>
      </Show>

      {/* Ready */}
      <Show when={appStatus() === "ready"}>
        {/* 自定义标题栏（macOS Overlay 模式，替代原生标题栏） */}
        <div class="window-titlebar" data-tauri-drag-region>
          <img class="window-title-logo" src={logoUrl} alt="" data-tauri-drag-region />
          <span class="window-title-text" data-tauri-drag-region>码弦 Maxian</span>
        </div>

        {/* Slash 命令面板 & @ 文件提及 — fixed 定位，渲染在最外层避免 z-index 问题 */}
        <SlashCommandPalette />
        <FileMentionDropdown />

        <div class="app-shell" data-mode={globalMode()}>
          <Sidebar />

          {/* 自动更新提示 Toast */}
          <Show when={updateAvailable()}>
            <div class="update-toast">
              <div class="update-toast-content">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                  <polyline points="17 6 23 6 23 12"/>
                </svg>
                <span>新版本 <strong>{updateVersion()}</strong> 已就绪</span>
                <button class="btn btn-primary" style="font-size:11px;padding:3px 10px" onClick={installUpdateFromToast}>立即更新</button>
                <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onClick={() => setUpdateAvailable(false)}>稍后</button>
              </div>
            </div>
          </Show>

          {/* 工具审批对话框（阻塞式） */}
          <Show when={approvalRequest()}>
            <ApprovalDialog />
          </Show>
          {/* Agent 提问对话框 */}
          <Show when={questionRequest()}>
            <QuestionDialog />
          </Show>
          {/* Plan Exit 对话框 */}
          <Show when={planExitRequest()}>
            <PlanExitDialog />
          </Show>
          {/* 应用代码到文件对话框（P0-2） */}
          <Show when={applyDialog().open}>
            <ApplyToFileDialog />
          </Show>


          {/* Settings view */}
          <Show when={showSettings()}>
            <div class="settings-shell">
              <nav class="settings-nav">
                <button class="settings-nav-back" onClick={() => setShowSettings(false)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                  返回应用
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "general" }} onClick={() => setSettingsTab("general")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                  常规
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "appearance" }} onClick={() => setSettingsTab("appearance")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
                  </svg>
                  外观
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "worktree" }} onClick={() => setSettingsTab("worktree")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                  </svg>
                  Git Worktree
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "mcp" }} onClick={() => setSettingsTab("mcp")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                  MCP Servers
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "keybinds" }} onClick={() => setSettingsTab("keybinds")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/>
                  </svg>
                  快捷键
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "templates" }} onClick={() => setSettingsTab("templates")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
                  </svg>
                  会话模板
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "usage" }} onClick={() => setSettingsTab("usage")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
                  </svg>
                  Token 用量
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "errors" }} onClick={() => setSettingsTab("errors")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  错误日志
                  <Show when={errorLog().length > 0}>
                    <span class="file-badge">{errorLog().length}</span>
                  </Show>
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "plugins" }} onClick={() => setSettingsTab("plugins")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                  插件开发
                </button>
                <button class="settings-nav-item" classList={{ active: settingsTab() === "about" }} onClick={() => setSettingsTab("about")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  关于
                </button>
              </nav>
              <div class="settings-content">
                <Show when={settingsTab() === "general"}><SettingsGeneral /></Show>
                <Show when={settingsTab() === "appearance"}><SettingsAppearance /></Show>
                <Show when={settingsTab() === "worktree"}><SettingsWorktree /></Show>
                <Show when={settingsTab() === "mcp"}><SettingsMcp /></Show>
                <Show when={settingsTab() === "keybinds"}><SettingsKeybinds /></Show>
                <Show when={settingsTab() === "templates"}><SettingsTemplates /></Show>
                <Show when={settingsTab() === "usage"}><SettingsUsage /></Show>
                <Show when={settingsTab() === "errors"}><SettingsErrors /></Show>
                <Show when={settingsTab() === "plugins"}><SettingsPlugins /></Show>
                <Show when={settingsTab() === "about"}><SettingsAbout /></Show>
              </div>
            </div>
          </Show>

          {/* Chat view */}
          <Show when={!showSettings()}>
            <main class="main">
              {/* Chat header — mode badge + new session */}
              <div class="chat-header">
                <div class="chat-header-left">
                  <Show when={composerMode() === 'plan'}>
                    <span class="mode-badge mode-badge-plan">📋 Plan</span>
                  </Show>
                  <Show when={composerMode() !== 'plan' && globalMode() === 'code'}>
                    <span class="mode-badge mode-badge-code">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="16 18 22 12 16 6"/>
                        <polyline points="8 6 2 12 8 18"/>
                      </svg>
                      Code
                    </span>
                  </Show>
                  <Show when={composerMode() !== 'plan' && globalMode() === 'chat'}>
                    <span class="mode-badge mode-badge-chat">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                      Chat
                    </span>
                  </Show>
                </div>
                <div class="chat-header-right">
                  {/* Context 标签页（P1-10） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showContextPanel() }}
                    onClick={() => setShowContextPanel(v => !v)}
                    title="会话上下文"
                    style="position:relative"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M20 7h-3V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
                      <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    <Show when={contextFiles().length > 0 || attachedImages().length > 0}>
                      <span class="file-badge">{contextFiles().length + attachedImages().length}</span>
                    </Show>
                  </button>
                  {/* Session revert dock（P1-11） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showRevertDock() }}
                    onClick={() => setShowRevertDock(v => !v)}
                    title="回退对话"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                  </button>
                  {/* 消息过滤器（P1-13） */}
                  <div style="position:relative">
                    <button
                      class="icon-btn"
                      classList={{ active: msgFilter().hideTodos || msgFilter().hideReasoning || msgFilter().hideInternalTools }}
                      onClick={() => setShowFilterMenu(v => !v)}
                      title="消息过滤"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                      </svg>
                    </button>
                    <Show when={showFilterMenu()}>
                      <div class="filter-menu" onClick={(e) => e.stopPropagation()}>
                        <div class="filter-menu-title">消息过滤</div>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideReasoning}
                            onChange={(e) => updateMsgFilter({ hideReasoning: e.currentTarget.checked })} />
                          <span>隐藏思考过程（reasoning）</span>
                        </label>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideTodos}
                            onChange={(e) => updateMsgFilter({ hideTodos: e.currentTarget.checked })} />
                          <span>隐藏待办工具调用</span>
                        </label>
                        <label class="filter-menu-item">
                          <input type="checkbox" checked={msgFilter().hideInternalTools}
                            onChange={(e) => updateMsgFilter({ hideInternalTools: e.currentTarget.checked })} />
                          <span>隐藏内部工具（load_skill 等）</span>
                        </label>
                      </div>
                    </Show>
                  </div>
                  {/* 集成终端切换按钮 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showTerminal() }}
                    onClick={() => {
                      if (!showTerminal()) {
                        void addTerminalTab()
                      } else {
                        setShowTerminal(v => !v)
                      }
                    }}
                    title="终端 (⌘`)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                    </svg>
                  </button>
                  {/* 工作区文件浏览器（预览任意文件） */}
                  <button
                    class="icon-btn"
                    classList={{ active: showExplorer() }}
                    onClick={() => setShowExplorer(v => !v)}
                    title="文件浏览器"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>
                    </svg>
                  </button>
                  {/* Skills 面板 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showSkillsPanel() }}
                    onClick={() => setShowSkillsPanel(v => !v)}
                    title="Skills 技能文档"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2l2.5 7.5H22l-6 4.5 2.5 7.5L12 17l-6.5 4.5L8 14 2 9.5h7.5z"/>
                    </svg>
                  </button>
                  {/* 变更记录按钮（有变更时显示角标），点击在右侧打开 */}
                  <button
                    class="icon-btn"
                    classList={{ active: showFileTree() }}
                    onClick={() => setShowFileTree(v => !v)}
                    title="变更记录"
                    style="position:relative"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <Show when={changedFiles().size > 0}>
                      <span class="file-badge"><AnimatedNumber value={changedFiles().size} duration={300} /></span>
                    </Show>
                  </button>
                </div>
              </div>

              <Show when={sending()}>
                <div class="progress-bar"><div class="progress-bar-inner" /></div>
              </Show>

              {/* 会话内搜索条（P0-3: Cmd+F） */}
              <Show when={showInChatSearch() && activeSessionId()}>
                <div class="in-chat-search-bar">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    ref={inChatSearchInputRef}
                    class="in-chat-search-input"
                    placeholder="在会话中查找…"
                    value={inChatSearchQuery()}
                    onInput={(e) => { setInChatSearchQuery(e.currentTarget.value); setInChatSearchIdx(0); queueMicrotask(() => { if (inChatSearchHits().length > 0) jumpToSearchHit(0) }) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); closeInChatSearch() }
                      else if (e.key === 'Enter') {
                        e.preventDefault()
                        const hits = inChatSearchHits()
                        if (hits.length === 0) return
                        jumpToSearchHit(e.shiftKey ? inChatSearchIdx() - 1 : inChatSearchIdx() + 1)
                      }
                    }}
                  />
                  <span class="in-chat-search-count">
                    <Show
                      when={inChatSearchHits().length > 0}
                      fallback={<span style="opacity:.55">{inChatSearchQuery() ? '无结果' : ''}</span>}
                    >
                      {inChatSearchIdx() + 1} / {inChatSearchHits().length}
                    </Show>
                  </span>
                  <button
                    class="in-chat-search-btn"
                    title="上一个 (Shift+Enter)"
                    onClick={() => jumpToSearchHit(inChatSearchIdx() - 1)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <button
                    class="in-chat-search-btn"
                    title="下一个 (Enter)"
                    onClick={() => jumpToSearchHit(inChatSearchIdx() + 1)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <button class="in-chat-search-btn" title="关闭 (Esc)" onClick={closeInChatSearch}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              </Show>

              <Show
                when={activeSessionId()}
                fallback={
                  <div class="empty-state">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="color:var(--text-faint)">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <div class="title">开始对话</div>
                    <div class="sub">从左侧选择会话，或点击右上角 ✏ 创建新会话</div>
                  </div>
                }
              >
                <div
                  class="chat-timeline"
                  ref={chatTimelineRef}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    // 滚到顶部 80px 内时触发加载更多
                    if (el.scrollTop < 80 && msgHasMore() && !msgLoadingMore()) {
                      void loadMoreMessages()
                    }
                    // 贴底跟踪：用户近底 → 保持 auto-scroll；离底 → 暂停（不打断阅读）
                    stickToBottom = isNearBottom(el)
                  }}
                  onClick={(e) => {
                    const target = e.target as HTMLElement
                    if (!target) return
                    // P0-1: 文件位置跳转
                    const jumpEl = target.closest('[data-file-jump]') as HTMLElement | null
                    if (jumpEl) {
                      e.preventDefault()
                      e.stopPropagation()
                      const file = jumpEl.getAttribute('data-file-jump') ?? ''
                      const line = parseInt(jumpEl.getAttribute('data-line-jump') ?? '0', 10) || undefined
                      if (file) void openPreview(file, { viewMode: 'source', line })
                      return
                    }
                    // P0-2: 应用代码到文件
                    const applyEl = target.closest('[data-apply="1"]') as HTMLElement | null
                    if (applyEl) {
                      e.preventDefault()
                      e.stopPropagation()
                      const b64 = applyEl.getAttribute('data-code-b64') ?? ''
                      const lang = applyEl.getAttribute('data-lang') ?? undefined
                      try {
                        const text = decodeURIComponent(escape(atob(b64)))
                        openApplyToFileDialog(text, lang)
                      } catch {
                        showToast({ message: '代码解码失败', kind: 'error' })
                      }
                    }
                  }}
                >
                  {/* 顶部加载提示 */}
                  <Show when={msgHasMore() || msgLoadingMore()}>
                    <div class="msg-load-more">
                      <Show
                        when={msgLoadingMore()}
                        fallback={
                          <button class="msg-load-more-btn" onClick={loadMoreMessages}>
                            加载更早的消息
                          </button>
                        }
                      >
                        <span class="msg-load-more-spinning">加载中…</span>
                      </Show>
                    </div>
                  </Show>
                  {/* P1-6: 虚拟化兜底提示（超阈值时仅渲染最近 N 条） */}
                  <Show when={vgTruncatedCount() > 0}>
                    <div class="msg-load-more" style="padding:6px 8px">
                      <button class="msg-load-more-btn" onClick={() => setVgExpandAll(true)}>
                        为保持流畅，已折叠 {vgTruncatedCount()} 条较早的消息 · 点击展开全部
                      </button>
                    </div>
                  </Show>
                  <For each={viewGroups()}>
                    {(vg, idx) => {
                      const isFocused = () => focusedMsgIdx() === idx()
                      const wrap = (children: any) => (
                        <div
                          data-msg-idx={idx()}
                          classList={{ 'msg-focused': isFocused() }}
                          onClick={() => setFocusedMsgIdx(idx())}
                        >
                          {children}
                        </div>
                      )
                      /* ── 工具批次 ── */
                      if (vg.kind === 'tool-batch') {
                        const batch = vg
                        const anyRunning = () => batch.tools.some(t => t.isPartial)
                        const showExpanded = () => expandedTools().has(batch.id) || anyRunning()
                        return wrap(
                          <div class="tool-batch-wrap">
                            <Show
                              when={showExpanded()}
                              fallback={
                                /* 收起状态：单行摘要 */
                                <div class="tool-batch-row" onClick={() => toggleTool(batch.id)}>
                                  <div class="tool-batch-dots">
                                    <For each={batch.tools.slice(0, 7)}>
                                      {(t) => (
                                        <span class={`batch-dot ${t.toolSuccess ? 'batch-dot-ok' : t.toolSuccess === false ? 'batch-dot-err' : 'batch-dot-ok'}`} />
                                      )}
                                    </For>
                                    <Show when={batch.tools.length > 7}>
                                      <span class="batch-dot-more">+{batch.tools.length - 7}</span>
                                    </Show>
                                  </div>
                                  <span class="tool-batch-label">已执行 {batch.tools.length} 个工具</span>
                                  <svg class="batch-expand-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                    <polyline points="6 9 12 15 18 9"/>
                                  </svg>
                                </div>
                              }
                            >
                              {/* 展开状态 */}
                              <div class="tool-batch-expanded">
                                {/* 头部行 */}
                                <Show
                                  when={anyRunning()}
                                  fallback={
                                    <div class="tool-batch-row tool-batch-done-header" onClick={() => toggleTool(batch.id)}>
                                      <div class="tool-batch-dots">
                                        <For each={batch.tools.slice(0, 7)}>
                                          {(t) => <span class={`batch-dot ${t.toolSuccess ? 'batch-dot-ok' : 'batch-dot-err'}`} />}
                                        </For>
                                        <Show when={batch.tools.length > 7}>
                                          <span class="batch-dot-more">+{batch.tools.length - 7}</span>
                                        </Show>
                                      </div>
                                      <span class="tool-batch-label">{batch.tools.length} 个工具调用</span>
                                      <svg class="batch-expand-icon batch-expand-up" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                        <polyline points="6 9 12 15 18 9"/>
                                      </svg>
                                    </div>
                                  }
                                >
                                  <div class="tool-batch-row tool-batch-running-header">
                                    <span class="batch-spinner-dot" />
                                    <span class="batch-spinner-dot" style="animation-delay:0.2s" />
                                    <span class="batch-spinner-dot" style="animation-delay:0.4s" />
                                    <span class="tool-batch-label" style="margin-left:4px">
                                      执行工具… ({batch.tools.filter(t => !t.isPartial).length}/{batch.tools.length})
                                    </span>
                                  </div>
                                </Show>
                                {/* 工具列表 */}
                                <div class="tool-batch-items">
                                  <For each={batch.tools}>
                                    {(t) => {
                                      // 提取被修改的文件路径（用于点击跳转到预览 diff 视图）
                                      const fileModTools = new Set(['edit', 'write_to_file', 'multiedit', 'apply_patch']);
                                      const hasFileDiff = () => !t.isPartial && fileModTools.has(t.toolName ?? '');
                                      const targetPath = () => {
                                        const p = t.toolParams?.path as string | undefined;
                                        return p && typeof p === 'string' ? p : '';
                                      };
                                      return (
                                      <div
                                        class="tool-item-row"
                                        classList={{ 'tool-item-row-clickable': hasFileDiff() && !!targetPath() }}
                                        onClick={() => {
                                          if (hasFileDiff() && targetPath()) {
                                            openPreview(targetPath(), { viewMode: 'diff' })
                                          }
                                        }}
                                      >
                                        <Show
                                          when={t.isPartial}
                                          fallback={
                                            <span class={`batch-dot ${t.toolSuccess ? 'batch-dot-ok' : 'batch-dot-err'}`} style="flex-shrink:0" />
                                          }
                                        >
                                          <span class="tool-item-running-dot" />
                                        </Show>
                                        <span class={`tool-item-name ${t.isPartial ? 'tool-item-name-running' : ''}`}>
                                          {getToolLabel(t.toolName ?? '')}
                                        </span>
                                        <Show when={getToolSubtitle(t.toolName ?? '', t.toolParams)}>
                                          <span class="tool-item-path">{getToolSubtitle(t.toolName ?? '', t.toolParams)}</span>
                                        </Show>
                                        <Show when={hasFileDiff() && targetPath()}>
                                          <span class="tool-item-view-diff">
                                            查看 diff →
                                          </span>
                                        </Show>
                                        {/* 流式生成工具 JSON 中 —— 显示实时字数 + 预览 */}
                                        <Show when={t.isPartial && t.content && t.content.length > 0}>
                                          <div class="tool-item-streaming">
                                            <span class="tool-item-streaming-label">
                                              <span class="tool-item-running-dot" />
                                              生成参数中… {t.content.length} 字
                                            </span>
                                            <code class="diff-code tool-item-streaming-preview">
                                              {t.content.slice(-200)}
                                            </code>
                                          </div>
                                        </Show>
                                        {/* edit 展示变更内容（前 5 行 old/new 对照） */}
                                        <Show when={!t.isPartial && t.toolName === 'edit' && (t.toolParams?.old_string || t.toolParams?.new_string)}>
                                          <div class="tool-item-diff">
                                            <Show when={t.toolParams?.old_string}>
                                              <div class="tool-diff-del">
                                                <span class="diff-sign">−</span>
                                                <code class="diff-code">{String(t.toolParams!.old_string).split('\n').slice(0, 5).join('\n')}{String(t.toolParams!.old_string).split('\n').length > 5 ? '\n…' : ''}</code>
                                              </div>
                                            </Show>
                                            <Show when={t.toolParams?.new_string}>
                                              <div class="tool-diff-add">
                                                <span class="diff-sign">+</span>
                                                <code class="diff-code">{String(t.toolParams!.new_string).split('\n').slice(0, 5).join('\n')}{String(t.toolParams!.new_string).split('\n').length > 5 ? '\n…' : ''}</code>
                                              </div>
                                            </Show>
                                          </div>
                                        </Show>
                                        {/* multiedit 展示每一条编辑对照（前 3 条） */}
                                        <Show when={!t.isPartial && t.toolName === 'multiedit' && Array.isArray(t.toolParams?.edits)}>
                                          <div class="tool-item-diff">
                                            <For each={(t.toolParams!.edits as any[]).slice(0, 3)}>
                                              {(ed, i) => (
                                                <>
                                                  <div class="tool-diff-del">
                                                    <span class="diff-sign">−</span>
                                                    <code class="diff-code">{String(ed.old_string ?? ed.oldString ?? '').split('\n').slice(0, 3).join('\n')}</code>
                                                  </div>
                                                  <div class="tool-diff-add">
                                                    <span class="diff-sign">+</span>
                                                    <code class="diff-code">{String(ed.new_string ?? ed.newString ?? '').split('\n').slice(0, 3).join('\n')}</code>
                                                  </div>
                                                  <Show when={i() < Math.min(2, (t.toolParams!.edits as any[]).length - 1)}>
                                                    <div class="tool-diff-sep" />
                                                  </Show>
                                                </>
                                              )}
                                            </For>
                                            <Show when={(t.toolParams!.edits as any[]).length > 3}>
                                              <div class="tool-diff-more">
                                                … 还有 {(t.toolParams!.edits as any[]).length - 3} 处编辑，点击查看完整 diff
                                              </div>
                                            </Show>
                                          </div>
                                        </Show>
                                        {/* write_to_file 展示前 5 行新内容 */}
                                        <Show when={!t.isPartial && t.toolName === 'write_to_file' && t.toolParams?.content}>
                                          <div class="tool-item-diff">
                                            <div class="tool-diff-add">
                                              <span class="diff-sign">+</span>
                                              <code class="diff-code">{String(t.toolParams!.content).split('\n').slice(0, 5).join('\n')}{String(t.toolParams!.content).split('\n').length > 5 ? `\n… 共 ${String(t.toolParams!.content).split('\n').length} 行` : ''}</code>
                                            </div>
                                          </div>
                                        </Show>
                                        {/* bash / execute_command 流式输出（实时 stdout/stderr） */}
                                        <Show when={(t.toolName === 'bash' || t.toolName === 'execute_command') && t.liveOutput && t.liveOutput.length > 0}>
                                          <div class="bash-live-output" onClick={(e) => e.stopPropagation()}>
                                            <div class="bash-live-header">
                                              <Show when={t.isPartial}>
                                                <span class="bash-live-dot" />
                                              </Show>
                                              <span class="bash-live-label">
                                                {t.isPartial ? '执行中…' : '输出'}
                                              </span>
                                              <span class="bash-live-bytes">{(t.liveOutput ?? '').length} 字</span>
                                            </div>
                                            <pre
                                              class="bash-live-body"
                                              ref={(el) => {
                                                createEffect(() => {
                                                  const _ = t.liveOutput  // track reactivity
                                                  if (el) el.scrollTop = el.scrollHeight
                                                })
                                              }}
                                            >{(t.liveOutput ?? '').length > 8000 ? '…' + (t.liveOutput ?? '').slice(-8000) : (t.liveOutput ?? '')}</pre>
                                          </div>
                                        </Show>
                                      </div>
                                      )
                                    }}
                                  </For>
                                </div>
                              </div>
                            </Show>
                          </div>
                        )
                      }

                      /* ── 普通消息 ── */
                      const msg = vg.data
                      return wrap(
                        <>
                          <Show when={msg.role === 'user'}>
                            <div class="turn">
                              <div class="turn-user">
                                <div class="turn-user-col">
                                  <Show when={editingMessageId() === msg.id} fallback={
                                    <div class="turn-user-bubble">{msg.content}</div>
                                  }>
                                    <textarea
                                      class="turn-user-bubble msg-edit-input"
                                      value={editingMessageContent()}
                                      onInput={(e) => setEditingMessageContent(e.currentTarget.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') setEditingMessageId(null)
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                          e.preventDefault(); commitEditMessage(msg.id)
                                        }
                                      }}
                                      ref={(el) => setTimeout(() => el?.focus(), 10)}
                                    />
                                    <div class="msg-edit-actions">
                                      <button class="btn btn-ghost" onClick={() => setEditingMessageId(null)}>取消 (Esc)</button>
                                      <button class="btn btn-primary" onClick={() => commitEditMessage(msg.id)}>保存并重跑 (⌘↵)</button>
                                    </div>
                                  </Show>
                                  <Show when={editingMessageId() !== msg.id}>
                                    <div class="msg-actions-row">
                                      <Show when={msg.createdAt}>
                                        <span class="msg-timestamp msg-timestamp-right">{formatFullTime(msg.createdAt)}</span>
                                      </Show>
                                      <div class="msg-hover-actions">
                                        <button class="msg-action-btn" title="编辑并重跑" onClick={() => { setEditingMessageContent(msg.content); setEditingMessageId(msg.id) }}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                          </svg>
                                        </button>
                                        <button class="msg-action-btn" title="从此消息分叉新会话" onClick={() => forkFromMessage(msg.id)}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <circle cx="6" cy="3" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="21" r="3"/>
                                            <path d="M6 6v15"/><path d="M18 9a9 9 0 0 1-9 9"/>
                                          </svg>
                                        </button>
                                        <button class="msg-action-btn del" title="删除" onClick={() => deleteMessage(msg.id)}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="3 6 5 6 21 6"/>
                                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </Show>
                          <Show when={msg.role === 'assistant'}>
                            <div class="turn">
                              <div class="turn-assistant">
                                <img class="assistant-avatar" src={logoUrl} alt="AI" />
                                <div class="turn-assistant-content">
                                  <div
                                    class="md"
                                    innerHTML={renderMarkdown(
                                      msg.isPartial && msg.content.length > 0
                                        ? msg.content + ' ▌'
                                        : msg.content
                                    )}
                                  />
                                  <Show when={!msg.isPartial}>
                                    <div class="msg-actions-row">
                                      <Show when={msg.createdAt}>
                                        <span class="msg-timestamp">{formatFullTime(msg.createdAt)}</span>
                                      </Show>
                                      <div class="msg-hover-actions">
                                        <button class="msg-action-btn" title="重新生成" onClick={() => regenerateMessage(msg.id)}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="23 4 23 10 17 10"/>
                                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                          </svg>
                                        </button>
                                        <button class="msg-action-btn" title="从此消息分叉新会话" onClick={() => forkFromMessage(msg.id)}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <circle cx="6" cy="3" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="21" r="3"/>
                                            <path d="M6 6v15"/><path d="M18 9a9 9 0 0 1-9 9"/>
                                          </svg>
                                        </button>
                                        <button class="msg-action-btn del" title="删除" onClick={() => deleteMessage(msg.id)}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="3 6 5 6 21 6"/>
                                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </Show>
                          <Show when={msg.role === 'reasoning'}>
                            <div class="reasoning-wrap">
                              <div class={`reasoning-block ${msg.isPartial ? 'reasoning-streaming' : ''}`}>
                                <div
                                  class="reasoning-header"
                                  onClick={() => !msg.isPartial && toggleReasoning(msg.id)}
                                  style={msg.isPartial ? 'cursor:default' : 'cursor:pointer'}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#a78bfa;flex-shrink:0">
                                    <path d="M12 2a8 8 0 0 0-8 8c0 3 1.7 5.6 4.2 7H15.8A9 9 0 0 0 20 10a8 8 0 0 0-8-8z"/>
                                    <path d="M9 21h6"/><path d="M10 17v4"/><path d="M14 17v4"/>
                                  </svg>
                                  <span class="reasoning-title">
                                    {msg.isPartial ? '思考中…' : `思考过程 (${msg.charCount ?? msg.content.length}字)`}
                                  </span>
                                  <Show when={!msg.isPartial}>
                                    <svg
                                      class="reasoning-chevron"
                                      classList={{ expanded: expandedReasonings().has(msg.id) }}
                                      width="10" height="10" viewBox="0 0 24 24"
                                      fill="none" stroke="currentColor" stroke-width="2.5"
                                    >
                                      <polyline points="6 9 12 15 18 9"/>
                                    </svg>
                                  </Show>
                                </div>
                                <Show when={msg.isPartial || expandedReasonings().has(msg.id)}>
                                  <div class="reasoning-body">
                                    {msg.content}
                                    <Show when={msg.isPartial}><span class="cursor-blink" /></Show>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </Show>
                          <Show when={msg.role === 'system'}>
                            <div class="turn">
                              <div class="turn-system">{msg.content}</div>
                              <Show when={msg.createdAt}>
                                <span class="msg-timestamp">{formatFullTime(msg.createdAt)}</span>
                              </Show>
                            </div>
                          </Show>
                          <Show when={msg.role === 'error'}>
                            <div class="turn">
                              <div class="turn-error">⚠ {msg.content}</div>
                              <Show when={msg.createdAt}>
                                <span class="msg-timestamp">{formatFullTime(msg.createdAt)}</span>
                              </Show>
                            </div>
                          </Show>
                        </>
                      )
                    }}
                  </For>
                  {/* 任务进行中：实时接收计数（直接写 DOM，不走 SolidJS 批更新） */}
                  <Show when={sending()}>
                    <div class="recv-status-bar">
                      <span
                        ref={(el) => {
                          recvDotRef = el
                          if (el && _recvCount > 0) el.classList.add('recv-dot-active')
                        }}
                        class="recv-status-dot"
                      />
                      <span
                        ref={(el) => {
                          recvTextRef = el
                          // 元素创建时立即同步最新状态（避免 Show 渲染滞后）
                          if (el) el.textContent = _recvCount > 0 ? `已接收 ${formatRecv(_recvCount)}` : '等待响应…'
                        }}
                        class="recv-status-text"
                      >等待响应…</span>
                    </div>
                  </Show>
                  <div ref={chatEndRef} />
                </div>

                {/* Git 状态栏 */}
                <GitStatusBar />

                <div
                  ref={composerWrapRef}
                  class="composer-wrap"
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={handleDrop}
                >
                  {/* Token 用量条 */}
                  <TokenUsageBar />

                  {/* 上下文压缩进行中 banner */}
                  <Show when={compactingState()}>
                    <CompactingBanner />
                  </Show>

                  {/* Rate-limit 重试提示（P0-6） */}
                  <RateLimitBanner />

                  {/* Session revert dock（P1-11） */}
                  <Show when={showRevertDock()}>
                    <RevertDock />
                  </Show>

                  {/* Todo 跟踪面板（P0-1） */}
                  <Show when={todos().length > 0}>
                    <TodoDock />
                  </Show>

                  {/* Followup 建议队列（P0-2） */}
                  <Show when={followupSuggestions().length > 0 || followupQueue().length > 0}>
                    <FollowupDock />
                  </Show>

                  {/* Slash / @ 面板通过 fixed 定位渲染（已在 body 级别，无需特殊包装） */}

                  <div class="composer-inner">
                    {/* 图片附件预览 */}
                    <Show when={attachedImages().length > 0}>
                      <div class="image-attachments">
                        <For each={attachedImages()}>
                          {(img) => (
                            <div class="image-attachment-item">
                              <img src={img.dataUrl} class="image-attachment-thumb" alt={img.name} />
                              <button class="image-remove-btn" onClick={() => removeImage(img.id)} title="移除">×</button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <textarea
                      ref={textareaRef}
                      class="composer-textarea"
                      value={input()}
                      onInput={(e) => onInputChange(e.currentTarget.value)}
                      onKeyDown={onKeyDown}
                      onPaste={handlePaste}
                      placeholder={globalMode() === 'code'
                        ? "描述你要完成的编码任务… (⌘↵ 发送, / 命令)"
                        : "提问或描述你的问题… (⌘↵ 发送, / 命令)"}
                      disabled={sending()}
                    />
                    <div class="composer-footer">
                      <div style="display:flex;gap:6px;align-items:center">
                        {/* 模式选择器：仅 Code 模式显示 */}
                        <Show when={globalMode() === 'code'}>
                          <ModeSelector />
                        </Show>
                        {/* 图片上传按钮 */}
                        <label class="attach-image-btn" title="附加图片 (也可直接粘贴)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                          </svg>
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            style="display:none"
                            onChange={(e) => {
                              const files = e.currentTarget.files
                              if (files) for (const f of files) handleImageFile(f)
                              e.currentTarget.value = ""
                            }}
                          />
                        </label>
                        <span class="composer-hint">
                          <Show when={vimEnabled()}>
                            <span class={`vim-mode-indicator vim-mode-${vimMode()}`}>
                              {vimMode() === 'normal' ? '-- NORMAL --' : vimMode() === 'visual' ? '-- VISUAL --' : '-- INSERT --'}
                            </span>
                          </Show>
                          <Show when={sending()}>正在生成回复…</Show>
                        </span>
                      </div>
                      <div style="display:flex;gap:6px;align-items:center">
                        <Show when={sending()}>
                          <button
                            class="btn btn-ghost"
                            onMouseDown={(e) => { e.preventDefault(); void cancel() }}
                          >停止 (Esc)</button>
                        </Show>
                        <button
                          class="btn btn-primary"
                          onMouseDown={(e) => {
                            // preventDefault 阻止 textarea blur（防止中间状态触发重渲染导致 click 丢失）
                            e.preventDefault()
                            if (!sending() && input().trim()) void send()
                          }}
                          disabled={sending() || !input().trim()}
                        >
                          <Show when={!sending()} fallback={
                            <><span class="spinner" style="width:12px;height:12px;border-width:1.5px;border-color:rgba(255,255,255,0.3);border-top-color:#fff" />回复中</>
                          }>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                            </svg>
                            发送
                          </Show>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </Show>

              {/* 集成终端面板：用 CSS display 控制可见性，避免 DOM 卸载导致 xterm canvas 丢失 */}
              <div style={showTerminal() ? '' : 'display:none'}>
                <TerminalPanel />
              </div>
            </main>
            {/* 工作区文件浏览器（右侧） */}
            <Show when={showExplorer()}>
              <WorkspaceExplorerPanel />
            </Show>
            {/* Skills 面板（右侧） */}
            <Show when={showSkillsPanel()}>
              <SkillsPanel />
            </Show>
            {/* 会话上下文面板（右侧，P1-10） */}
            <Show when={showContextPanel()}>
              <ContextPanel />
            </Show>
            {/* 变更记录面板（右侧侧边栏） */}
            <Show when={showFileTree()}>
              <FileTreePanel />
            </Show>
            {/* 文件预览面板（右侧滑入，多标签） */}
            <Show when={previewTabs().length > 0}>
              <FilePreviewPanel />
            </Show>
          </Show>
        </div>
      </Show>

      {/* 键盘快捷键速查面板（⌘/） */}
      <Show when={showKeybindHelp()}>
        <KeybindHelpModal />
      </Show>

      {/* 全局命令面板（⌘P） */}
      <Show when={showCmdPalette()}>
        <CommandPalette />
      </Show>

      {/* 全局 Toast 宿主 */}
      <ToastHost />
    </>
  )
}
