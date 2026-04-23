#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Maxian Server — CLI Entry
 *
 *  供 Tauri sidecar 调用的独立可执行入口。
 *  启动参数来自环境变量 / 命令行标志；AI 代理凭据从
 *  ~/Library/Application Support/tianhe-lingyu/config.json 读取（或环境变量覆盖）。
 *
 *  Agent 循环：
 *    用户消息 → AI（携带工具定义） → 收集 tool_use 块 → 执行工具 → 将结果塞回历史
 *    → 再次调用 AI → … → AI 停止调用工具 → 完成
 *
 *  支持工具：read_file / write_to_file / edit / search_files / list_files / execute_command
 *--------------------------------------------------------------------------------------------*/

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { bootstrap } from './bootstrap.js';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
// @lydell/node-pty 仅在集成终端 WebSocket 被使用时才加载。
// ⚠️ 重要：用 Function 构造器和 require 变量隐藏 import 字符串，
// 否则 Bun/esbuild 静态分析器会进入 node-pty 的 dynamic require 导致 --compile 失败。
// 代价：node-pty 不会被打包进单文件二进制，仅在 dev（有 node_modules）或额外随包投递时可用。
// 运行时若找不到则功能性降级：终端 WebSocket 连上即报友好错误，其他功能不受影响。
type PtyModule = typeof import('@lydell/node-pty');
let __ptyModuleCache: PtyModule | null = null;
async function loadPty(): Promise<PtyModule> {
	if (__ptyModuleCache) return __ptyModuleCache;
	// 通过 Function 构造器调用 require，完全绕过 bundler 静态分析
	const dynamicRequire = new Function('mod', 'return require(mod)');
	const pkgName = ['@lydell', 'node-pty'].join('/');   // 拆字符串防止 scanner 识别
	const mod = dynamicRequire(pkgName) as PtyModule;
	__ptyModuleCache = mod;
	return __ptyModuleCache;
}
import { getDb } from './database.js';
import { AiProxyHandler } from '@maxian/core/api/aiproxy';
import {
	readFileTool,
	writeToFileTool,
	searchFilesTool,
	listFilesTool,
	executeCommandTool,
	MemoryFileContextTracker,
} from '@maxian/core/tools';
import {
	executeEdit,
	formatEditResponse,
	executeMultiedit,
	formatMultieditResponse,
	executeTodoWrite,
	formatTodoWriteList,
	htmlToMarkdown,
	validateUrl,
	processResponse,
} from '@maxian/core/tools';
// 新工具（对标 OpenCode）
import {
	Truncate,
	bashTool, formatBashResult, detectDangerousCommand,
	grepTool, formatGrepResult,
	globTool, formatGlobResult,
	lsTool,   formatLsResult,
	applyPatchTool, formatApplyPatchResult,
	formatLspResult,
	formatQuestionResult,
	formatPlanExitResult,
	formatTaskResult,
	ToolRepetitionDetector,
} from '@maxian/core/tools';
import type {
	IBashToolParams, IGrepToolParams, IGlobToolParams, ILsToolParams,
	IApplyPatchParams, ILspToolParams, ILspToolResult, IQuestionToolParams, IPlanExitParams,
	ITaskToolParams, ITaskToolResult,
} from '@maxian/core/tools';
import { LSP } from './lsp/index.js';
import { loadAllPlugins, triggerPluginHook, type PluginToolDef, type LoadedPlugin } from './pluginLoader.js';
import { compactIfNeeded, forceCompact, CONTEXT_WINDOW } from './contextCompaction.js';
import { loadProjectConfig, loadCustomAgents, loadCustomCommands } from './projectConfig.js';
import type { IToolContext } from '@maxian/core/tools';
import type {
	IConfiguration,
	IWorkspace,
	IFileSystem,
	ITerminal,
	IStorage,
	IAuthProvider,
} from '@maxian/core';
import type { IToolExecutor } from '@maxian/core/tools';
import type { MessageParam, ToolDefinition, ContentBlock } from '@maxian/core/api';

// ─── CLI 参数 ─────────────────────────────────────────────────────────────────

interface CliOptions {
	port: number;
	host: string;
	username?: string;
	password?: string;
	cors: boolean;
}

function parseCliArgs(): CliOptions {
	const { values } = parseArgs({
		options: {
			port:     { type: 'string',  short: 'p', default: '4096' },
			host:     { type: 'string',  short: 'h', default: '127.0.0.1' },
			username: { type: 'string',  short: 'u' },
			password: { type: 'string' },
			cors:     { type: 'boolean', default: false },
		},
		strict: false,
	});

	return {
		port:     parseInt((values.port as string) ?? '4096', 10),
		host:     (values.host as string) ?? '127.0.0.1',
		username: (values.username as string) ?? process.env['MAXIAN_SERVER_USERNAME'],
		password: (values.password as string) ?? process.env['MAXIAN_SERVER_PASSWORD'],
		cors:     !!values.cors,
	};
}

// ─── AI 配置 ──────────────────────────────────────────────────────────────────

type AiConfig =
	| { type: 'proxy';    apiUrl: string; username: string; password: string; businessCode?: string; flashBusinessCode?: string }
	| { type: 'anthropic'; apiKey: string; model: string; baseUrl: string };

/** 从环境变量 / IDE 存储读取 AI 配置，依次尝试：Anthropic → 代理 */
function loadAiConfig(): AiConfig | null {
	// 1. Anthropic API Key
	const anthropicKey = process.env['ANTHROPIC_API_KEY'];
	if (anthropicKey) {
		const model   = process.env['ANTHROPIC_MODEL']    || 'claude-sonnet-4-6';
		const baseUrl  = process.env['ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com';
		console.log(`[Maxian CLI] 使用 Anthropic API (${model})`);
		return { type: 'anthropic', apiKey: anthropicKey, model, baseUrl };
	}

	// 2. 环境变量代理
	const apiUrl  = process.env['MAXIAN_AI_API_URL'];
	const aiUser  = process.env['MAXIAN_AI_USERNAME'];
	const aiPass  = process.env['MAXIAN_AI_PASSWORD'];
	if (apiUrl && aiUser && aiPass) {
		return { type: 'proxy', apiUrl, username: btoa(aiUser), password: btoa(aiPass) };
	}

	// 3. 从 IDE 配置文件读取代理凭据
	const configPaths = [
		path.join(os.homedir(), 'Library', 'Application Support', 'tianhe-lingyu', 'config.json'),
		path.join(os.homedir(), '.maxian', 'config.json'),
	];

	for (const cfgPath of configPaths) {
		try {
			const raw  = readFileSync(cfgPath, 'utf8');
			const cfg  = JSON.parse(raw);
			const baseURL:  string = cfg?.serverConfig?.baseURL || cfg?.auth?.baseURL;
			const email:    string = cfg?.auth?.email || cfg?.lastUsername;
			const password: string = cfg?.auth?.password;
			if (baseURL && email && password) {
				// 优先读配置文件中的 businessCode，若无则默认使用 IDE_CHAT_CODE
				const businessCode: string =
					cfg?.serverConfig?.businessCode ||
					cfg?.auth?.businessCode ||
					cfg?.businessCode ||
					'IDE_CHAT_CODE';
				const flashBusinessCode: string | undefined =
					cfg?.serverConfig?.flashBusinessCode ||
					cfg?.auth?.flashBusinessCode ||
					cfg?.flashBusinessCode;
				console.log(`[Maxian CLI] AI 代理配置已从 ${cfgPath} 加载 (businessCode=${businessCode})`);
				return {
					type: 'proxy',
					apiUrl: baseURL,
					username: btoa(email),
					password: btoa(password),
					businessCode,
					flashBusinessCode,
				};
			}
		} catch { /* ignore */ }
	}

	console.warn('[Maxian CLI] 未找到任何 AI 配置，运行 Echo 模式');
	return null;
}

// ─── 工具上下文 ────────────────────────────────────────────────────────────────

/**
 * Node.js 版工具执行上下文，供 Agent 循环使用。
 * 每个 Agent 会话共用一个实例（内存文件追踪）。
 */
class NodeToolContext implements IToolContext {
	readonly workspacePath: string;
	readonly fileContextTracker: MemoryFileContextTracker;
	didEditFile = false;
	readonly sessionId?: string;

	constructor(workspacePath: string, sessionId?: string) {
		this.workspacePath    = workspacePath;
		this.fileContextTracker = new MemoryFileContextTracker();
		this.sessionId        = sessionId;
	}
}

// ─── 工具定义（供 AiProxyHandler 传给大模型） ──────────────────────────────────

const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: 'read_file',
		description: '读取指定文件的内容，支持指定起始/结束行。适合查看代码、配置文件等。',
		parameters: {
			type: 'object',
			properties: {
				path:       { type: 'string', description: '文件路径（相对于工作区或绝对路径）' },
				start_line: { type: 'number', description: '起始行号（可选，从 1 开始）' },
				end_line:   { type: 'number', description: '结束行号（可选）' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write_to_file',
		description: '创建新文件或完全覆盖写入文件内容。适合创建新文件或大幅重写文件。',
		parameters: {
			type: 'object',
			properties: {
				path:    { type: 'string', description: '文件路径（相对或绝对）' },
				content: { type: 'string', description: '文件完整内容' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'edit',
		description: '精确替换文件中的指定文本片段。适合小范围修改，比 write_to_file 更安全。修改前无需先 read_file，工具会自动读取。',
		parameters: {
			type: 'object',
			properties: {
				path:        { type: 'string',  description: '文件路径' },
				old_string:  { type: 'string',  description: '要查找并替换的原始文本（包含足够上下文以唯一定位）' },
				new_string:  { type: 'string',  description: '替换后的新文本' },
				replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
			},
			required: ['path', 'new_string'],
		},
	},
	{
		name: 'search_files',
		description: '在目录中用正则表达式搜索文件内容，返回匹配行及上下文。',
		parameters: {
			type: 'object',
			properties: {
				path:         { type: 'string', description: '搜索目录（相对或绝对）' },
				regex:        { type: 'string', description: '正则表达式' },
				file_pattern: { type: 'string', description: '文件名过滤模式，如 *.ts' },
			},
			required: ['path', 'regex'],
		},
	},
	{
		name: 'list_files',
		description: '列出目录中的文件和子目录，支持递归。',
		parameters: {
			type: 'object',
			properties: {
				path:      { type: 'string',  description: '目录路径（相对或绝对）' },
				recursive: { type: 'boolean', description: '是否递归列出子目录，默认 false' },
			},
			required: ['path'],
		},
	},
	{
		name: 'execute_command',
		description: '在工作区目录中执行 shell 命令（如 npm install、git status、tsc 等）。',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的命令' },
				cwd:     { type: 'string', description: '自定义工作目录（可选，默认为工作区根目录）' },
			},
			required: ['command'],
		},
	},
	{
		name: 'multiedit',
		description: '在单个文件中执行多处编辑操作（原子性：全部成功或全部不执行）。适合同时修改同一文件的多个位置。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件路径' },
				edits: {
					type: 'array',
					description: '编辑操作列表（按顺序执行，每个基于前一个结果）',
					items: {
						type: 'object',
						properties: {
							oldString:  { type: 'string',  description: '要替换的原始文本（精确匹配）' },
							newString:  { type: 'string',  description: '替换后的新文本' },
							replaceAll: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
						},
						required: ['oldString', 'newString'],
					},
				},
			},
			required: ['path', 'edits'],
		},
	},
	{
		name: 'todo_write',
		description: '创建或更新当前任务的 TODO 列表。多步任务开始前必须先规划。每次调用全量替换当前 TODO 列表。',
		parameters: {
			type: 'object',
			properties: {
				todos: {
					type: 'array',
					description: 'TODO 项目列表（全量替换）',
					items: {
						type: 'object',
						properties: {
							id:         { type: 'string', description: '唯一标识符（如 "1", "task-1"）' },
							content:    { type: 'string', description: '任务内容（祈使句形式，如 "修改登录样式"）' },
							status:     { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态' },
							activeForm: { type: 'string', description: '进行时形式（如 "正在修改登录样式"）' },
						},
						required: ['id', 'content', 'status', 'activeForm'],
					},
				},
			},
			required: ['todos'],
		},
	},
	{
		name: 'web_fetch',
		description: '获取网页内容并转换为 Markdown 格式。适合查看在线文档、API 参考、技术文章。',
		parameters: {
			type: 'object',
			properties: {
				url:    { type: 'string', description: '要获取的 URL（必须是 http 或 https）' },
				prompt: { type: 'string', description: '提取内容的提示词（可选，指示关注哪些内容）' },
			},
			required: ['url'],
		},
	},
	{
		name: 'load_skill',
		description: '从工作区 .maxian/skills/ 或 .claude/skills/ 目录加载专业领域技能文档。用于获取特定技术领域的专业指导。',
		parameters: {
			type: 'object',
			properties: {
				skill_name: { type: 'string', description: '技能名称（文件名，不含 .md 扩展名）或 list 列出所有技能' },
			},
			required: ['skill_name'],
		},
	},
	// ── 新增工具（对标 OpenCode） ────────────────────────────────────────
	{
		name: 'bash',
		description: '在 shell 中执行命令（比 execute_command 更强：支持超时、后台执行、危险命令检测）。输出过大会自动截断写盘。',
		parameters: {
			type: 'object',
			properties: {
				command:     { type: 'string', description: '要执行的 shell 命令' },
				timeout:     { type: 'number', description: '超时毫秒数（默认 120000，最大 600000）' },
				cwd:         { type: 'string', description: '工作目录（相对或绝对，默认工作区根）' },
				background:  { type: 'boolean', description: '后台执行不等完成，返回 PID' },
				description: { type: 'string', description: '简短描述，用于审批对话框' },
			},
			required: ['command'],
		},
	},
	{
		name: 'grep',
		description: '用 ripgrep 进行正则跨文件搜索，比 search_files 更快更强，支持 glob / 文件类型过滤、上下文行、大小写不敏感。',
		parameters: {
			type: 'object',
			properties: {
				pattern:    { type: 'string', description: '正则表达式（必填）' },
				path:       { type: 'string', description: '搜索起始目录' },
				include:    { type: 'string', description: 'glob 过滤，如 "*.ts" 或 "src/**/*.tsx"' },
				type:       { type: 'string', description: '文件类型，如 "js" "py" "rust"' },
				ignoreCase: { type: 'boolean', description: '大小写不敏感' },
				context:    { type: 'number', description: '上下文行数' },
				limit:      { type: 'number', description: '最多返回行数（默认 500）' },
				outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '输出模式' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'glob',
		description: '按 glob 模式匹配文件，结果按 mtime 降序（最近修改优先）。',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"' },
				path:    { type: 'string', description: '起始目录' },
				limit:   { type: 'number', description: '最多返回数（默认 200）' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'ls',
		description: '列出目录内容（含文件类型/大小/修改时间），可递归。',
		parameters: {
			type: 'object',
			properties: {
				path:       { type: 'string', description: '目标目录（默认 "."）' },
				showHidden: { type: 'boolean', description: '显示 . 开头的隐藏文件' },
				recursive:  { type: 'boolean', description: '递归列出（最多 5 层）' },
			},
		},
	},
	{
		name: 'apply_patch',
		description: '应用 unified diff 补丁。支持多文件、新建、删除。任一 hunk 失败整体回滚。比 multiedit 更适合跨文件协调修改。',
		parameters: {
			type: 'object',
			properties: {
				patch: { type: 'string', description: '标准 unified diff 文本（--- / +++ / @@ 头部）' },
			},
			required: ['patch'],
		},
	},
	{
		name: 'lsp',
		description: 'Language Server Protocol 操作：查询类（跳转定义/引用/悬停/符号/诊断）+ 编辑类（rename 重命名、codeAction 代码操作、formatDocument 格式化、organizeImports 整理 import）。需本地已装语言服务器。',
		parameters: {
			type: 'object',
			properties: {
				operation: {
					type: 'string',
					enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'diagnostics', 'rename', 'codeAction', 'formatDocument', 'organizeImports'],
					description: 'LSP 操作类型',
				},
				filePath:  { type: 'string', description: '文件路径（除 workspaceSymbol 外必需）' },
				line:      { type: 'number', description: '行号（1-based，编辑器显示值）' },
				character: { type: 'number', description: '列号（1-based）' },
				query:     { type: 'string', description: 'workspaceSymbol 查询字符串' },
				newName:   { type: 'string', description: 'rename 新名字（仅 operation=rename 时需要）' },
				codeActionKind: { type: 'string', description: 'codeAction 类型：quickfix / refactor / source（可选）' },
			},
			required: ['operation'],
		},
	},
	{
		name: 'question',
		description: '当你无法根据上下文自行决定时向用户提问。**只在信息缺失无法继续**时使用；能自行推断的不要问。',
		parameters: {
			type: 'object',
			properties: {
				question: { type: 'string', description: '问题内容' },
				options:  { type: 'array', items: { type: 'string' }, description: '可选：预设选项（用户可一键选择）' },
				multi:    { type: 'boolean', description: '是否多选' },
			},
			required: ['question'],
		},
	},
	{
		name: 'plan_exit',
		description: '仅 Plan 模式可用：规划完毕后请求用户同意切换到 Build（Code）模式开始实际执行。在规划完整输出后调用一次即可。',
		parameters: {
			type: 'object',
			properties: {
				summary: { type: 'string', description: '计划摘要（用于给用户确认）' },
				steps:   { type: 'string', description: '详细步骤 Markdown（可选）' },
			},
			required: ['summary'],
		},
	},
	{
		name: 'task',
		description: '派发一个独立上下文的子 Agent 完成特定子任务。subagent_type: explore=只读搜索阅读、build=完整权限独立执行、review=代码审查。用于大量探索不污染主会话上下文。',
		parameters: {
			type: 'object',
			properties: {
				prompt:        { type: 'string', description: '给子 Agent 的任务描述' },
				subagent_type: { type: 'string', enum: ['explore', 'build', 'review'], description: '子 Agent 类型' },
				description:   { type: 'string', description: '简短标签（给用户展示）' },
			},
			required: ['prompt', 'subagent_type'],
		},
	},
];

// ─── 文件快照辅助 ──────────────────────────────────────────────────────────────

/**
 * 在写入/编辑文件前，将当前内容保存到 file_snapshots 表。
 * 如果文件不存在则不保存（新建文件无需快照）。
 */
function saveFileSnapshot(sessionId: string, absolutePath: string): void {
	try {
		if (!fs.existsSync(absolutePath)) return;
		const content = fs.readFileSync(absolutePath, 'utf8');
		const db = getDb();
		db.prepare(
			'INSERT INTO file_snapshots (session_id, path, content, created_at) VALUES (?, ?, ?, ?)'
		).run(sessionId, absolutePath, content, Date.now());
	} catch (e) {
		console.warn('[Snapshot] 保存快照失败:', (e as Error).message);
	}
}

// ─── 工具执行器 ────────────────────────────────────────────────────────────────

/**
 * 执行单个工具调用，返回结果字符串。
 * edit 工具会先读取文件内容，再计算替换结果并写回。
 *
 * emitEvent: 可选的 SSE 事件发射函数，用于发送 file_changed 等事件
 */
async function executeToolCall(
	ctx: NodeToolContext,
	name: string,
	params: Record<string, unknown>,
	emitEvent?: (event: Record<string, unknown>) => Promise<void>,
	toolUseId?: string,
): Promise<string> {
	// 把 toolUseId 透传给需要的 case（例如 bash 的流式输出）
	if (toolUseId) (params as any).__toolUseId = toolUseId;
	try {
		let result: unknown;
		switch (name) {
			case 'read_file': {
				result = await readFileTool(ctx, params);
				break;
			}
			case 'write_to_file': {
				// 快照：写前保存原始内容
				const wFilePath = params.path as string;
				const wAbsPath = path.isAbsolute(wFilePath)
					? wFilePath
					: path.resolve(ctx.workspacePath, wFilePath);
				const wIsNew = !fs.existsSync(wAbsPath);

				// FileTime.assert：覆盖已存在的文件前，验证 AI 读过且未被外部改过
				if (ctx.sessionId && !wIsNew) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						FileTime.assert(ctx.sessionId, wAbsPath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, wAbsPath);
				result = await writeToFileTool(ctx, params);
				ctx.didEditFile = true;
				// 通知前端文件变更
				if (emitEvent) {
					await emitEvent({
						type: 'file_changed',
						sessionId: ctx.sessionId,
						path: wAbsPath,
						action: wIsNew ? 'created' : 'modified',
					});
				}
				break;
			}
			case 'edit': {
				const filePath = params.path as string;
				const absolutePath = path.isAbsolute(filePath)
					? filePath
					: path.resolve(ctx.workspacePath, filePath);

				// FileTime.assert：修改已存在的文件前，验证 AI 读过且文件未被外部改过
				//（新建文件场景 content === null，跳过检查）
				let content: string | null = null;
				try { content = fs.readFileSync(absolutePath, 'utf8'); } catch { /* 文件不存在 */ }

				if (ctx.sessionId && content !== null) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						FileTime.assert(ctx.sessionId, absolutePath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				// 【行尾符保留】检测原文件用 \r\n 还是 \n，写回时保持一致
				const hadCRLF = content !== null && /\r\n/.test(content);

				if (ctx.sessionId && content !== null) saveFileSnapshot(ctx.sessionId, absolutePath);
				const isNewFile = content === null;

				const editResult = executeEdit(content, params as unknown as Parameters<typeof executeEdit>[1]);
				if (editResult.success && editResult.newContent !== undefined) {
					let finalContent = editResult.newContent;
					// 如果原文件用 CRLF，且新内容是 LF，转回 CRLF
					if (hadCRLF && !/\r\n/.test(finalContent)) {
						finalContent = finalContent.replace(/\r?\n/g, '\r\n');
					}
					fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
					fs.writeFileSync(absolutePath, finalContent, 'utf8');
					ctx.didEditFile = true;
					ctx.fileContextTracker.trackFileWrite(absolutePath);
					// FileTime：写入后刷新基线，避免后续连续 edit 误判"外部修改"
					if (ctx.sessionId) {
						try {
							const { FileTime } = await import('@maxian/core/file/FileTime');
							FileTime.read(ctx.sessionId, absolutePath);
						} catch { /* ignore */ }
					}
					if (emitEvent) {
						await emitEvent({
							type: 'file_changed',
							sessionId: ctx.sessionId,
							path: absolutePath,
							action: isNewFile ? 'created' : 'modified',
						});
					}
				}
				let resp = formatEditResponse(editResult, params.new_string as string);

				// 【编辑后 diagnostic 摘要】如果 LSP 可用，跑一次诊断，取前 20 条 error/warning
				if (editResult.success) {
					try {
						const diags = await LSP.diagnostics(absolutePath, ctx.workspacePath);
						if (diags && diags.length > 0) {
							const filtered = diags
								.filter((d: any) => (d.severity ?? 1) <= 2)   // 1=Error, 2=Warning
								.slice(0, 20);
							if (filtered.length > 0) {
								const lines = filtered.map((d: any) => {
									const sev = d.severity === 1 ? '❌ Error' : '⚠️ Warning';
									const line = (d.range?.start?.line ?? 0) + 1;
									const col  = (d.range?.start?.character ?? 0) + 1;
									return `  ${sev} [${line}:${col}] ${d.message}`;
								}).join('\n');
								resp += `\n\n📋 LSP 诊断（前 ${filtered.length} 条 error/warning）：\n${lines}`;
							} else {
								resp += `\n\n✓ LSP 诊断：无 error/warning`;
							}
						}
					} catch { /* LSP 不可用则忽略 */ }
				}

				return resp;
			}
			case 'multiedit': {
				const mFilePath = params.path as string;
				const mAbsPath = path.isAbsolute(mFilePath)
					? mFilePath
					: path.resolve(ctx.workspacePath, mFilePath);

				let mContent: string | null = null;
				try { mContent = fs.readFileSync(mAbsPath, 'utf8'); } catch { /* 文件不存在 */ }

				if (mContent === null) {
					return `Error: 文件不存在: ${mFilePath}`;
				}

				// FileTime.assert：验证 AI 读过且文件未被外部改过
				if (ctx.sessionId) {
					try {
						const { FileTime } = await import('@maxian/core/file/FileTime');
						FileTime.assert(ctx.sessionId, mAbsPath);
					} catch (e) {
						return `Error: ${(e as Error).message}`;
					}
				}

				// 快照
				if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, mAbsPath);

				const edits = params.edits as Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
				const multieditResult = executeMultiedit(mContent, edits);
				if (multieditResult.success && multieditResult.finalContent !== undefined) {
					fs.writeFileSync(mAbsPath, multieditResult.finalContent, 'utf8');
					ctx.didEditFile = true;
					ctx.fileContextTracker.trackFileWrite(mAbsPath);
					if (ctx.sessionId) {
						try {
							const { FileTime } = await import('@maxian/core/file/FileTime');
							FileTime.read(ctx.sessionId, mAbsPath);
						} catch { /* ignore */ }
					}
					if (emitEvent) {
						await emitEvent({
							type: 'file_changed',
							sessionId: ctx.sessionId,
							path: mAbsPath,
							action: 'modified',
						});
					}
				}
				const multieditResponse = formatMultieditResponse(multieditResult, mFilePath);
				return typeof multieditResponse === 'string' ? multieditResponse : JSON.stringify(multieditResponse);
			}
			case 'todo_write': {
				const sessionId = ctx.sessionId ?? 'global';
				const todoResult = executeTodoWrite(sessionId, params.todos);
				if (todoResult.success) {
					// 推送 todos 列表更新事件到前端（用于 Todo 跟踪面板）
					if (emitEvent && ctx.sessionId) {
						await emitEvent({
							type: 'todos_updated',
							sessionId: ctx.sessionId,
							todos: todoResult.todos,
						});
					}
					return formatTodoWriteList(todoResult.todos);
				}
				return `Error: ${todoResult.message}`;
			}
			case 'web_fetch': {
				const fetchUrl = params.url as string;
				const validation = validateUrl(fetchUrl);
				if (!validation.valid) {
					return `Error: ${validation.error}`;
				}
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 30000);
					const res = await fetch(fetchUrl, {
						signal: controller.signal,
						headers: {
							'User-Agent': 'Mozilla/5.0 (compatible; MaxianIDE/1.0)',
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						},
						redirect: 'follow',
					});
					clearTimeout(timeout);
					const contentType = res.headers.get('content-type') ?? '';
					const text = await res.text();
					const fetchResult = processResponse(fetchUrl, text, contentType, {
						url: fetchUrl,
						prompt: params.prompt as string | undefined,
					});
					if (fetchResult.success && fetchResult.content) {
						const title = fetchResult.metadata?.title ? `# ${fetchResult.metadata.title}\n\n` : '';
						return `${title}${fetchResult.content}`;
					}
					return `Error: ${fetchResult.error ?? '获取失败'}`;
				} catch (e) {
					return `Error: web_fetch 失败: ${(e as Error).message}`;
				}
			}
			case 'search_files': {
				result = await searchFilesTool(ctx, params);
				break;
			}
			case 'list_files': {
				result = await listFilesTool(ctx, params);
				break;
			}
			case 'execute_command': {
				// 流式输出：把 stdout/stderr 的每块实时推送给前端
				const toolUseIdEx = (params as any).__toolUseId as string | undefined;
				const sinkEx = (toolUseIdEx && emitEvent)
					? async (chunk: string, kind: 'stdout' | 'stderr') => {
						try {
							await emitEvent({
								type:      'tool_output_chunk',
								sessionId: ctx.sessionId,
								toolUseId: toolUseIdEx,
								toolName:  'execute_command',
								kind,
								chunk,
							});
						} catch { /* ignore */ }
					}
					: undefined;
				// 开始横幅
				if (toolUseIdEx && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId: toolUseIdEx,
							toolName:  'execute_command',
							kind:      'stdout',
							chunk:     `$ ${(params as any).command}\n`,
						});
					} catch { /* ignore */ }
				}
				result = await executeCommandTool(ctx, params, sinkEx);
				// 结束横幅
				if (toolUseIdEx && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId: toolUseIdEx,
							toolName:  'execute_command',
							kind:      'stdout',
							chunk:     `\n[命令结束]\n`,
							final:     true,
						});
					} catch { /* ignore */ }
				}
				break;
			}
		case 'load_skill': {
				const skillName = params.skill_name as string;
				const skillDirs = [
					path.join(ctx.workspacePath, '.maxian', 'skills'),
					path.join(ctx.workspacePath, '.claude', 'skills'),
					path.join(os.homedir(), '.maxian', 'skills'),
					path.join(os.homedir(), '.claude', 'skills'),
				];

				// 扫描：同时支持目录型 <name>/SKILL.md 和平铺 <name>.md
				const scanSkills = (dir: string): Array<{ name: string; abs: string }> => {
					const out: Array<{ name: string; abs: string }> = [];
					if (!fs.existsSync(dir)) return out;
					let entries: string[];
					try { entries = fs.readdirSync(dir); } catch { return out; }
					for (const entry of entries) {
						const absEntry = path.join(dir, entry);
						let stat: fs.Stats;
						try { stat = fs.statSync(absEntry); } catch { continue; }
						if (stat.isFile() && entry.endsWith('.md')) {
							out.push({ name: entry.slice(0, -3), abs: absEntry });
						} else if (stat.isDirectory()) {
							for (const c of ['SKILL.md', 'skill.md', 'README.md']) {
								const abs = path.join(absEntry, c);
								if (fs.existsSync(abs)) { out.push({ name: entry, abs }); break; }
							}
						}
					}
					return out;
				};

				if (skillName === 'list') {
					const skillList: string[] = [];
					const seenNames = new Set<string>();
					for (const dir of skillDirs) {
						for (const { name, abs } of scanSkills(dir)) {
							if (seenNames.has(name)) continue;
							seenNames.add(name);
							skillList.push(`${name} (${abs})`);
						}
					}
					return skillList.length > 0
						? `可用技能列表：\n${skillList.map(s => `- ${s}`).join('\n')}`
						: '没有找到任何技能。请在 .maxian/skills/、.claude/skills/ 或 ~/.claude/skills/ 创建（目录型 <name>/SKILL.md 或平铺 <name>.md）。';
				}
				for (const dir of skillDirs) {
					for (const { name, abs } of scanSkills(dir)) {
						if (name === skillName) {
							const content = fs.readFileSync(abs, 'utf8');
							return `## 技能: ${skillName}\n\n来源: ${abs}\n\n${content}`;
						}
					}
				}
				return `Error: 技能 "${skillName}" 未找到。使用 skill_name: "list" 查看所有可用技能。`;
			}
			// ── 新增工具 dispatch（对标 OpenCode） ─────────────────────────
			case 'bash': {
				const bp = params as unknown as IBashToolParams;
				const danger = detectDangerousCommand(bp.command);
				if (danger) {
					return `Error: 拒绝执行危险命令（${danger}）。请调整为更安全的命令。`;
				}
				// 流式输出：每当 stdout/stderr 有新数据，通过 SSE 推给前端实时显示
				const toolUseId = (params as any).__toolUseId as string | undefined;
				const sink = (toolUseId && emitEvent)
					? async (chunk: string, kind: 'stdout' | 'stderr') => {
						try {
							await emitEvent({
								type:      'tool_output_chunk',
								sessionId: ctx.sessionId,
								toolUseId,
								toolName:  'bash',
								kind,
								chunk,
							});
						} catch { /* ignore */ }
					}
					: undefined;
				// 开始横幅
				if (toolUseId && emitEvent) {
					try {
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId,
							toolName:  'bash',
							kind:      'stdout',
							chunk:     `$ ${bp.command}\n`,
						});
					} catch { /* ignore */ }
				}
				const r = await bashTool(ctx, bp, sink);
				// 结束横幅
				if (toolUseId && emitEvent) {
					try {
						const tail = r.timedOut ? `\n[超时被杀]\n` : `\n[exit=${r.exitCode}]\n`;
						await emitEvent({
							type:      'tool_output_chunk',
							sessionId: ctx.sessionId,
							toolUseId,
							toolName:  'bash',
							kind:      'stdout',
							chunk:     tail,
							final:     true,
						});
					} catch { /* ignore */ }
				}
				const text = formatBashResult(r, bp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'grep': {
				const gp = params as unknown as IGrepToolParams;
				const r = await grepTool(ctx, gp);
				const text = formatGrepResult(r, gp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'glob': {
				const gp = params as unknown as IGlobToolParams;
				const r = await globTool(ctx, gp);
				const text = formatGlobResult(r, gp);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'ls': {
				const lp = params as unknown as ILsToolParams;
				const r = await lsTool(ctx, lp);
				const text = formatLsResult(r);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'apply_patch': {
				const ap = params as unknown as IApplyPatchParams;
				// 为即将被修改的文件保存快照
				if (ctx.sessionId && ap.patch) {
					const fileMatches = ap.patch.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\s+.*)?$/gm);
					if (fileMatches) {
						const files = new Set<string>();
						for (const m of fileMatches) {
							const match = m.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\s+.*)?$/);
							if (match && match[1] !== '/dev/null') files.add(match[1]);
						}
						for (const f of files) {
							const abs = path.isAbsolute(f) ? f : path.resolve(ctx.workspacePath, f);
							saveFileSnapshot(ctx.sessionId, abs);
						}
					}
				}
				const r = await applyPatchTool(ctx, ap);
				// 通知前端文件变更
				if (emitEvent && r.success) {
					for (const p of r.filesCreated) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'created' });
					for (const p of r.filesChanged) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'modified' });
					for (const p of r.filesDeleted) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: p, action: 'deleted' });
				}
				return formatApplyPatchResult(r);
			}
			case 'lsp': {
				const lp = params as unknown as ILspToolParams;
				const op = lp.operation;
				const filePath = lp.filePath
					? (path.isAbsolute(lp.filePath) ? lp.filePath : path.resolve(ctx.workspacePath, lp.filePath))
					: '';
				let title: string = op;
				let output = '';
				let metadata: any = null;
				try {
					switch (op) {
						case 'goToDefinition': {
							if (!filePath || !lp.line || !lp.character) return `Error: goToDefinition 需要 filePath/line/character`;
							const r = await LSP.definition({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `goToDefinition ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到定义' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'findReferences': {
							if (!filePath || !lp.line || !lp.character) return `Error: findReferences 需要 filePath/line/character`;
							const r = await LSP.references({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `findReferences ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到引用' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'hover': {
							if (!filePath || !lp.line || !lp.character) return `Error: hover 需要 filePath/line/character`;
							const r = await LSP.hover({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `hover ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r ? JSON.stringify(r, null, 2) : '无悬停信息';
							metadata = r;
							break;
						}
						case 'documentSymbol': {
							if (!filePath) return `Error: documentSymbol 需要 filePath`;
							const r = await LSP.documentSymbol(filePath, ctx.workspacePath);
							title = `documentSymbol ${lp.filePath}`;
							output = r.length === 0 ? '文件无符号' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'workspaceSymbol': {
							const anyFile = filePath || ctx.workspacePath;
							const r = await LSP.workspaceSymbol(lp.query ?? '', anyFile, ctx.workspacePath);
							title = `workspaceSymbol "${lp.query ?? ''}"`;
							output = r.length === 0 ? '无匹配符号' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'goToImplementation': {
							if (!filePath || !lp.line || !lp.character) return `Error: goToImplementation 需要 filePath/line/character`;
							const r = await LSP.implementation({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `goToImplementation ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '没有找到实现' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'prepareCallHierarchy': {
							if (!filePath || !lp.line || !lp.character) return `Error: prepareCallHierarchy 需要 filePath/line/character`;
							const r = await LSP.prepareCallHierarchy({ file: filePath, line: lp.line, character: lp.character }, ctx.workspacePath);
							title = `prepareCallHierarchy ${lp.filePath}:${lp.line}:${lp.character}`;
							output = r.length === 0 ? '无 call hierarchy' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'diagnostics': {
							if (!filePath) return `Error: diagnostics 需要 filePath`;
							const r = await LSP.diagnostics(filePath, ctx.workspacePath);
							title = `diagnostics ${lp.filePath}`;
							output = r.length === 0 ? '无诊断' : JSON.stringify(r, null, 2);
							metadata = r;
							break;
						}
						case 'incomingCalls':
						case 'outgoingCalls':
							return `Error: ${op} 需要先通过 prepareCallHierarchy 获取 CallHierarchyItem 再在客户端侧调用（当前 agent 工具未实现持久化）`;

						case 'rename': {
							if (!filePath || !lp.line || !lp.character || !lp.newName) return `Error: rename 需要 filePath/line/character/newName`;
							// 保存所有可能受影响的文件快照（仅针对当前文件；跨文件 rename 暂不预快照）
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const edit = await LSP.rename({ file: filePath, line: lp.line, character: lp.character }, lp.newName, ctx.workspacePath);
							if (!edit) return `Error: 无法重命名（可能不是有效符号位置）`;
							const changed = await LSP.applyWorkspaceEdit(edit);
							title = `rename "${lp.newName}"`;
							output = `✓ 已重命名。修改了 ${changed.length} 个文件：\n${changed.map(f => `- ${f}`).join('\n')}`;
							metadata = { changed };
							// 通知前端
							if (emitEvent) {
								for (const f of changed) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: f, action: 'modified' });
							}
							ctx.didEditFile = changed.length > 0;
							break;
						}
						case 'codeAction': {
							if (!filePath || !lp.line || !lp.character) return `Error: codeAction 需要 filePath/line/character`;
							const actions = await LSP.codeAction({ file: filePath, line: lp.line, character: lp.character }, lp.codeActionKind, ctx.workspacePath);
							title = `codeAction ${lp.codeActionKind ?? 'any'} ${lp.filePath}:${lp.line}:${lp.character}`;
							output = actions.length === 0
								? '无可用代码操作'
								: '可用操作：\n' + actions.map((a, i) => `  ${i + 1}. ${a.title}${a.kind ? ` [${a.kind}]` : ''}`).join('\n')
									+ '\n\n⚠️ 代码操作仅列出可用项，未自动应用。若需应用，请根据 title 用 edit/apply_patch 手动实现。';
							metadata = actions;
							break;
						}
						case 'formatDocument': {
							if (!filePath) return `Error: formatDocument 需要 filePath`;
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const edits = await LSP.formatDocument(filePath, ctx.workspacePath);
							if (edits.length === 0) {
								title = `formatDocument ${lp.filePath}`;
								output = '无格式化变更（文件已符合规则）';
								metadata = [];
							} else {
								await LSP.applyTextEdits(filePath, edits);
								title = `formatDocument ${lp.filePath}`;
								output = `✓ 已格式化。应用 ${edits.length} 处变更。`;
								metadata = { edits: edits.length };
								if (emitEvent) await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: filePath, action: 'modified' });
								ctx.didEditFile = true;
							}
							break;
						}
						case 'organizeImports': {
							if (!filePath) return `Error: organizeImports 需要 filePath`;
							if (ctx.sessionId) saveFileSnapshot(ctx.sessionId, filePath);
							const actions = await LSP.organizeImports(filePath, ctx.workspacePath);
							let appliedCount = 0;
							for (const a of actions) {
								if (a?.edit) {
									const chg = await LSP.applyWorkspaceEdit(a.edit);
									appliedCount += chg.length;
								}
							}
							title = `organizeImports ${lp.filePath}`;
							output = appliedCount > 0 ? `✓ 已整理 import（修改 ${appliedCount} 文件）` : '无 import 需要整理';
							metadata = { applied: appliedCount };
							if (appliedCount > 0 && emitEvent) {
								await emitEvent({ type: 'file_changed', sessionId: ctx.sessionId, path: filePath, action: 'modified' });
								ctx.didEditFile = true;
							}
							break;
						}

						default:
							return `Error: 未知 LSP 操作 "${op}"`;
					}
				} catch (e) {
					return `LSP 调用失败: ${(e as Error).message}`;
				}
				const result: ILspToolResult = { operation: op, title, output, metadata };
				const text = formatLspResult(result);
				const truncated = Truncate.output(text, {}, true);
				return truncated.content;
			}
			case 'question': {
				const qp = params as unknown as IQuestionToolParams;
				if (emitEvent && ctx.sessionId) {
					await emitEvent({
						type:      'question_request',
						sessionId: ctx.sessionId,
						question:  qp.question,
						options:   qp.options ?? [],
						multi:     qp.multi ?? false,
					});
				}
				const waitFn = (globalThis as any).__maxianWaitForQuestion as (sid: string, timeout: number) => Promise<any>;
				if (!waitFn || !ctx.sessionId) return '[question 工具需要会话 ID，当前会话无效]';
				try {
					const answer = await waitFn(ctx.sessionId, 600000);
					return formatQuestionResult({
						answer:    answer.answer ?? '',
						selected:  answer.selected,
						cancelled: answer.cancelled,
					});
				} catch {
					return `[用户未在 10 分钟内回答问题，请根据已有上下文继续]`;
				}
			}
			case 'plan_exit': {
				const pp = params as unknown as IPlanExitParams;
				if (emitEvent && ctx.sessionId) {
					await emitEvent({
						type:      'plan_exit_request',
						sessionId: ctx.sessionId,
						summary:   pp.summary,
						steps:     pp.steps ?? '',
					});
				}
				const waitFn = (globalThis as any).__maxianWaitForPlanExit as (sid: string, timeout: number) => Promise<any>;
				if (!waitFn || !ctx.sessionId) return '[plan_exit 工具需要会话 ID]';
				try {
					const r = await waitFn(ctx.sessionId, 600000);
					return formatPlanExitResult(r);
				} catch {
					return `[用户未在 10 分钟内响应，默认保持 Plan 模式]`;
				}
			}
			case 'task': {
				const tp = params as unknown as ITaskToolParams;
				// 调用主 agent loop 的子任务派发（在 cli.ts 初始化时注入）
				if (!(globalThis as any).__maxianSpawnSubAgent) {
					return `Error: 子 Agent 派发未初始化`;
				}
				try {
					const r: ITaskToolResult = await (globalThis as any).__maxianSpawnSubAgent({
						parentSessionId: ctx.sessionId,
						workspacePath:   ctx.workspacePath,
						prompt:          tp.prompt,
						subagentType:    tp.subagent_type,
						description:     tp.description,
					});
					const text = formatTaskResult(r, tp);
					const truncated = Truncate.output(text, {}, false);  // task 内部已经是聚合的文本
					return truncated.content;
				} catch (e) {
					return formatTaskResult({ output: '', success: false, error: (e as Error).message }, tp);
				}
			}
			default: {
				// 尝试插件工具
				const pluginMap: Map<string, PluginToolDef> | undefined = (globalThis as any).__maxianPluginTools;
				const plugin = pluginMap?.get(name);
				if (plugin) {
					try {
						const res = await plugin.execute(params, ctx);
						const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
						return Truncate.output(text, {}, true).content;
					} catch (e) {
						return `Error executing plugin tool ${name}: ${(e as Error).message}`;
					}
				}
				return `Error: Unknown tool "${name}"`;
			}
		}
		return typeof result === 'string' ? result : JSON.stringify(result);
	} catch (e) {
		return `Error executing ${name}: ${(e as Error).message}`;
	}
}

// ─── 平台实现 ──────────────────────────────────────────────────────────────────

function createDefaultPlatform() {
	const config: IConfiguration = {
		getValue<T>(key: string, defaultValue?: T): T | undefined {
			const env = process.env['MAXIAN_' + key.toUpperCase().replace(/\./g, '_')];
			if (env !== undefined) {
				try { return JSON.parse(env) as T; } catch { return env as unknown as T; }
			}
			return defaultValue as T | undefined;
		},
		async updateValue(_key: string, _value: unknown) {},
	};

	const cwd = process.cwd();
	const workspace: IWorkspace = {
		getRootPath:    () => cwd,
		getRootPaths:   () => [cwd],
		isInWorkspace:  (p: string) => p.startsWith(cwd),
		toRelativePath: (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p),
		getName:        () => cwd.split('/').pop() || 'workspace',
	};

	const toolExecutor: IToolExecutor = {
		executeTool:      async () => 'Tool execution is handled by the Agent loop in cli.ts',
		isToolAvailable:  () => true,
		getAvailableTools: () => AGENT_TOOL_DEFINITIONS.map(t => t.name as any),
	};

	return {
		config,
		workspace,
		fs:      {} as IFileSystem,
		terminal: {} as ITerminal,
		storage:  {} as IStorage,
		auth:     {} as IAuthProvider,
		toolExecutor,
	};
}

// ─── 主函数 ────────────────────────────────────────────────────────────────────

async function main() {
	const opts      = parseCliArgs();
	const platform  = createDefaultPlatform();
	const aiConfig  = loadAiConfig();

	// 初始化数据库驱动（按运行时选 bun:sqlite 或 better-sqlite3）
	const { initDb } = await import('./database.js');
	await initDb();

	// 加载持久化数据
	const { WorkspaceManager } = await import('./workspaceManager.js');
	const { SessionManager }   = await import('./sessionManager.js');
	const [workspaceManager, sessionManager] = await Promise.all([
		WorkspaceManager.load(),
		SessionManager.load(),
	]);

	const { server, listener } = await bootstrap({
		sessionManager,
		workspaceManager,
		platform: {
			config:    platform.config,
			workspace: platform.workspace,
			fs:        platform.fs,
			terminal:  platform.terminal,
			storage:   platform.storage,
			auth:      platform.auth,
		},
		toolExecutor: platform.toolExecutor,
		listen: {
			port:     opts.port,
			hostname: opts.host,
			username: opts.username,
			password: opts.password,
		},
		cors: opts.cors,
	});

	// ─── 集成终端 WebSocket 服务 ──────────────────────────────────────────────

	/**
	 * 通过将 WebSocketServer 附加到底层 HTTP server 实现终端功能。
	 * 协议：
	 *  客户端 → 服务端：
	 *    - JSON { type: 'resize', cols: number, rows: number } — 调整 PTY 大小
	 *    - 其他任意字符串 — 作为 stdin 发送到 PTY
	 *  服务端 → 客户端：
	 *    - JSON { type: 'ready', id: string } — 终端就绪（首次连接时）
	 *    - 普通字符串 — PTY stdout/stderr 输出
	 */
	const wss = new WebSocketServer({ noServer: true });
	/** termId → IPty 进程（用 any 避免顶层静态引用 pty 模块） */
	const ptyProcesses = new Map<string, import('@lydell/node-pty').IPty>();

	/** 从 HTTP server 拦截 /terminal WebSocket 升级请求 */
	listener.httpServer.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', `http://localhost`);
		if (!url.pathname.startsWith('/terminal')) {
			socket.destroy();
			return;
		}
		// 简单 Basic Auth 验证（复用 HTTP server 的认证凭据）
		const auth = req.headers['authorization'];
		const queryAuth = url.searchParams.get('auth');
		let authed = false;
		const expectedB64 = Buffer.from(`${opts.username ?? 'maxian'}:${opts.password ?? ''}`).toString('base64');
		if (auth) {
			const b64 = auth.replace(/^Basic\s+/i, '');
			authed = b64 === expectedB64;
		}
		if (!authed && queryAuth) {
			authed = queryAuth === expectedB64;
		}
		if (!authed && !opts.password) {
			// 若服务器无密码要求，允许无认证连接
			authed = true;
		}
		if (!authed) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket as any, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', async (ws: WebSocket, req: import('node:http').IncomingMessage) => {
		const url = new URL(req.url ?? '/', `http://localhost`);
		const cwd = url.searchParams.get('cwd') ?? process.cwd();
		const termId = url.searchParams.get('id') ?? Math.random().toString(36).slice(2);

		// 使用用户默认 shell
		const shell = process.env['SHELL'] ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
		const cols = parseInt(url.searchParams.get('cols') ?? '120', 10);
		const rows = parseInt(url.searchParams.get('rows') ?? '30', 10);

		// 懒加载 pty（参见文件顶部 loadPty 说明）
		let pty: PtyModule;
		try {
			pty = await loadPty();
		} catch (e) {
			console.error('[Terminal] 加载 @lydell/node-pty 失败:', e);
			try { ws.send(JSON.stringify({ type: 'error', message: 'PTY 模块不可用: ' + (e as Error).message })); } catch {}
			try { ws.close(); } catch {}
			return;
		}

		let ptyProcess: ReturnType<typeof pty.spawn> | null = null;
		try {
			ptyProcess = pty.spawn(shell, [], {
				name: 'xterm-256color',
				cols,
				rows,
				cwd,
				env: {
					...process.env,
					// 强制 UTF-8 locale，确保 ls/grep 等命令能正确显示中文文件名。
					// Tauri GUI 进程不继承 shell 环境，process.env.LANG 可能为空或错误值，
					// 必须显式覆盖 LANG + LC_ALL + LC_CTYPE，且必须使用完整 locale 名称（en_US.UTF-8），
					// 仅设置 'UTF-8' 是无效的 locale 值。
					LANG:     'en_US.UTF-8',
					LC_ALL:   'en_US.UTF-8',
					LC_CTYPE: 'en_US.UTF-8',
					TERM:     'xterm-256color',
				} as Record<string, string>,
			});
		} catch (err) {
			console.error('[Terminal] PTY spawn 失败:', err);
			ws.send(JSON.stringify({ type: 'error', message: String(err) }));
			ws.close();
			return;
		}

		ptyProcesses.set(termId, ptyProcess);
		console.log(`[Terminal] 新终端 ${termId} (pid=${ptyProcess.pid}, shell=${shell}, cwd=${cwd})`);

		// 发送就绪信号
		ws.send(JSON.stringify({ type: 'ready', id: termId, pid: ptyProcess.pid }));

		// PTY → WebSocket（输出）
		// @lydell/node-pty 默认 encoding='utf8'，onData 返回已解码的 Unicode 字符串。
		// 用 Buffer.from(data, 'utf8') 将 Unicode 字符串重新编码为 UTF-8 字节，
		// 以二进制帧发送，前端以 Uint8Array 写入 xterm.js，中文等多字节字符正确显示。
		ptyProcess.onData((data: string) => {
			if (ws.readyState === 1 /* OPEN */) {
				ws.send(Buffer.from(data, 'utf8'));
			}
		});

		ptyProcess.onExit(({ exitCode }) => {
			console.log(`[Terminal] 终端 ${termId} 退出 (exitCode=${exitCode})`);
			ptyProcesses.delete(termId);
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
				ws.close();
			}
		});

		// WebSocket → PTY（输入）
		ws.on('message', (data: Buffer | string) => {
			const msg = data.toString();
			try {
				const parsed = JSON.parse(msg);
				if (parsed.type === 'resize' && ptyProcess) {
					const c = Math.max(1, parsed.cols ?? 80);
					const r = Math.max(1, parsed.rows ?? 24);
					ptyProcess.resize(c, r);
					return;
				}
			} catch { /* 非 JSON → 直接作为输入 */ }
			ptyProcess?.write(msg);
		});

		ws.on('close', () => {
			console.log(`[Terminal] WebSocket 关闭，终止 PTY ${termId}`);
			ptyProcesses.delete(termId);
			try { ptyProcess?.kill(); } catch { /* ignore */ }
		});

		ws.on('error', (err) => {
			console.error(`[Terminal] WebSocket 错误 (${termId}):`, err);
		});
	});

	// ─── 会话 API 历史（in-memory，key: sessionId） ──────────────────────────
	const sessionHistories = new Map<string, MessageParam[]>();

	// ─── 模拟模式辅助函数 ─────────────────────────────────────────────────────

	async function streamMock(sessionId: string, text: string) {
		const delay  = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
		const tokens = text.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9]/g) ?? [text];
		for (const token of tokens) {
			await server.sessionManager.emitEvent(sessionId, {
				type: 'assistant_message', sessionId, content: token, isPartial: true,
			});
			await delay(30 + Math.random() * 40);
		}
	}

	function mockReply(userMsg: string): string {
		const replies = [
			`好的，我理解你想要"${userMsg.slice(0, 20)}${userMsg.length > 20 ? '…' : ''}"。\n\n这是一个很好的问题！让我来帮你分析一下：\n\n1. 首先，我们需要明确需求范围\n2. 然后，制定合理的实现方案\n3. 最后，逐步完成并验证结果\n\n请告诉我更多细节，我可以提供更具体的帮助。`,
			`收到！关于"${userMsg.slice(0, 15)}${userMsg.length > 15 ? '…' : ''}"，我有以下建议：\n\n\`\`\`typescript\n// 示例代码\nfunction solution() {\n  // TODO: 根据需求实现\n  return '完成';\n}\n\`\`\`\n\n如需调整，请随时告知。`,
		];
		return replies[Math.floor(Math.random() * replies.length)];
	}

	// ─── 获取 AI Handler（优先运行时配置 → 静态配置 → null） ─────────────────

	// Handler 复用池：按 (uiMode + businessCode + apiUrl) 缓存同一个实例，
	// 避免每次请求都 new 掉跨请求的 prompt 缓存哈希/命中统计。
	const __aiHandlerCache = new Map<string, AiProxyHandler>();

	/**
	 * 活跃 LLM 流注册表：sessionId → 当前正在 createMessage 的 handler。
	 * 用于"思考过程中点取消"立刻 abort fetch，而不是等下一块 chunk 到达才检测。
	 *
	 * 写入：进入 for-await 前 set
	 * 清除：for-await 退出（finally）
	 * 读取：sessionManager.onCancel 注册的全局 hook → 立即调 stopCurrentRequest()
	 */
	const __activeStreamHandlers = new Map<string, AiProxyHandler>();

	// 注册全局取消 hook：用户点 stop 时立刻 abort 当前 active handler 的 fetch
	server.sessionManager.onCancel(async (sessionId: string) => {
		const h = __activeStreamHandlers.get(sessionId);
		if (h) {
			console.log(`[Cancel] 主动 abort session ${sessionId} 的活跃 LLM 流`);
			try { await h.stopCurrentRequest(); } catch (e) {
				console.warn('[Cancel] stopCurrentRequest 失败:', (e as Error).message);
			}
		}
	});
	function getAiHandler(uiMode?: string): AiProxyHandler | null {
		const defaultCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';

		// 1. 运行时动态配置
		const runtimeCfg = server.getAiConfig();
		if (runtimeCfg) {
			const bizCode = (runtimeCfg as any).businessCode ?? defaultCode;
			const cacheKey = `rt|${runtimeCfg.apiUrl}|${runtimeCfg.username}|${bizCode}`;
			const cached = __aiHandlerCache.get(cacheKey);
			if (cached) return cached;
			const h = new AiProxyHandler({
				apiUrl:            runtimeCfg.apiUrl,
				username:          runtimeCfg.username,
				password:          runtimeCfg.password,
				businessCode:      bizCode,
				flashBusinessCode: (runtimeCfg as any).flashBusinessCode ?? undefined,
			});
			__aiHandlerCache.set(cacheKey, h);
			return h;
		}
		// 2. 启动时静态配置
		if (aiConfig && aiConfig.type === 'proxy') {
			const bizCode = uiMode === 'chat' ? 'IDE_CHAT_ASK' : (aiConfig.businessCode ?? 'IDE_CHAT_CODE');
			const cacheKey = `st|${aiConfig.apiUrl}|${aiConfig.username}|${bizCode}`;
			const cached = __aiHandlerCache.get(cacheKey);
			if (cached) return cached;
			const h = new AiProxyHandler({
				apiUrl:            aiConfig.apiUrl,
				username:          aiConfig.username,
				password:          aiConfig.password,
				businessCode:      bizCode,
				flashBusinessCode: aiConfig.flashBusinessCode ?? undefined,
			});
			__aiHandlerCache.set(cacheKey, h);
			return h;
		}
		return null;
	}

	// ─── AI 调用日志推送（对标码弦 IDE /ai/call-log） ────────────────────────

	function formatDate(d: Date): string {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	}

	async function pushAiCallLog(opts: {
		sessionId:      string;
		uiMode:         string;         // 'chat' | 'code'
		userContent:    string;
		responseText:   string;
		inputTokens:    number;
		outputTokens:   number;
		toolCallsCount: number;
		durationMs:     number;
		status:         'success' | 'failed' | 'aborted';
		errorMessage?:  string;
	}): Promise<void> {
		// 只在有代理配置时推送
		const cfg = server.getAiConfig() ?? (aiConfig?.type === 'proxy' ? aiConfig : null);
		if (!cfg || (cfg as any).type !== 'proxy') return;
		const proxyCfg = cfg as { apiUrl: string; username: string; password: string };
		const baseUrl = proxyCfg.apiUrl.replace(/\/+$/, '');
		const logUrl  = `${baseUrl}/ai/call-log`;

		const businessCode = opts.uiMode === 'chat' ? 'IDE_CHAT_ASK' : 'IDE_CHAT_CODE';
		const now = new Date();
		const startTime = new Date(now.getTime() - opts.durationMs);

		const body = {
			traceId:          opts.sessionId,
			userEmail:        proxyCfg.username,
			provider:         'proxy',
			model:            businessCode,
			operation:        opts.uiMode === 'chat' ? 'chat' : 'agent',
			mode:             businessCode,
			inputTokens:      opts.inputTokens,
			outputTokens:     opts.outputTokens,
			inputCost:        null,
			outputCost:       null,
			durationMs:       opts.durationMs,
			firstTokenMs:     null,
			status:           opts.status,
			errorCode:        null,
			errorMessage:     opts.errorMessage ?? null,
			requestSummary:   opts.userContent.slice(0, 200),
			responseSummary:  opts.responseText.slice(0, 200),
			hasTools:         opts.toolCallsCount > 0,
			toolCallsCount:   opts.toolCallsCount,
			clientIp:         null,
			startTime:        formatDate(startTime),
			endTime:          formatDate(now),
		};

		try {
			const res = await fetch(logUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (res.ok) {
				console.log(`[AILog] 日志推送成功 (${businessCode}, ${opts.inputTokens}+${opts.outputTokens} tokens)`);
			} else {
				console.warn(`[AILog] 日志推送失败: ${res.status}`);
			}
		} catch (e) {
			console.warn('[AILog] 日志推送异常:', (e as Error).message);
		}
	}

	// ─── 心跳服务（对标码弦 IDE HeartbeatService） ────────────────────────────
	/**
	 * 每 60 秒 POST 到 {apiUrl}/knowledge/userOnline/heartbeat，
	 * 报告当前客户端的在线状态。
	 * 启动条件：AI 代理配置就绪（登录后）。
	 * 停止条件：进程退出 / 代理配置清除。
	 */
	const HEARTBEAT_INTERVAL_MS = 60 * 1000;
	const HEARTBEAT_APP_VERSION  = '0.1.0';
	const HEARTBEAT_IDE_TYPE     = 'Maxian Desktop';
	const HEARTBEAT_CLIENT_ID    = randomUUID();

	function detectOsType(): string {
		const p = process.platform;
		if (p === 'darwin') return 'macOS';
		if (p === 'win32')  return 'Windows';
		if (p === 'linux')  return 'Linux';
		return p;
	}

	let heartbeatTimer: NodeJS.Timeout | undefined;
	let heartbeatRunning = false;

	async function sendHeartbeat(): Promise<void> {
		// 优先用运行时配置（登录后动态设置），否则用 CLI 静态配置
		const cfg = server.getAiConfig() ?? (aiConfig?.type === 'proxy' ? aiConfig : null);
		if (!cfg) {
			// 未登录 / 无代理配置：静默跳过
			return;
		}
		const proxyCfg = cfg as { apiUrl: string; username: string; password: string };
		if (!proxyCfg.apiUrl || !proxyCfg.username) return;

		const baseUrl = proxyCfg.apiUrl.replace(/\/+$/, '');
		const url = `${baseUrl}/knowledge/userOnline/heartbeat`;

		const body = {
			userName:      proxyCfg.username,
			clientId:      HEARTBEAT_CLIENT_ID,
			pluginVersion: HEARTBEAT_APP_VERSION,
			ideType:       HEARTBEAT_IDE_TYPE,
			osType:        detectOsType(),
		};

		try {
			const res = await fetch(url, {
				method:  'POST',
				headers: { 'Content-Type': 'application/json;charset=UTF-8' },
				body:    JSON.stringify(body),
			});
			if (res.ok) {
				console.log(`[Heartbeat] 在线心跳 → ${proxyCfg.username}`);
			} else {
				console.warn(`[Heartbeat] 状态码异常: ${res.status}`);
			}
		} catch (e) {
			console.warn('[Heartbeat] 发送失败:', (e as Error).message);
		}
	}

	function startHeartbeat(): void {
		if (heartbeatRunning) return;
		heartbeatRunning = true;
		// 立即发送一次
		void sendHeartbeat();
		heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
		console.log(`[Heartbeat] 启动（${HEARTBEAT_INTERVAL_MS / 1000}s 间隔, clientId=${HEARTBEAT_CLIENT_ID.slice(0, 8)}…）`);
	}

	function stopHeartbeat(): void {
		if (!heartbeatRunning) return;
		heartbeatRunning = false;
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
		console.log('[Heartbeat] 停止');
	}

	// 监听代理配置变更：配置生效 → 启动；配置清除 → 停止
	server.onAiConfigChanged((cfg) => {
		if (cfg) startHeartbeat();
		else stopHeartbeat();
	});

	// ─── 注册全局辅助（question / plan_exit / task 工具用） ─────────────────
	(globalThis as any).__maxianWaitForQuestion = (sid: string, timeout: number) =>
		server.sessionManager.waitForQuestionAnswer(sid, timeout);
	(globalThis as any).__maxianWaitForPlanExit = (sid: string, timeout: number) =>
		server.sessionManager.waitForPlanExit(sid, timeout);
	// /compact 命令入口
	(globalThis as any).__maxianForceCompact = async (sid: string) => {
		const session = server.sessionManager.getSession(sid);
		if (!session) throw new Error('session not found');
		const wsPath = server.sessionManager.getWorkspacePath(sid) ?? process.cwd();
		const uiMode = session.uiMode ?? 'code';
		const history = await server.sessionManager.loadHistory(sid);
		const handler = getAiHandler(uiMode);
		const systemLen = 4000 + (loadProjectInstructions(wsPath).length) + (loadAvailableSkills(wsPath).length);

		// 估算当前 token + 通知前端开始
		const { estimateHistoryTokens, COMPACT_L2_THRESHOLD } = await import('./contextCompaction.js');
		const currentTokens = estimateHistoryTokens(history as any, systemLen);
		await server.sessionManager.emitEvent(sid, {
			type: 'context_compacting',
			sessionId: sid,
			tokensCurrent: currentTokens,
			willLevel2:    currentTokens >= COMPACT_L2_THRESHOLD || !!handler,  // 手动触发默认走 L2
			manual:        true,
		} as any);

		try {
			const report = await forceCompact(history as any, systemLen, handler);
			await server.sessionManager.saveHistory(sid, report.compactedHistory as any);
			await server.sessionManager.emitEvent(sid, {
				type: 'context_compacted',
				sessionId: sid,
				level: report.level,
				tokensBefore: report.tokensBefore,
				tokensAfter:  report.tokensAfter,
				prunedTools:  report.prunedTools,
				summarizedMsgs: report.summarizedMsgs,
				manual: true,
			} as any);
			return {
				level: report.level,
				tokensBefore: report.tokensBefore,
				tokensAfter:  report.tokensAfter,
				prunedTools:  report.prunedTools,
				summarizedMsgs: report.summarizedMsgs,
			};
		} catch (e) {
			// 失败也要通知前端收尾
			await server.sessionManager.emitEvent(sid, {
				type: 'context_compacted',
				sessionId: sid,
				level: 0,
				tokensBefore: currentTokens,
				tokensAfter:  currentTokens,
				prunedTools:  0,
				summarizedMsgs: 0,
				manual: true,
				error: (e as Error).message,
			} as any);
			throw e;
		}
	};

	// ─── 加载用户插件（#11 Plugin 系统） ────────────────────────────────
	const pluginTools = new Map<string, PluginToolDef>();
	const loadedPlugins: LoadedPlugin[] = [];
	try {
		const plugins = await loadAllPlugins();
		for (const p of plugins) {
			if (p.error) {
				console.warn(`[Plugin] 加载 ${p.name} 失败: ${p.error}`);
				continue;
			}
			const hookCount = p.hooks ? Object.keys(p.hooks).length : 0;
			console.log(`[Plugin] 已加载 ${p.name}@${p.version} (${p.tools.length} 工具, ${hookCount} hook)`);
			loadedPlugins.push(p);
			for (const t of p.tools) {
				if (pluginTools.has(t.name)) {
					console.warn(`[Plugin] 工具 ${t.name} 重名，跳过（来自 ${p.name}）`);
					continue;
				}
				pluginTools.set(t.name, t);
				AGENT_TOOL_DEFINITIONS.push({
					name:        t.name,
					description: t.description,
					parameters:  t.parameters,
				});
			}
		}
	} catch (e) {
		console.warn('[Plugin] 插件加载异常:', (e as Error).message);
	}
	(globalThis as any).__maxianPluginTools = pluginTools;
	(globalThis as any).__maxianPlugins    = loadedPlugins;
	(globalThis as any).__maxianTriggerHook = async (event: string, ctx: any) =>
		triggerPluginHook(loadedPlugins, event as any, ctx);

	// 启动时清理一次旧截断文件，之后每 1 小时清理
	try { Truncate.cleanup(); } catch { /* ignore */ }
	setInterval(() => { try { Truncate.cleanup(); } catch { /* ignore */ } }, 3600_000);

	// 启动时若已有静态 aiConfig（CLI/环境变量传入），立即启动
	if (aiConfig && aiConfig.type === 'proxy') {
		startHeartbeat();
	}

	/** Anthropic 直连流式调用（不走代理） */
	async function* callAnthropic(
		messages: MessageParam[],
	): AsyncGenerator<string> {
		if (!aiConfig || aiConfig.type !== 'anthropic') return;
		const cfg = aiConfig;
		const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': cfg.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model:      cfg.model,
				max_tokens: 8192,
				stream:     true,
				system:     '你是码弦 AI 助手，帮助用户完成编程任务。请用中文回复。',
				messages:   messages.map(m => ({
					role:    m.role,
					content: typeof m.content === 'string' ? m.content : m.content,
				})),
			}),
		});

		if (!res.ok) {
			const t = await res.text().catch(() => '');
			throw new Error(`Anthropic API ${res.status}: ${t}`);
		}

		const reader  = res.body!.getReader();
		const decoder = new TextDecoder();
		let buf = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				const data = line.slice(5).trim();
				if (data === '[DONE]' || !data) continue;
				try {
					const evt = JSON.parse(data);
					if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
						yield evt.delta.text as string;
					}
				} catch { /* skip */ }
			}
		}
	}

	// ─── Agent 循环 ─────────────────────────────────────────────────────────────

	/**
	 * 完整的 Agent 循环：
	 *   1. 调用 AI（携带工具定义）
	 *   2. 收集文本块 → 实时推送到前端
	 *   3. 收集 tool_use 块（完整的，非 partial）
	 *   4. 无工具调用 → 结束
	 *   5. 有工具调用 → 执行工具，将结果追加到历史，继续循环
	 */
	// ── AGENTS.md / CLAUDE.md 自动加载（向上找 + 全局路径） ─────────────
	/**
	 * 生成当前平台信息注入到系统提示词。
	 * 让 AI 生成 shell 命令时避开平台不兼容的调用（ls vs dir, && 语法等）。
	 * Windows 下如果探测到 Git Bash，会告诉 AI 可以用 unix 语法；否则提示只能用 cmd/PowerShell。
	 */
	function formatPlatformInfo(): string {
		const plat = process.platform;
		let osLabel: string;
		let shellHint: string;
		if (plat === 'darwin') {
			osLabel = 'macOS';
			shellHint = '默认 shell: zsh / bash，支持标准 Unix 命令（ls/grep/cat/find/sed 等）和 && 链式';
		} else if (plat === 'linux') {
			osLabel = 'Linux';
			shellHint = '默认 shell: bash，支持标准 Unix 命令和 && 链式';
		} else if (plat === 'win32') {
			// 检测是否装有 Git Bash（与工具执行端的探测逻辑保持一致）
			const gitBashPaths = [
				'C:\\Program Files\\Git\\bin\\bash.exe',
				'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
			];
			const hasGitBash = gitBashPaths.some(p => { try { return fs.existsSync(p); } catch { return false; } });
			osLabel = 'Windows';
			shellHint = hasGitBash
				? '检测到 Git Bash，execute_command / bash 工具已**自动路由到 bash**，可直接使用 Unix 命令（ls/cat/grep/&& 等）。路径分隔符用正斜杠或反斜杠均可。'
				: '**未检测到 Git Bash**，execute_command 将退回 PowerShell / cmd.exe 执行。请优先使用**PowerShell 语法**（Get-ChildItem、Get-Content、`;` 分隔命令代替 `&&`），避免 `ls/cat/grep/rm -rf` 等 Unix 命令。';
		} else {
			osLabel = plat;
			shellHint = '未知平台';
		}
		return `操作系统：${osLabel}\n${shellHint}`;
	}

	function loadProjectInstructions(workspacePath: string): string {
		const candidates: string[] = [];
		const targets = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

		// 项目：从 workspacePath 向上找
		let dir = workspacePath;
		const seen = new Set<string>();
		while (dir && dir !== '/' && !seen.has(dir)) {
			seen.add(dir);
			for (const t of targets) {
				const p = path.join(dir, t);
				if (fs.existsSync(p)) candidates.push(p);
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		// 全局：~/.maxian/AGENTS.md 或 ~/.claude/CLAUDE.md
		const globalPaths = [
			path.join(os.homedir(), '.maxian', 'AGENTS.md'),
			path.join(os.homedir(), '.claude', 'CLAUDE.md'),
			path.join(os.homedir(), '.claude', 'AGENTS.md'),
		];
		for (const p of globalPaths) {
			if (fs.existsSync(p)) candidates.push(p);
		}

		if (candidates.length === 0) return '';
		const parts: string[] = [];
		const addedFiles = new Set<string>();
		for (const p of candidates) {
			if (addedFiles.has(p)) continue;
			addedFiles.add(p);
			try {
				const content = fs.readFileSync(p, 'utf8');
				if (content.trim().length === 0) continue;
				parts.push(`<!-- 来自 ${p} -->\n${content.trim()}`);
			} catch { /* ignore */ }
		}
		if (parts.length === 0) return '';
		return '\n\n====\n\nPROJECT INSTRUCTIONS（项目约束，优先级高于默认提示）\n\n' + parts.join('\n\n---\n\n');
	}

	// ── Skills 列表预注入（支持目录型 <name>/SKILL.md 和平铺 <name>.md） ──
	function loadAvailableSkills(workspacePath: string): string {
		const dirs = [
			{ path: path.join(workspacePath, '.maxian', 'skills'), source: '项目 .maxian' },
			{ path: path.join(workspacePath, '.claude', 'skills'), source: '项目 .claude' },
			{ path: path.join(os.homedir(), '.maxian', 'skills'), source: '用户 ~/.maxian' },
			{ path: path.join(os.homedir(), '.claude', 'skills'), source: '用户 ~/.claude' },
		];

		interface Skill { name: string; description: string; source: string }
		const seen = new Set<string>();
		const skills: Skill[] = [];

		const scanSkillEntries = (dir: string): Array<{ name: string; abs: string }> => {
			const out: Array<{ name: string; abs: string }> = [];
			if (!fs.existsSync(dir)) return out;
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { return out; }
			for (const entry of entries) {
				const absEntry = path.join(dir, entry);
				let stat: fs.Stats;
				try { stat = fs.statSync(absEntry); } catch { continue; }  // statSync 跟随符号链接
				if (stat.isFile() && entry.endsWith('.md')) {
					out.push({ name: entry.slice(0, -3), abs: absEntry });
				} else if (stat.isDirectory()) {
					for (const c of ['SKILL.md', 'skill.md', 'README.md']) {
						const abs = path.join(absEntry, c);
						if (fs.existsSync(abs)) { out.push({ name: entry, abs }); break; }
					}
				}
			}
			return out;
		};

		for (const { path: dir, source } of dirs) {
			for (const { name, abs } of scanSkillEntries(dir)) {
				if (seen.has(name)) continue;
				seen.add(name);
				let description = '';
				let finalName = name;
				try {
					const raw = fs.readFileSync(abs, 'utf8');
					if (raw.startsWith('---\n')) {
						const end = raw.indexOf('\n---\n', 4);
						if (end > 0) {
							const fm = raw.slice(4, end);
							const dm = fm.match(/^description:\s*(.+)$/m);
							const nm = fm.match(/^name:\s*(.+)$/m);
							if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
							if (nm) finalName = nm[1].trim().replace(/^["']|["']$/g, '');
						}
					}
					if (!description) {
						const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
						const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
						if (firstLine) description = firstLine.trim().slice(0, 120);
					}
				} catch { /* ignore */ }
				skills.push({ name: finalName, description, source });
			}
		}

		if (skills.length === 0) return '';
		const lines = skills.map(s => `- **${s.name}** (${s.source}): ${s.description || '无描述'}`).join('\n');
		return `\n\n====\n\nAVAILABLE SKILLS（可用技能文档）\n\n你可以通过 \`load_skill\` 工具按需加载这些专业技能文档：\n\n${lines}\n\n**重要**：当任务属于某个技能覆盖的领域时，**务必**先 load_skill 读取对应文档再动手。`;
	}

	// ═════════════════════════════════════════════════════════════════════
	// E. Prompt 静态/动态分离：让 Anthropic prompt caching & DashScope 前缀缓存命中
	// ═════════════════════════════════════════════════════════════════════

	/** 静态 prompt 段（只依赖 mode，哈希稳定，可被 LLM 缓存）*/
	const STATIC_PROMPT_EXPLORE = `【语言】简体中文输出。代码/路径/标识符保持原文。

你是码弦代码探索专家，专门高效导航和搜索代码库。

## 你的能力
- 用 glob/search_files 快速按模式匹配文件
- 用 grep 用正则搜索文件内容
- 用 read_file 读取并分析文件内容

## 执行原则
- 用 glob 做宽泛文件模式匹配
- 用 grep 带正则的内容搜索
- 用 read_file 明确已知路径时直接读
- 返回**绝对路径**，结论要清晰简洁
- **禁止任何文件修改**（只读 agent）
- 完成后简短总结发现`;

	const STATIC_PROMPT_PLAN = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 计划助手（Plan 模式），**只输出实现计划，不执行任何文件操作**。

====

PLAN MODE RULES

1. **只规划，不执行**：严禁调用任何文件写入工具（write_to_file、edit、multiedit）
2. 可以使用只读工具（read_file、search_files、list_files）了解代码结构
3. 输出一个结构化的 Markdown 实现计划：
   - 背景分析（要解决的问题）
   - 文件变更清单（哪些文件需要改、改什么）
   - 分步实现步骤（编号列表，每步一句话）
   - 潜在风险和注意事项
4. 计划完成后，用户可点击"开始执行"切换到 Code 模式实际执行

只读工具：read_file, search_files, list_files`;

	const STATIC_PROMPT_CHAT = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 助手，负责回答编程相关问题、解释概念、进行代码审查。

====

WORKING CONTRACT

- 完成用户目标第一优先；最少探索后执行修改
- **【强制】输出语言：简体中文。任何英文自然语言句子一律违规**
- 代码、命令、路径、API字段名、标识符保持原文，不翻译
- Markdown 简洁：短列表 + 代码块
- 每轮自然语言 ≤ 200 字，代码只出现在工具参数里

====

OBJECTIVE

你是一个问答助手，以对话方式帮助用户：
- 解释代码逻辑、架构设计、技术概念
- 回答编程问题，提供示例代码（在聊天中展示，不操作文件）
- 代码审查、错误分析、性能建议

====

FOLLOWUP SUGGESTIONS（可选）

在完整回答结束后，如果有自然的追问方向，可在**最末尾**输出最多 3 条简短追问建议：
\`\`\`
<<<FOLLOWUP>>>
- 追问 1
- 追问 2
- 追问 3
\`\`\`
该区块会被前端自动抽取并显示为"建议追问"按钮。如果回答已经完整、无需追问，不要输出此区块。`;

	const STATIC_PROMPT_CODE = `【语言规定】你只能用简体中文输出自然语言。所有说明、分析、总结、错误提示必须是简体中文。代码/命令/路径/标识符保持原文。

你是码弦 AI 编程助手（agent 模式），可以直接操作文件系统完成编程任务。

====

WORKING CONTRACT

- 完成用户目标第一优先；最少探索后执行修改
- **【强制】输出语言：简体中文。任何英文自然语言句子一律违规**
- 代码、命令、路径、API字段名、标识符保持原文，不翻译
- Markdown 简洁：短列表 + 代码块
- 每轮自然语言 ≤ 200 字，代码只出现在工具参数里

====

HARD RULES

1. **【语言】所有自然语言必须是简体中文**——思考过程、分析、说明、总结、错误解释——英文句子即为违规
2. **先读后改**：任何 edit/write_to_file 前必须先 read_file 完整读过；未读直接失败
3. **并行只读**：需要读多个无依赖文件时，**必须在同一轮同时调用**（如同时调用 read_file A + read_file B），禁止逐个顺序读取
4. **工具失败后**：禁止立即用相同参数重试；下一步必须是 read_file 或 search_files 验证当前真实状态
5. **编译/类型错误**：先 read_file 错误行 ±5 行，不要只看错误消息就改
6. **禁止废话**：不要复述将要写的代码，不要以问题结尾

====

TOOL SELECTION

按目标直接选工具，不要犹豫：

| 我想... | 用这个工具 |
|---|---|
| 找"某个字符串/符号/函数名"在哪 | search_files（regex） |
| 看一个已知路径文件 | read_file |
| 浏览一个目录结构 | list_files |
| 改一个位置 | edit |
| 创建新文件 | write_to_file |
| 执行命令/测试/构建 | execute_command |

**并行工具规则（减少 API 往返）**：
1. 改文件前**必须**先 read_file 完整读一次
2. **多个只读操作必须在同一轮并行发起**（上限 4 个）——5 个文件应 1 轮读完，而非 5 轮
3. write_to_file/edit 类工具 error 后，**禁止立即用相同参数重试**——先 read_file 确认当前内容
4. **严禁把代码直接输出到聊天框**——所有代码必须通过工具写入文件

====

OBJECTIVE

你是一个 agent — 持续工作直到任务**完全解决**。能用工具解决的不要回答文字。

## 执行流程

1. **探索**：必要时先 list_files / read_file 了解结构
2. **执行**：直接调用工具完成文件操作，不要把代码贴在聊天里
3. **验证**：必要时 execute_command 验证
4. **完成**：简要总结做了什么（≤ 100 字中文）

## 关键原则

- 用户说"创建/设计/写一个 xxx 文件" → **必须调用 write_to_file**，不能把代码贴在聊天框
- 用户说"修改/更新 xxx" → 先 read_file，再 edit
- 任何文件操作都通过工具，**绝不在回复文本里输出完整代码**`;

	function getStaticPromptByMode(mode: string): string {
		if (mode === 'explore') return STATIC_PROMPT_EXPLORE;
		if (mode === 'plan')    return STATIC_PROMPT_PLAN;
		if (mode === 'ask' || mode === 'chat') return STATIC_PROMPT_CHAT;
		return STATIC_PROMPT_CODE;  // 'code' 和其他默认
	}

	/**
	 * 动态 prompt 段：workspace / platform / project instructions / skills / 自定义
	 * 每次都会变，放在静态段后面，不进缓存。
	 */
	function composeDynamicSuffix(workspacePath: string, projectAndSkills: string): string {
		const systemInfo = `\n\n====\n\nSYSTEM INFO\n\n工作区根目录：${workspacePath}\n${formatPlatformInfo()}`;
		return systemInfo + projectAndSkills;
	}

	async function runAgentLoop(
		sessionId:     string,
		userContent:   string,
		history:       MessageParam[],
		workspacePath: string,
		mode:          string = 'code',
		uiMode:        string = 'code',
	): Promise<string> {
		const MAX_ITERATIONS = 30;
		// 清掉上次遗留的取消标记（这次是新任务启动，不该继承上次的 cancel 状态）
		server.sessionManager.resetCancelled(sessionId);
		const ctx            = new NodeToolContext(workspacePath, sessionId);
		// Doom-loop 检测器（每次 runAgentLoop 独立实例）
		const repetitionDetector = new ToolRepetitionDetector(3, workspacePath);
		let   allText        = '';   // 所有迭代累积文本（用于兜底 return）
		// 日志统计
		let   totalInputTokens  = 0;
		let   totalOutputTokens = 0;
		let   totalToolCalls    = 0;
		const loopStartTime     = Date.now();
		let   finalText      = '';   // 最终迭代文本（无工具调用时）

		// ── 根据模式构建系统提示词 & 工具列表 ──────────────────────────────────
		// E. Prompt 静态/动态分离：
		//   - getStaticPromptByMode(mode) 只依赖 mode，每次调用**哈希一致** → 可被 LLM 后端缓存
		//   - 运行时把 workspace / platform / project 等动态信息**附加到末尾**
		//   - 这样 Anthropic 的 prompt caching 能打静态段的缓存
		//     DashScope/Qwen 的隐式前缀缓存也能命中（前 N 字节不变）
		const isChatMode    = (mode === 'ask' || mode === 'chat');
		const isPlanMode    = (mode === 'plan');
		const isExploreMode = (mode === 'explore');


		// ─── 真正用的 system prompt：静态段（可缓存）+ 动态段（每次会变） ───
		const staticPrompt = getStaticPromptByMode(mode);

		// 动态段按项目路径读取（AGENTS.md / CLAUDE.md / 项目 config / skills 列表）
		const projectInstructions = loadProjectInstructions(workspacePath);
		const skillsList = loadAvailableSkills(workspacePath);
		const projectCfg = loadProjectConfig(workspacePath);
		const additionalSystemPrompt = projectCfg.additionalSystemPrompt
			? `\n\n====\n\nPROJECT CUSTOM PROMPT（.maxian/config.json）\n\n${projectCfg.additionalSystemPrompt}`
			: '';

		const dynamicSuffix = composeDynamicSuffix(
			workspacePath,
			projectInstructions + skillsList + additionalSystemPrompt,
		);

		// 最终 system prompt：静态在前（哈希稳定、可缓存），动态在后（每会话不同）
		const finalSystemPrompt = staticPrompt + dynamicSuffix;

		// 暴露静态段给上层（用于 AiProxyHandler 做 block-level cache_control 标记）
		(globalThis as any).__maxianLastStaticPromptLen = staticPrompt.length;

		// 工具集按模式过滤：
		//   chat    —— 不传工具
		//   plan    —— 只读 + plan_exit（AI 能规划不能改）
		//   explore —— 只读（不含 plan_exit、不含 question，纯探索）
		//   code    —— 全套
		const READ_ONLY_TOOLS = AGENT_TOOL_DEFINITIONS.filter(t =>
			['read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls', 'lsp', 'web_fetch', 'load_skill', 'question', 'plan_exit'].includes(t.name)
		);
		const EXPLORE_TOOLS = AGENT_TOOL_DEFINITIONS.filter(t =>
			['read_file', 'search_files', 'list_files', 'grep', 'glob', 'ls'].includes(t.name)
		);
		const activeTools = isChatMode
			? undefined
			: isExploreMode
				? EXPLORE_TOOLS
				: isPlanMode
					? READ_ONLY_TOOLS
					: AGENT_TOOL_DEFINITIONS;

		for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
			// ── 取消检查：每轮开始前检查用户是否点了"结束" ──
			if (server.sessionManager.isCancelled(sessionId)) {
				console.log(`[Agent] 检测到取消信号（iter=${iter}），中止 agent loop`);
				await server.sessionManager.emitEvent(sessionId, {
					type: 'assistant_message', sessionId,
					content: '\n\n[已按用户请求中止任务]',
					isPartial: false,
				});
				break;
			}
			// ── 获取 AI handler（按 uiMode 决定 businessCode） ──
			const handler = getAiHandler(uiMode);

			// ── 上下文压缩检查（每轮开始时）─────────────────────────────
			// 默认 128K 窗口：>55% 触发按工具类型剪枝，>85% 触发 LLM 总结
			// 1M context 模型（如 Claude 1M / Qwen-max-longcontext）需设
			// MAXIAN_CONTEXT_WINDOW=1000000 环境变量
			{
				const { estimateHistoryTokens, COMPACT_L1_THRESHOLD, COMPACT_L2_THRESHOLD } = await import('./contextCompaction.js');
				const currentTokens = estimateHistoryTokens(history, finalSystemPrompt.length);
				const willCompact = currentTokens >= COMPACT_L1_THRESHOLD;
				if (willCompact) {
					// 先通知前端压缩开始
					await server.sessionManager.emitEvent(sessionId, {
						type: 'context_compacting',
						sessionId,
						tokensCurrent: currentTokens,
						willLevel2:    currentTokens >= COMPACT_L2_THRESHOLD,
					} as any);
				}
				try {
					const report = await compactIfNeeded(history, finalSystemPrompt.length, handler);
					if (report.level > 0) {
						console.log(
							`[Compaction] Level ${report.level}: ${report.tokensBefore} → ${report.tokensAfter} tokens ` +
							`(节省 ${report.tokensBefore - report.tokensAfter}, 剪 ${report.prunedTools} 工具` +
							(report.summarizedMsgs > 0 ? `, 总结 ${report.summarizedMsgs} 条` : '') + ')'
						);
						history.length = 0;
						history.push(...report.compactedHistory);
						await server.sessionManager.saveHistory(sessionId, history as any);
					}
					// 无论是否真的压缩了，只要发了 compacting 就必须发 compacted 收尾
					if (willCompact || report.level > 0) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'context_compacted',
							sessionId,
							level: report.level,
							tokensBefore: report.tokensBefore,
							tokensAfter:  report.tokensAfter,
							prunedTools:  report.prunedTools,
							summarizedMsgs: report.summarizedMsgs,
						} as any);
					}
				} catch (e) {
					console.warn('[Compaction] 压缩失败（已跳过）:', (e as Error).message);
					// 失败也要通知前端收尾，别让 "正在压缩" toast 永远挂着
					if (willCompact) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'context_compacted',
							sessionId,
							level: 0,
							tokensBefore: currentTokens,
							tokensAfter:  currentTokens,
							prunedTools:  0,
							summarizedMsgs: 0,
							error: (e as Error).message,
						} as any);
					}
				}
			}

			if (!handler) {
				// 无 AI 配置 → 模拟模式（仅首轮）
				if (iter === 0) {
					const text = mockReply(userContent);
					await streamMock(sessionId, text);
					history.push({ role: 'assistant', content: text });
					return text;
				}
				break;
			}

			// ── 调用 AI ──
			console.log(`[Agent] iter=${iter} mode=${mode} 调用 AI，携带 ${activeTools?.length ?? 0} 个工具，历史 ${history.length} 条`);
			const toolCalls: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
			// iterText: 常规 assistant 文本（chunk.type === 'text'），在 agent 模式下被当作思考过程流出，
			//          但在最终轮无工具调用时转为 assistant。所以它会进 API history 和 DB 的 assistant。
			let iterText = '';
			// iterReasoningText: 模型原生思考（chunk.type === 'reasoning'，DeepSeek-R1/QwQ），
			//          绝对不进 API history（会污染下轮上下文），只用于持久化为 reasoning 记录。
			let iterReasoningText = '';
			let aiError: string | null = null;
			const toolInputCumLen = new Map<string, number>();
			const seenToolIds = new Set<string>();
			// reasoning 分段持久化：在 tool_use 边界把 iterText/iterReasoningText 累积的段切片入库
			let lastSavedTextOffset      = 0;
			let lastSavedReasoningOffset = 0;
			const saveReasoningSegment = async () => {
				// 注意：**不能**按 isChatMode 短路！
				// 原因：messages 表（UI 消息）与 history_entries 表（API 历史）解耦，
				// 存 reasoning 消息只用于显示，不会污染下轮 API 上下文；
				// 若在 ask/chat 模式下短路，会导致用户切换会话后"思考过程"丢失。
				// 先保存原生 reasoning_content（思考 token，DeepSeek-R1 / QwQ 等）
				const rSeg = iterReasoningText.slice(lastSavedReasoningOffset);
				if (rSeg.trim().length > 0) {
					await server.sessionManager.appendReasoningMessage(sessionId, rSeg);
					lastSavedReasoningOffset = iterReasoningText.length;
				}
				// 再保存 agent 模式下作为思考过程显示的普通 text
				// ask/chat 模式下 text 直接作 assistant_message 流出，iterText 被用作最终 assistant，
				// 所以 isChatMode 下不保存 iterText（避免与 assistant 消息重复）
				if (!isChatMode) {
					const tSeg = iterText.slice(lastSavedTextOffset);
					if (tSeg.trim().length > 0) {
						await server.sessionManager.appendReasoningMessage(sessionId, tSeg);
						lastSavedTextOffset = iterText.length;
					}
				}
			};

			// 注册当前 handler，让 cancelTask 能主动 abort（不用等下一 chunk）
			__activeStreamHandlers.set(sessionId, handler);
			try {
				for await (const chunk of handler.createMessage(finalSystemPrompt, history, activeTools)) {
					// LLM 流式输出中每一块都检查一次取消（让"结束"按钮秒级生效）
					if (server.sessionManager.isCancelled(sessionId)) {
						console.log(`[Agent] LLM 流中检测到取消，中止当前 request`);
						try { await (handler as any).stopCurrentRequest?.(); } catch {}
						aiError = '[用户取消]';
						break;
					}
					if (chunk.type === 'text') {
						iterText += chunk.text;
						allText  += chunk.text;
						if (isChatMode) {
							// 对话模式：文本直接作为助手回复实时流出
							await server.sessionManager.emitEvent(sessionId, {
								type: 'assistant_message', sessionId, content: chunk.text, isPartial: true,
							});
						} else {
							// Agent 模式：文本先作为"思考过程"实时流出；
							// 若该迭代最终无工具调用（即最终响应），再通过
							// convert_reasoning_to_assistant 事件将其转为普通助手消息。
							await server.sessionManager.emitEvent(sessionId, {
								type: 'reasoning_delta', sessionId, content: chunk.text,
							} as any);
						}
					} else if (chunk.type === 'tool_use') {
						if (chunk.isPartial) {
							// #5 流式 tool input 增量推送
							if (!seenToolIds.has(chunk.id)) {
								seenToolIds.add(chunk.id);
								// 【关键】在新 tool 首次出现的边界切片保存 reasoning——
								// AiProxyHandler 把 isPartial:false 全挤到流末尾，用它们做边界会全部合并。
								// 用首次 isPartial:true 做边界可以正确分段。
								await saveReasoningSegment();
								await server.sessionManager.emitEvent(sessionId, {
									type:       'tool_call_start',
									sessionId,
									toolName:   chunk.name,
									toolUseId:  chunk.id,
									toolParams: {},
									streaming:  true,
								} as any);
							}
							// AiProxyHandler 发的 chunk.input 是 **累积值**，在此算真正的 delta
							const cumInput = chunk.input ?? '';
							const prevLen  = toolInputCumLen.get(chunk.id) ?? 0;
							if (cumInput.length > prevLen) {
								const delta = cumInput.slice(prevLen);
								toolInputCumLen.set(chunk.id, cumInput.length);
								await server.sessionManager.emitEvent(sessionId, {
									type:       'tool_input_delta',
									sessionId,
									toolUseId:  chunk.id,
									toolName:   chunk.name,
									inputDelta: delta,
									totalLen:   cumInput.length,
								} as any);
							}
						} else {
							console.log(`[Agent] 收到完整工具调用: ${chunk.name} (id=${chunk.id})`);
							try {
								const params = JSON.parse(chunk.input);
								toolCalls.push({ id: chunk.id, name: chunk.name, params });
							} catch (e) {
								console.warn('[Agent] 解析工具参数失败:', chunk.input, e);
							}
						}
					} else if ((chunk as any).type === 'reasoning') {
						// 模型原生 reasoning_content（如 DeepSeek-R1 / QwQ）
						const reasoningText = (chunk as any).text ?? '';
						if (reasoningText.length > 0) {
							console.log(`[Agent] ✨ 原生思考内容 (${reasoningText.length}字): ${reasoningText.slice(0, 50)}${reasoningText.length > 50 ? '…' : ''}`);
							// 累积到独立的 iterReasoningText，用于持久化为 reasoning 消息
							// 注意：**绝不**进 API history，否则下轮模型会把自己的思考当上下文
							iterReasoningText += reasoningText;
						}
						await server.sessionManager.emitEvent(sessionId, {
							type: 'reasoning_delta', sessionId, content: reasoningText,
						} as any);
					} else if (chunk.type === 'usage') {
						// 累计 token 用量，发送给前端显示进度条
						const inTok  = (chunk as any).inputTokens  ?? 0;
						const outTok = (chunk as any).outputTokens ?? 0;
						totalInputTokens  += inTok;
						totalOutputTokens += outTok;
						// used = 当前**已占用的上下文窗口大小** ≈ input（input 已含全部历史）
						// output 不占输入窗口（不参与下轮对话），但加一下更直观
						const used = inTok + outTok;
						// limit 跟 contextCompaction 的 CONTEXT_WINDOW 一致（可被 env 覆盖）
						// 而不是硬编码 200K
						const limit = CONTEXT_WINDOW;
						await server.sessionManager.emitEvent(sessionId, {
							type:  'token_usage',
							sessionId,
							used,
							limit,
							inputTokens:  inTok,
							outputTokens: outTok,
						} as any);
					} else if (chunk.type === 'error') {
						aiError = chunk.error;
					}
				}
			} catch (e) {
				aiError = (e as Error).message;
			} finally {
				// 退出 for-await：注销 active handler，避免 onCancel 误 abort 后续请求
				if (__activeStreamHandlers.get(sessionId) === handler) {
					__activeStreamHandlers.delete(sessionId);
				}
			}

			// Rate-limit 检测与自动重试（P0-6）
			// 覆盖：HTTP 429、"rate limit"、"too many requests"、
			//      DashScope/Qwen 容量忙时（"throttled / capacity limits / InternalError.Algo"）、
			//      Anthropic "overloaded"、OpenAI "rate_limit_exceeded"
			if (aiError && /\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?|overloaded|InternalError\.Algo/i.test(aiError)) {
				const retryMatch = aiError.match(/retry[\s-]*(?:after)?[\s:]*(\d+)/i);
				const waitSec = retryMatch ? Math.max(5, Math.min(300, parseInt(retryMatch[1], 10))) : 30;
				const maxRetries = 3;
				let retries = 0;
				while (retries < maxRetries) {
					retries++;
					const resetAt = Date.now() + waitSec * 1000;
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit', sessionId,
						resetAt, attempt: retries,
						message: `触发限流（${waitSec}s），${retries}/${maxRetries} 次重试…`,
					} as any);
					await new Promise(r => setTimeout(r, waitSec * 1000));
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit_cleared', sessionId,
					} as any);
					aiError = null;
					// 重试也注册 active handler，让 cancel 期间也能 abort
					__activeStreamHandlers.set(sessionId, handler);
					try {
						for await (const chunk of handler.createMessage(finalSystemPrompt, history, activeTools)) {
							if (server.sessionManager.isCancelled(sessionId)) {
								try { await (handler as any).stopCurrentRequest?.(); } catch {}
								aiError = '[用户取消]';
								break;
							}
							if (chunk.type === 'text') {
								iterText += chunk.text;
								allText  += chunk.text;
								if (isChatMode) {
									await server.sessionManager.emitEvent(sessionId, {
										type: 'assistant_message', sessionId, content: chunk.text, isPartial: true,
									});
								} else {
									await server.sessionManager.emitEvent(sessionId, {
										type: 'reasoning_delta', sessionId, content: chunk.text,
									} as any);
								}
							} else if (chunk.type === 'tool_use' && !chunk.isPartial) {
								try {
									const params = JSON.parse(chunk.input);
									toolCalls.push({ id: chunk.id, name: chunk.name, params });
								} catch { /* ignore */ }
							} else if (chunk.type === 'usage') {
								totalInputTokens  += (chunk as any).inputTokens  ?? 0;
								totalOutputTokens += (chunk as any).outputTokens ?? 0;
							} else if (chunk.type === 'error') {
								aiError = chunk.error;
							}
						}
						if (!aiError) break;
						// 重试循环的退出判断必须与首次检测的正则一致，包括 "too many requests"
						// 和 "throttl" / "capacity"（DashScope/Qwen 的容量忙时提示）
						if (!/\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?/i.test(aiError)) break;
					} catch (e) {
						aiError = (e as Error).message;
						if (!/\b429\b|rate[\s_-]?limit|too many requests|throttl|capacity limits?/i.test(aiError)) break;
					} finally {
						if (__activeStreamHandlers.get(sessionId) === handler) {
							__activeStreamHandlers.delete(sessionId);
						}
					}
				}
				if (aiError) {
					await server.sessionManager.emitEvent(sessionId, {
						type: 'rate_limit_cleared', sessionId,
					} as any);
					throw new Error(`持续限流，已重试 ${retries} 次仍失败: ${aiError}`);
				}
			}

			if (aiError) {
				// 如果是首轮直接降级，否则抛出
				if (iter === 0 && aiConfig?.type === 'anthropic') {
					// Anthropic 直连模式（无工具，仅文本）
					let anthropicText = '';
					for await (const text of callAnthropic(history)) {
						anthropicText += text;
						allText       += text;
						await server.sessionManager.emitEvent(sessionId, {
							type: 'assistant_message', sessionId, content: text, isPartial: true,
						});
					}
					if (anthropicText) {
						history.push({ role: 'assistant', content: anthropicText });
					}
					return anthropicText;
				}
				throw new Error(aiError);
			}

			// ── 迭代完成日志 ──
			totalToolCalls += toolCalls.length;
			console.log(`[Agent] iter=${iter} 完成: 文本=${iterText.length}字, 工具调用=${toolCalls.length}个`);

			// ── 无工具调用 → Agent 完成 ──
			if (toolCalls.length === 0) {
				// 解析 followup 建议（<<<FOLLOWUP>>> 区块）并移除
				const fuMatch = iterText.match(/<<<FOLLOWUP>>>\s*([\s\S]*?)(?:```|$)/i);
				if (fuMatch) {
					const suggestions = fuMatch[1]
						.split('\n')
						.map(l => l.replace(/^\s*[-*•]\s*/, '').trim())
						.filter(l => l.length > 0 && l.length < 200);
					if (suggestions.length > 0) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'followup_suggestions',
							sessionId,
							suggestions: suggestions.slice(0, 5),
						} as any);
					}
					// 从显示/历史文本中移除 followup 区块（含 ``` 包围符）
					iterText = iterText.replace(/```\s*<<<FOLLOWUP>>>[\s\S]*?```/i, '').trim();
					iterText = iterText.replace(/<<<FOLLOWUP>>>[\s\S]*$/i, '').trim();
				}
				finalText = iterText;
				// 在最终轮把原生 reasoning_content（思考 token）持久化为独立 reasoning 消息
				// 无论 chat 还是 agent 模式都保存（仅存 messages 表供 UI 显示，不进 API 历史）
				if (iterReasoningText.trim().length > 0) {
					const rSeg = iterReasoningText.slice(lastSavedReasoningOffset);
					if (rSeg.trim().length > 0) {
						await server.sessionManager.appendReasoningMessage(sessionId, rSeg);
					}
				}
				if (iterText) {
					// Agent 模式：文本以 reasoning_delta 方式流出，此处转为最终助手消息
					if (!isChatMode) {
						await server.sessionManager.emitEvent(sessionId, {
							type: 'convert_reasoning_to_assistant', sessionId,
						} as any);
					}
					history.push({ role: 'assistant', content: iterText });
				}
				break;
			}

			// ── 有工具调用：把本轮最后一段 reasoning 尾巴保存（如果存在尾随 text）──
			await saveReasoningSegment();

			// ── 将助手消息（含 tool_use 块）追加到历史 ──
			const assistantContent: ContentBlock[] = [];
			if (iterText) {
				assistantContent.push({ type: 'text', text: iterText });
			}
			for (const tc of toolCalls) {
				assistantContent.push({
					type:  'tool_use',
					id:    tc.id,
					name:  tc.name,
					input: tc.params,
				});
			}
			history.push({ role: 'assistant', content: assistantContent });

			// ── 执行工具，收集结果（#12 并行执行 + #3 doom-loop） ─────────
			const toolResultBlocks: ContentBlock[] = [];

			// 破坏性工具（需审批 + 串行执行）
			const DESTRUCTIVE_TOOLS = new Set([
				'write_to_file', 'edit', 'multiedit', 'execute_command', 'bash', 'apply_patch',
			]);

			// 预处理每个工具：doom-loop 检测 + 审批（都走串行）
			interface PendingTool {
				tc:         typeof toolCalls[number];
				denied:     boolean;
				denyReason: string;
			}
			const pending: PendingTool[] = [];
			for (const tc of toolCalls) {
				console.log(`[Agent] 预处理工具: ${tc.name}`, JSON.stringify(tc.params).slice(0, 200));

				// #3 doom-loop 检测（Kilocode 版 ToolRepetitionDetector）
				const check = repetitionDetector.check({ name: tc.name as any, params: tc.params } as any);
				if (!check.allowExecution) {
					pending.push({
						tc, denied: true,
						denyReason: check.askUser?.messageDetail ?? '检测到重复调用，请切换策略',
					});
					continue;
				}

				// #8 per-tool + pattern 权限检查（读取 session-level 或 global allowAlways）
				// 实际前端控制 auto-approve，这里主要处理 "ask" 模式
				// streaming=false 表示工具参数已完整到达，前端可以展示真实参数了
				await server.sessionManager.emitEvent(sessionId, {
					type:       'tool_call_start',
					sessionId,
					toolName:   tc.name,
					toolUseId:  tc.id,
					toolParams: tc.params,
					streaming:  false,
				} as any);

				if (mode === 'ask' && DESTRUCTIVE_TOOLS.has(tc.name)) {
					console.log(`[Agent] ask 模式：等待用户审批 ${tc.name} (id=${tc.id})`);
					await server.sessionManager.emitEvent(sessionId, {
						type:       'tool_approval_request',
						sessionId,
						toolUseId:  tc.id,
						toolName:   tc.name,
						toolParams: tc.params,
					} as any);
					const { approved, feedback } = await server.sessionManager.registerApproval(sessionId, tc.id);
					if (!approved) {
						pending.push({
							tc, denied: true,
							denyReason: feedback ? `用户已拒绝并反馈：${feedback}` : '用户已拒绝此工具调用',
						});
						continue;
					}
					console.log(`[Agent] 用户批准 ${tc.name}`);
				}
				pending.push({ tc, denied: false, denyReason: '' });
			}

			// 执行函数
			const emitFileEvent = async (event: Record<string, unknown>) => {
				await server.sessionManager.emitEvent(sessionId, event as any);
			};
			const runOne = async (p: PendingTool): Promise<{ id: string; name: string; success: boolean; result: string }> => {
				const tc = p.tc;
				if (p.denied) {
					await server.sessionManager.emitEvent(sessionId, {
						type:      'tool_call_result',
						sessionId,
						toolUseId: tc.id,
						toolName:  tc.name,
						success:   false,
						result:    p.denyReason,
					});
					await server.sessionManager.appendToolMessage(sessionId, {
						toolName:    tc.name,
						toolUseId:   tc.id,
						toolParams:  tc.params,
						toolResult:  p.denyReason,
						toolSuccess: false,
					});
					return { id: tc.id, name: tc.name, success: false, result: p.denyReason };
				}

				// Plugin hook: tool.execute.before（可以取消调用）
				const allowed = await triggerPluginHook(loadedPlugins, 'tool.execute.before', {
					toolName: tc.name, params: tc.params, sessionId,
				});
				if (!allowed) {
					const denied = '[插件 hook 拒绝执行此工具]';
					await server.sessionManager.appendToolMessage(sessionId, {
						toolName: tc.name, toolUseId: tc.id, toolParams: tc.params,
						toolResult: denied, toolSuccess: false,
					});
					return { id: tc.id, name: tc.name, success: false, result: denied };
				}

				const result  = await executeToolCall(ctx, tc.name, tc.params, emitFileEvent, tc.id);
				const success = !result.startsWith('Error');

				// Plugin hook: tool.execute.after
				await triggerPluginHook(loadedPlugins, 'tool.execute.after', {
					toolName: tc.name, params: tc.params, result, success, sessionId,
				});
				// 记录错误签名用于 same-error-loop 检测
				repetitionDetector.recordToolResult(tc.name, tc.params, result);

				await server.sessionManager.emitEvent(sessionId, {
					type:      'tool_call_result',
					sessionId,
					toolUseId: tc.id,
					toolName:  tc.name,
					success,
					result,
				});
				// 持久化工具调用+结果（切换会话回来后能还原）
				await server.sessionManager.appendToolMessage(sessionId, {
					toolName:    tc.name,
					toolUseId:   tc.id,
					toolParams:  tc.params,
					toolResult:  result,
					toolSuccess: success,
				});
				return { id: tc.id, name: tc.name, success, result };
			};

			// 工具执行前再检查一次取消
			if (server.sessionManager.isCancelled(sessionId)) {
				console.log(`[Agent] 工具执行前检测到取消，跳过 ${toolCalls.length} 个工具`);
				break;
			}

			// 三层调度策略（对标 OpenCode 但更保守）：
			//   1. 只读工具 → 全部并行（read/grep/glob/ls/lsp/web_fetch/load_skill 等）
			//   2. 有 path 的破坏性工具（edit/write/multiedit/apply_patch）
			//      → 按 path 分组：不同文件并行，同文件串行
			//   3. 无 path 的破坏性工具（bash/execute_command）
			//      → 全局串行（命令可能有跨文件副作用，保守处理）
			type ToolResult = { id: string; name: string; success: boolean; result: string };
			const FILE_OP_TOOLS = new Set(['edit', 'write_to_file', 'multiedit', 'apply_patch']);

			const readOnlyPending: PendingTool[] = [];
			const fileOpByPath = new Map<string, PendingTool[]>();
			const globalSerialPending: PendingTool[] = [];

			for (const p of pending) {
				if (!DESTRUCTIVE_TOOLS.has(p.tc.name)) {
					readOnlyPending.push(p);
				} else if (FILE_OP_TOOLS.has(p.tc.name)) {
					const rawPath = (p.tc.params as any)?.path;
					if (typeof rawPath === 'string' && rawPath.length > 0) {
						const norm = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.workspacePath, rawPath);
						const arr = fileOpByPath.get(norm) ?? [];
						arr.push(p);
						fileOpByPath.set(norm, arr);
					} else {
						globalSerialPending.push(p);
					}
				} else {
					globalSerialPending.push(p);
				}
			}

			// 并行阶段：
			//   - 只读工具全部扁平并行
			//   - 每个 file path 下的多个破坏性工具组成一条串行 chain，chain 之间并行
			const parallelChains: Promise<ToolResult[]>[] = [];
			if (readOnlyPending.length > 0) {
				parallelChains.push(Promise.all(readOnlyPending.map(p => runOne(p))));
			}
			for (const fileOps of fileOpByPath.values()) {
				parallelChains.push((async () => {
					const acc: ToolResult[] = [];
					for (const p of fileOps) acc.push(await runOne(p));
					return acc;
				})());
			}
			const parallelResults: ToolResult[] = (await Promise.all(parallelChains)).flat();

			// 全局串行：bash / execute_command 最后跑（避免副作用交错）
			const serialResults: ToolResult[] = [];
			for (const p of globalSerialPending) {
				serialResults.push(await runOne(p));
			}

			// 按 toolCalls 原顺序聚合结果
			const resultById = new Map<string, { success: boolean; result: string }>();
			for (const r of parallelResults) resultById.set(r.id, { success: r.success, result: r.result });
			for (const r of serialResults)   resultById.set(r.id, { success: r.success, result: r.result });

			for (const tc of toolCalls) {
				const r = resultById.get(tc.id);
				if (!r) continue;
				toolResultBlocks.push({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     r.result,
				});
			}

			// ── 将工具结果追加到历史，继续下一轮 ──
			history.push({ role: 'user', content: toolResultBlocks });
		}

		// ── 推送日志（对标码弦 IDE /ai/call-log） ────────────────────────────────
		void pushAiCallLog({
			sessionId,
			uiMode,
			userContent,
			responseText: finalText || allText,
			inputTokens:  totalInputTokens,
			outputTokens: totalOutputTokens,
			toolCallsCount: totalToolCalls,
			durationMs: Date.now() - loopStartTime,
			status: 'success',
		});

		return finalText || allText;
	}

	// ─── 子 Agent 派发（task 工具）──────────────────────────────────────────
	(globalThis as any).__maxianSpawnSubAgent = async (opts: {
		parentSessionId?: string;
		workspacePath:    string;
		prompt:           string;
		/** explore/build/review 为内置；也支持 .maxian/agents/<name>.md 里定义的自定义 agent 名 */
		subagentType:     string;
		description?:     string;
	}): Promise<ITaskToolResult> => {
		try {
			const subId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const subHistory: MessageParam[] = [];
			// 检查是否匹配某个自定义 agent
			const customAgents = loadCustomAgents(opts.workspacePath);
			const custom = customAgents.find(a => a.name === opts.subagentType);
			let subMode = 'ask';
			let userContent = opts.prompt;
			if (custom) {
				// 自定义 agent：systemPrompt 以 user 消息前置（运行时 agent 继承）
				userContent = `${custom.systemPrompt}\n\n---\n\n# 任务\n\n${opts.prompt}`;
				subMode = 'code';
			} else {
				// 内置 subagent 类型映射到 mode，启用对应专用 prompt
				switch (opts.subagentType) {
					case 'build':
					case 'code':
						subMode = 'code';  break;
					case 'explore':
					case 'search':
					case 'research':
						subMode = 'explore'; break;  // 使用精简 explore prompt + 只读工具
					case 'plan':
						subMode = 'plan';   break;
					default:
						subMode = 'ask';    break;
				}
			}
			const output = await runAgentLoop(
				subId,
				userContent,
				subHistory,
				opts.workspacePath,
				subMode,
				'code',
			);
			return { output, success: true };
		} catch (e) {
			return { output: '', success: false, error: (e as Error).message };
		}
	};

	// ─── 注册消息处理器 ────────────────────────────────────────────────────────

	server.sessionManager.onSendMessage(async (sessionId, _messageId, sendOpts) => {
		// 懒加载 API 历史（首次发消息时从磁盘读取）
		if (!sessionHistories.has(sessionId)) {
			const persisted = await server.sessionManager.loadHistory(sessionId);
			sessionHistories.set(sessionId, persisted as MessageParam[]);
		}
		const history = sessionHistories.get(sessionId)!;

		// 获取会话的工作区路径、模式、UI模式
		const workspacePath =
			server.sessionManager.getWorkspacePath(sessionId) ?? process.cwd();
		const sessionMode   = server.sessionManager.getMode(sessionId);
		const sessionUiMode = server.sessionManager.getSession(sessionId)?.uiMode ?? 'code';

		// 处理 @ 文件引用：解析消息中的 @path/to/file 并附加文件内容
		let userContent = sendOpts.content;
		const atMatches = userContent.match(/@([\S]+)/g);
		if (atMatches && atMatches.length > 0) {
			const fileContextParts: string[] = [];
			for (const match of atMatches) {
				const filePath = match.slice(1); // 去掉 @
				const absolutePath = path.isAbsolute(filePath)
					? filePath
					: path.resolve(workspacePath, filePath);
				try {
					const fileContent = fs.readFileSync(absolutePath, 'utf8');
					const relPath = path.relative(workspacePath, absolutePath);
					fileContextParts.push(`\`\`\`${relPath}\n${fileContent.slice(0, 10000)}\n\`\`\``);
					console.log(`[Agent] @ 引用文件: ${relPath} (${fileContent.length}字)`);
				} catch { /* 文件不存在则忽略 */ }
			}
			if (fileContextParts.length > 0) {
				userContent = `${userContent}\n\n【附加文件上下文】\n${fileContextParts.join('\n\n')}`;
			}
		}

		// 处理图片附件（base64 → Anthropic multi-modal content block）
		let userMessageContent: string | unknown[] = userContent;
		if (sendOpts.images && sendOpts.images.length > 0) {
			const contentBlocks: unknown[] = [{ type: 'text', text: userContent }];
			for (const b64 of sendOpts.images) {
				// 检测图片类型（默认 jpeg）
				const mediaType = b64.startsWith('/9j/') ? 'image/jpeg'
					: b64.startsWith('iVBOR') ? 'image/png'
					: b64.startsWith('R0lGOD') ? 'image/gif'
					: 'image/jpeg';
				contentBlocks.push({
					type: 'image',
					source: { type: 'base64', media_type: mediaType, data: b64 },
				});
			}
			userMessageContent = contentBlocks;
		}

		// 追加用户消息到历史
		history.push({ role: 'user', content: userMessageContent as any });

		// 通知前端：任务开始处理
		await server.sessionManager.emitEvent(sessionId, {
			type: 'task_status', sessionId, status: 'processing',
		});

		const taskStartTime = Date.now();

		try {
			// runAgentLoop 内部已将所有助手/工具消息推入 history，返回最终文本
			const fullText = await runAgentLoop(
				sessionId,
				userContent,  // 处理了 @ 引用后的内容
				history,
				workspacePath,
				sessionMode,
				sessionUiMode,
			);

			if (fullText) {
				// 仅写入 UI 消息列表（history 已在 runAgentLoop 内更新）
				await server.sessionManager.appendAssistantMessage(sessionId, fullText);
			}

			// 持久化完整 API 历史（含工具调用 / 结果 / 多轮对话）
			await server.sessionManager.saveHistory(sessionId, history);

			await server.sessionManager.emitEvent(sessionId, {
				type: 'completion', sessionId, resultSummary: fullText,
			});
		} catch (err) {
			console.error('[Maxian CLI] Agent 处理失败:', err);
			await server.sessionManager.emitEvent(sessionId, {
				type: 'error', sessionId, message: String((err as Error)?.message ?? err),
			});
			void pushAiCallLog({
				sessionId,
				uiMode: sessionUiMode,
				userContent,
				responseText: '',
				inputTokens: 0,
				outputTokens: 0,
				toolCallsCount: 0,
				durationMs: Date.now() - taskStartTime,
				status: 'failed',
				errorMessage: String((err as Error)?.message ?? err),
			});
		} finally {
			server.sessionManager.updateStats(sessionId, { status: 'idle' });
			await server.sessionManager.emitEvent(sessionId, {
				type: 'task_status', sessionId, status: 'completed',
			});
		}
	});

	// ─── 输出就绪信号 ─────────────────────────────────────────────────────────

	const aiTag = aiConfig
		? (aiConfig.type === 'anthropic'
			? `Anthropic (${(aiConfig as any).model})`
			: `代理 ${(aiConfig as any).apiUrl}`)
		: '模拟模式';
	console.log(`[Maxian CLI] AI 就绪 (${aiTag})，Agent 循环已启用，支持工具调用`);
	console.log(`[Maxian CLI] 可用工具: ${AGENT_TOOL_DEFINITIONS.map(t => t.name).join(', ')} (共 ${AGENT_TOOL_DEFINITIONS.length} 个)`);

	const readyInfo = {
		url:      listener.url.toString(),
		port:     listener.port,
		hostname: listener.hostname,
	};
	console.log(`maxian server listening on ${readyInfo.url}`);
	console.log(`__MAXIAN_READY__ ${JSON.stringify(readyInfo)}`);

	// 优雅关闭：收到 SIGINT / SIGTERM 时：
	//   1. 停心跳
	//   2. 关 Hono HTTP listener（有 2 秒超时，否则 SSE 长连会一直挂住）
	//   3. process.exit(0)
	// 3 秒硬超时兜底：即便 step 2 卡住也强制退出，保证端口释放
	let shuttingDown = false;
	const gracefulShutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[Maxian Server] 收到 ${signal}，正在优雅关闭…`);
		try { stopHeartbeat(); } catch { /* ignore */ }

		// 3 秒硬超时：保证进程一定退出，释放端口
		const hardKill = setTimeout(() => {
			console.warn('[Maxian Server] 优雅关闭超时 3 秒，强制 exit');
			process.exit(0);
		}, 3000);
		hardKill.unref();

		try {
			// 2 秒内 listener 必须关闭；超时就直接进下一步（不等 SSE 连接）
			await Promise.race([
				listener.stop(false),   // false = 不等 in-flight 请求完成，直接 close 监听 socket
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 2000)),
			]);
			console.log('[Maxian Server] Hono listener 已关闭，端口已释放');
		} catch (e) {
			console.warn('[Maxian Server] listener 关闭超时或失败，将强制退出:', (e as Error).message);
		}

		// 尝试关数据库（可选，失败不阻塞退出）
		try {
			const { getDb } = await import('./database.js');
			getDb().close();
		} catch { /* ignore */ }

		clearTimeout(hardKill);
		process.exit(0);
	};

	process.on('SIGINT',  () => void gracefulShutdown('SIGINT'));
	process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

	// Windows 不支持 SIGTERM，但 CommandChild.kill() 会发 SIGBREAK 或直接结束进程
	// 补加一个 beforeExit 兜底，也能触发端口释放
	process.on('beforeExit', () => { if (!shuttingDown) void gracefulShutdown('beforeExit'); });
}

main().catch((err) => {
	console.error('[Maxian Server] Fatal:', err);
	process.exit(1);
});
