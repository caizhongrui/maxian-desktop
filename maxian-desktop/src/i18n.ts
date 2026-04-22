/**
 * Maxian Desktop — 国际化 (i18n)
 *
 * 使用简单的 t() 函数实现多语言切换。
 * 当前支持: zh-CN（默认）、en
 *
 * 使用：
 *   import { t, setLocale, getLocale } from './i18n'
 *   t('send')           // → "发送" 或 "Send"
 *   t('greeting', '码弦') // → "欢迎使用 码弦" 或 "Welcome to 码弦"
 */

type Locale = 'zh-CN' | 'en'
type TranslationValue = string | ((...args: string[]) => string)

const zhCN: Record<string, TranslationValue> = {
  // ── 通用 ──
  'confirm':              '确认',
  'cancel':               '取消',
  'close':                '关闭',
  'save':                 '保存',
  'delete':               '删除',
  'edit':                 '编辑',
  'add':                  '添加',
  'remove':               '移除',
  'loading':              '加载中…',
  'error':                '错误',
  'success':              '成功',
  'retry':                '重试',
  'yes':                  '是',
  'no':                   '否',

  // ── 登录 ──
  'login.title':          '码弦',
  'login.subtitle':       '智能 AI 编程助手',
  'login.server':         '服务器地址',
  'login.username':       '用户名',
  'login.password':       '密码',
  'login.remember':       '记住登录状态',
  'login.submit':         '登录',
  'login.submitting':     '登录中…',
  'login.footer':         '首次登录？请联系管理员获取账号',

  // ── Chat 界面 ──
  'chat.newSession':      '新建会话 (⌘N)',
  'chat.settings':        '设置',
  'chat.planMode':        '📋 Plan',
  'chat.fileChanges':     '文件变更树',
  'chat.terminal':        '终端 (⌘`)',
  'chat.empty.title':     '开始对话',
  'chat.empty.desc':      '从左侧选择会话，或点击右上角 ✏ 创建新会话',
  'chat.send':            '发送',
  'chat.sending':         '回复中',
  'chat.stop':            '停止 (Esc)',
  'chat.placeholder.code': '描述你要完成的编码任务… (⌘↵ 发送, / 命令)',
  'chat.placeholder.chat': '提问或描述你的问题… (⌘↵ 发送, / 命令)',
  'chat.attach':          '附加图片 (也可直接粘贴)',

  // ── 工具调用 ──
  'tool.approval.title':  '工具调用审批',
  'tool.approval.risk':   '⚠ 此操作可能修改文件或执行系统命令',
  'tool.approval.allow':  '允许',
  'tool.approval.deny':   '拒绝',

  // ── 文件树 ──
  'fileTree.title':       (n: string) => `文件变更 (${n})`,
  'fileTree.empty':       '本次会话暂无文件变更',
  'fileTree.revert':      '撤销此文件的修改',
  'fileTree.open':        '在编辑器中打开',

  // ── 终端 ──
  'terminal.new':         '新建终端',
  'terminal.close':       '关闭终端',
  'terminal.collapse':    '折叠',
  'terminal.expand':      '展开',
  'terminal.label':       (n: string) => `终端 ${n}`,

  // ── Slash 命令 ──
  'slash.clear.label':    '清空会话',
  'slash.clear.desc':     '清空当前对话所有消息',
  'slash.new.label':      '新建会话',
  'slash.new.desc':       '创建一个新的会话',
  'slash.plan.label':     '计划模式',
  'slash.plan.desc':      '切换到只规划不执行的模式',
  'slash.fork.label':     '分叉会话',
  'slash.fork.desc':      '复制当前会话到新分支',
  'slash.terminal.label': '打开终端',
  'slash.terminal.desc':  '打开集成终端 (⌘`)',
  'slash.files.label':    '查看变更',
  'slash.files.desc':     '显示本次会话修改的文件',
  'slash.export.label':   '导出会话',
  'slash.export.desc':    '将对话历史导出为 Markdown',
  'slash.help.label':     '帮助',
  'slash.help.desc':      '显示可用命令列表',

  // ── 设置面板 ──
  'settings.general':     '常规',
  'settings.appearance':  '外观',
  'settings.worktree':    'Git Worktree',
  'settings.mcp':         'MCP Servers',
  'settings.about':       '关于',
  'settings.back':        '返回应用',

  // ── 侧边栏 ──
  'sidebar.addProject':   '添加项目',
  'sidebar.mode.chat':    'Chat 模式 — 对话问答',
  'sidebar.mode.code':    'Code 模式 — 智能编码 Agent',

  // ── 通知 ──
  'notify.taskComplete':  'AI 已完成任务',
  'notify.title':         '码弦 AI',
}

const en: Record<string, TranslationValue> = {
  // ── General ──
  'confirm':              'Confirm',
  'cancel':               'Cancel',
  'close':                'Close',
  'save':                 'Save',
  'delete':               'Delete',
  'edit':                 'Edit',
  'add':                  'Add',
  'remove':               'Remove',
  'loading':              'Loading…',
  'error':                'Error',
  'success':              'Success',
  'retry':                'Retry',
  'yes':                  'Yes',
  'no':                   'No',

  // ── Login ──
  'login.title':          'Maxian',
  'login.subtitle':       'Intelligent AI Coding Assistant',
  'login.server':         'Server URL',
  'login.username':       'Username',
  'login.password':       'Password',
  'login.remember':       'Remember me',
  'login.submit':         'Login',
  'login.submitting':     'Logging in…',
  'login.footer':         'First time? Contact your admin for an account.',

  // ── Chat ──
  'chat.newSession':      'New Session (⌘N)',
  'chat.settings':        'Settings',
  'chat.planMode':        '📋 Plan',
  'chat.fileChanges':     'File Changes',
  'chat.terminal':        'Terminal (⌘`)',
  'chat.empty.title':     'Start a conversation',
  'chat.empty.desc':      'Select a session from the sidebar or click ✏ to create one',
  'chat.send':            'Send',
  'chat.sending':         'Replying',
  'chat.stop':            'Stop (Esc)',
  'chat.placeholder.code': 'Describe the coding task… (⌘↵ send, / commands)',
  'chat.placeholder.chat': 'Ask a question… (⌘↵ send, / commands)',
  'chat.attach':          'Attach image (or paste)',

  // ── Tool approval ──
  'tool.approval.title':  'Tool Call Approval',
  'tool.approval.risk':   '⚠ This action may modify files or run system commands',
  'tool.approval.allow':  'Allow',
  'tool.approval.deny':   'Deny',

  // ── File tree ──
  'fileTree.title':       (n: string) => `File Changes (${n})`,
  'fileTree.empty':       'No file changes in this session',
  'fileTree.revert':      'Revert changes to this file',
  'fileTree.open':        'Open in editor',

  // ── Terminal ──
  'terminal.new':         'New Terminal',
  'terminal.close':       'Close Terminal',
  'terminal.collapse':    'Collapse',
  'terminal.expand':      'Expand',
  'terminal.label':       (n: string) => `Shell ${n}`,

  // ── Slash commands ──
  'slash.clear.label':    'Clear Session',
  'slash.clear.desc':     'Clear all messages in this session',
  'slash.new.label':      'New Session',
  'slash.new.desc':       'Create a new session',
  'slash.plan.label':     'Plan Mode',
  'slash.plan.desc':      'Switch to planning-only mode',
  'slash.fork.label':     'Fork Session',
  'slash.fork.desc':      'Copy this session to a new branch',
  'slash.terminal.label': 'Open Terminal',
  'slash.terminal.desc':  'Open integrated terminal (⌘`)',
  'slash.files.label':    'View Changes',
  'slash.files.desc':     'Show files modified in this session',
  'slash.export.label':   'Export Session',
  'slash.export.desc':    'Export conversation as Markdown',
  'slash.help.label':     'Help',
  'slash.help.desc':      'Show available commands',

  // ── Settings ──
  'settings.general':     'General',
  'settings.appearance':  'Appearance',
  'settings.worktree':    'Git Worktree',
  'settings.mcp':         'MCP Servers',
  'settings.about':       'About',
  'settings.back':        'Back to App',

  // ── Sidebar ──
  'sidebar.addProject':   'Add Project',
  'sidebar.mode.chat':    'Chat mode — Q&A',
  'sidebar.mode.code':    'Code mode — Intelligent Coding Agent',

  // ── Notifications ──
  'notify.taskComplete':  'AI task completed',
  'notify.title':         'Maxian AI',
}

const translations: Record<Locale, Record<string, TranslationValue>> = {
  'zh-CN': zhCN,
  'en': en,
}

const LOCALE_KEY = 'maxian_locale'

/** 检测系统语言，默认 zh-CN */
function detectLocale(): Locale {
  const saved = localStorage.getItem(LOCALE_KEY) as Locale | null
  if (saved && (saved === 'zh-CN' || saved === 'en')) return saved
  const nav = navigator.language || 'zh-CN'
  return nav.startsWith('zh') ? 'zh-CN' : 'en'
}

let currentLocale: Locale = 'zh-CN'

/** 初始化（在应用启动时调用） */
export function initI18n(): void {
  currentLocale = detectLocale()
}

/** 获取当前语言 */
export function getLocale(): Locale {
  return currentLocale
}

/** 切换语言 */
export function setLocale(locale: Locale): void {
  currentLocale = locale
  localStorage.setItem(LOCALE_KEY, locale)
}

/**
 * 翻译函数
 * @param key 翻译键
 * @param args 模板参数（用于函数型翻译值）
 */
export function t(key: string, ...args: string[]): string {
  const dict = translations[currentLocale] ?? zhCN
  const val = dict[key] ?? zhCN[key]
  if (val === undefined) return key
  if (typeof val === 'function') return val(...args)
  return val
}
