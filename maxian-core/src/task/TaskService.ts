/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Complete Task implementation based on Kilocode's Task class
// Full functionality: ask/say system, tool approval, error handling, attempt_completion

import { Emitter, Event } from '../types/cancellation.js';
import { Disposable } from '../types/lifecycle.js';
import * as path from 'node:path';
import { IApiHandler, MessageParam, ToolDefinition, ContentBlock, ToolResultContentBlock, StreamChunk } from '../api/types.js';
import { IToolExecutor, ToolExecutionResult } from '../tools/toolExecutor.js';
import { ToolName, toolNames as ALL_TOOL_NAMES } from '../types/toolTypes.js';
import { ToolRepetitionDetector } from '../tools/ToolRepetitionDetector.js';
import { formatResponse } from '../prompts/formatResponse.js';
import {
	TaskStatus,
	TokenUsage,
	ToolUsage,
	TaskMetadata,
	ClineMessage,
	CreateTaskOptions,
	ClineApiReqCancelReason,
	ClineAsk,
	ClineSay,
	ClineAskResponse,
	ToolProgressStatus
} from '../types/taskTypes.js';
import { AgentOrchestrator, TaskContext } from '../agents/index.js';
import { ToolResultCache } from '../tools/ToolResultCache.js';
import { ErrorHandler } from './ErrorHandler.js';
import {
	ContextCompactor,
	CompactableMessage,
	AISummaryCompactor,
	TieredCompactionManager,
} from '../context/contextCompaction.js';
import { FocusChainManager } from '../focusChain/FocusChainManager.js';
import { ModelContextTracker } from '../context-tracking/ModelContextTracker.js';
import { ContextManager } from '../context/ContextManager.js';
import { globalLspDiagnosticsHandler } from '../lsp/lspDiagnostics.js';
import { StateMutex } from '../utils/StateMutex.js';
import { CheckpointManager } from '../checkpoints/CheckpointManager.js';
import {
	ensureFollowupOptions,
	parseLegacyApprovalRequired,
	parseLegacyFollowupRequired,
	type ToolInteractionRequest
} from '../tools/toolExecutionProtocol.js';
import { estimateTokensFromChars } from '../utils/tokenEstimate.js';
import { safeParseToolArguments } from '../api/qwenHandler.js';

const MAX_CONSECUTIVE_MISTAKES = 5; // 最大连续错误次数

// ========== 上下文管理常量 ==========
// 对齐 Claude Code 真实源码（autoCompact.ts）：使用模型实际最大上下文窗口
// Claude claude-sonnet-4-6 / claude-opus-4-6 均支持 200K 输入 token
const MAX_CONTEXT_TOKENS = 1000000; // Qwen3-Plus 上下文窗 1M
const MAX_TOOL_RESULT_LENGTH = 20000; // 🚀 优化：对齐OpenCode标准（2000行/50KB），减少token消耗
const TRUNCATE_FRACTION = 0.5; // 截断时移除的消息比例

// E1优化：有效 context 窗口精确计算（对齐 Claude Code autoCompact.ts）
// effectiveWindow = modelContextWindow - maxOutputTokens（预留输出空间）
const MAX_OUTPUT_TOKENS = 32768; // 与 aiProxyHandler.ts requestBody.maxTokens 保持一致
const EFFECTIVE_CONTEXT_WINDOW = MAX_CONTEXT_TOKENS - Math.min(MAX_OUTPUT_TOKENS, 20000); // = 180000

// Qwen3-Plus 上下文治理：50% 主动压缩，80% 硬上限（blocking）。
// 之所以比 Claude Code 更激进，是因为 DashScope 的 Context Cache 命中需要稳定前缀 + 较多前缀空间，
// 早压缩可以为后续命中留出缓存空间。
const CONTEXT_AUTO_COMPACT_THRESHOLD = Math.floor(MAX_CONTEXT_TOKENS * 0.75); // 75%
const CONTEXT_WARNING_THRESHOLD      = Math.floor(MAX_CONTEXT_TOKENS * 0.6);  // 60%
const CONTEXT_BLOCKING_LIMIT         = Math.floor(MAX_CONTEXT_TOKENS * 0.9);  // 90% hard ceiling

/**
 * Agent 配置选项
 */
export interface AgentConfig {
	enableExploration: boolean;  // 是否启用探索阶段
	enablePlanning: boolean;     // 是否启用规划阶段
	autoExecute: boolean;        // 是否自动执行规划
	verbose: boolean;            // 是否输出详细日志
}

/**
 * 默认 Agent 配置
 */
const DEFAULT_AGENT_CONFIG: AgentConfig = {
	enableExploration: true,
	enablePlanning: true,
	autoExecute: true,
	verbose: true
};

interface DuplicateFileReadCheckResult {
	filePath: string;
	requestKey: string;
	message: string;
	isError: boolean;
	preferCachedContent?: boolean;
	activateRedirect?: boolean;
}

/**
 * TaskService配置选项
 */
export interface TaskServiceOptions extends CreateTaskOptions {
	apiHandler: IApiHandler;
	toolExecutor: IToolExecutor;
	getSystemPrompt: () => Promise<string>;  // 修改为异步
	getToolDefinitions: () => ToolDefinition[];
	initialMessageHistory?: MessageParam[];
	workspaceRoot?: string;
	consecutiveMistakeLimit?: number;
	currentMode?: string; // 当前模式，用于特殊处理（如ask模式）
	requireExplicitCompletionAfterToolUse?: boolean; // 工具执行后，禁止纯文本直接结束
	agentConfig?: Partial<AgentConfig>; // Agent 配置
	behaviorReporter?: import('../interfaces/IBehaviorReporter.js').IBehaviorReporter; // 行为埋点上报器
}

/**
 * TaskService - 完整实现参照Kilocode Task
 * 核心功能：
 * - 完整的ask/say消息系统
 * - 工具审批流程
 * - 递归API调用循环
 * - 工具执行与重复检测
 * - 错误处理与重试
 * - attempt_completion用户确认
 */
export class TaskService extends Disposable {
	// Events
	private readonly _onStatusChanged = this._register(new Emitter<TaskStatus>());
	readonly onStatusChanged: Event<TaskStatus> = this._onStatusChanged.event;

	private readonly _onMessageAdded = this._register(new Emitter<ClineMessage>());
	readonly onMessageAdded: Event<ClineMessage> = this._onMessageAdded.event;

	private readonly _onStreamChunk = this._register(new Emitter<{ text?: string; progressText?: string; reasoningText?: string; isPartial: boolean }>());
	readonly onStreamChunk: Event<{ text?: string; progressText?: string; reasoningText?: string; isPartial: boolean }> = this._onStreamChunk.event;

	private readonly _onTokenUsageUpdated = this._register(new Emitter<TokenUsage>());
	readonly onTokenUsageUpdated: Event<TokenUsage> = this._onTokenUsageUpdated.event;

	private readonly _onUserInputRequired = this._register(new Emitter<{
		question: string;
		toolUseId: string;
		options?: Array<{ label: string; description?: string; value?: string }>;
	}>());
	readonly onUserInputRequired: Event<{
		question: string;
		toolUseId: string;
		options?: Array<{ label: string; description?: string; value?: string }>;
	}> = this._onUserInputRequired.event;

	// 工具输入流式事件（用于实时显示工具调用信息）
	private readonly _onToolInputStreaming = this._register(new Emitter<{
		toolId: string;
		toolName: string;
		input: any;
		isPartial: boolean;
	}>());
	readonly onToolInputStreaming = this._onToolInputStreaming.event;

	// 工具完成事件（用于更新工具执行状态）
	private readonly _onToolCompleted = this._register(new Emitter<{
		toolId: string;
		toolName: string;
		isError: boolean;
	}>());
	readonly onToolCompleted = this._onToolCompleted.event;

	// P0-2: 流式响应中断事件（网络断开/超时，流被截断）
	private readonly _onStreamInterrupted = this._register(new Emitter<{
		partialText: string;
		hasPartialToolCalls: boolean;
		reason: string;
	}>());
	readonly onStreamInterrupted = this._onStreamInterrupted.event;

	// Task metadata
	readonly taskId: string;
	readonly metadata: TaskMetadata;

	// Status
	private _status: TaskStatus = TaskStatus.IDLE;
	abort: boolean = false;
	abortReason?: ClineApiReqCancelReason;

	// Ask/Say response handling - 参照kilocode
	private askResponse?: ClineAskResponse;
	private askResponseText?: string;
	private askResponseImages?: string[];
	private lastMessageTs?: number;
	private askResolve?: () => void; // Promise-based wait for ask response

	// API & Tools
	private readonly apiHandler: IApiHandler;
	private readonly toolExecutor: IToolExecutor;
	private readonly getSystemPrompt: () => Promise<string>;  // 修改为异步
	private readonly getToolDefinitions: () => ToolDefinition[];

	// Tool repetition detection
	private readonly toolRepetitionDetector: ToolRepetitionDetector;
	consecutiveMistakeCount: number = 0;
	private readonly consecutiveMistakeLimit: number;

	// Current mode (for special handling like ask mode)
	private readonly currentMode: string;
	private readonly requireExplicitCompletionAfterToolUse: boolean;

	// Agent 编排器
	private readonly agentOrchestrator: AgentOrchestrator;
	private readonly agentConfig: AgentConfig;
	private readonly workspaceRoot: string;
	private taskContext?: TaskContext;

	// 工具结果缓存
	private readonly toolCache: ToolResultCache;

	// 错误处理器
	private readonly errorHandler: ErrorHandler;

	// P0优化：重复文件读取检测
	private readonly fileReadTracker: Map<string, number> = new Map();
	private readonly readFileRequestTracker: Map<string, number> = new Map();
	private readonly duplicateReadRedirectTracker: Set<string> = new Set();
	// 压缩保护：本任务内通过 write_to_file / edit / multiedit / apply_diff 成功修改过的文件
	// 在上下文压缩时需要显式注入到摘要/提醒中，避免模型"忘记"刚改过什么而重复修改同一处
	private readonly recentlyModifiedFiles: Set<string> = new Set();
	// 压缩保护：记录最近 1 条 tool_result error 的摘要，压缩后注入提醒
	private lastToolErrorMessage: string | null = null;
	private readonly runtimeGuidanceKeys: Set<string> = new Set();
	private readonly explorationFingerprintsSeen: Set<string> = new Set();
	private consecutiveNoProgressExplorationRounds = 0;
	private readonly NO_PROGRESS_EXPLORATION_THRESHOLD = 3;
	private readonly EXPLORATION_REDIRECT_ROUNDS = 2;
	private readonly EXPLORATION_REDIRECT_MIN_FILES = 2;
	private readonly MAIN_THREAD_SEARCH_TOOLS = new Set(['search_files', 'codebase_search', 'glob', 'list_files']);
	private mainThreadExplorationGuardActive = false;
	private readonly explorationBudget = {
		minFilesBeforeDelegation: 3,
		minReadOnlyRoundsBeforeDelegation: 2,
		maxMainThreadSearchBursts: 6,
	};
	private mainThreadSearchBurstCount = 0;
	private readonly verboseRuntimeLogs = false;

	// P0优化：上下文压缩器
	private readonly contextCompactor: ContextCompactor;

	// AI摘要压缩器
	private readonly aiSummaryCompactor: AISummaryCompactor;

	// 分层压缩管理器
	private readonly tieredCompactionManager: TieredCompactionManager;

	// P0优化：FocusChain 任务进度管理器
	private readonly focusChainManager: FocusChainManager;

	// P2优化：完整的上下文管理系统（E1优化后主要用于 trackTokenUsage 统计）
	// @ts-ignore - E1优化后 truncateHistoryIfNeeded 改用增量计数器，保留用于未来扩展
	private readonly modelContextTracker: ModelContextTracker;
	// @ts-ignore - TODO: 待完整集成
	private readonly _fullContextManager: ContextManager;
	private readonly stateMutex: StateMutex;
	private readonly checkpointManager: CheckpointManager;

	// Message history
	private apiConversationHistory: MessageParam[] = [];
	clineMessages: ClineMessage[] = [];
	/** 增量 token 估算计数器（A7 优化：O(1) 代替 O(n) 扫描） */
	private _estimatedTotalChars = 0;

	// 文件变更追踪
	private readonly fileChangesWritten: Set<string> = new Set();  // 写入/创建/修改的文件
	private readonly fileChangesDeleted: Set<string> = new Set();  // 删除的文件
	private readonly fileWriteCountTracker: Map<string, number> = new Map();
	private readonly fileWriteAttemptCountTracker: Map<string, number> = new Map();
	private readonly fileNoProgressWriteTracker: Map<string, { signature: string; count: number; tool: string; updatedAt: number }> = new Map();
	private totalWriteToolAttemptCount = 0;
	private static readonly MAX_WRITES_PER_FILE = 6;
	private static readonly SAME_SIGNATURE_GUIDANCE_AFTER = 1;
	private static readonly SAME_SIGNATURE_BLOCK_AFTER = 2;
	private static readonly MAX_WRITE_ATTEMPTS_PER_FILE = 4;
	private static readonly HARD_WRITE_ATTEMPT_BLOCK_AFTER = 6;
	private static readonly MAX_TOTAL_WRITE_ATTEMPTS = 20;
	private static readonly NO_PROGRESS_WRITE_TRACKER_TTL_MS = 3 * 60 * 1000;

	// 效率优化：连续只读轮数计数器（包括batch只读），仅用于观测是否长时间停留在探索阶段
	private consecutiveReadOnlyRounds = 0;

	// 全局 API 轮次计数器：recursivelyMakeClineRequests 每次递归调用 +1，超过上限强制终止
	private totalApiRounds = 0;
	// manifest hash：只在文件清单变化时追加，避免每轮重复
	private _lastManifestKey = '';
	private static readonly MAX_TOTAL_API_ROUNDS = 80; // 超过80轮 API 调用，强制询问用户

	// 功能2: Debug 自动测试循环计数器
	private _debugTestRetryCount = 0;
	private static readonly MAX_DEBUG_TEST_RETRIES = 3; // 最多循环3次

	// E2优化：MaxOutputTokens 自动升级恢复计数器
	private _outputLimitHits = 0;
	private static readonly MAX_OUTPUT_LIMIT_HITS = 3; // 连续命中3次后告知用户

	// D7: 后台工具摘要 Promise（在 API 流式期间异步执行轻量压缩）
	private _pendingBackgroundCompact: Promise<void> | null = null;

	// Token & Tool usage
	private tokenUsage: TokenUsage = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCost: 0,
		contextTokens: 0
	};
	toolUsage: ToolUsage = {};

	// 步骤追踪
	private currentStepIndex: number = 0;
	private totalSteps: number = 0;
	private currentStepDescription: string = '';

	// 行为埋点上报器（由 maxianService 注入）
	private behaviorReporter?: import('../interfaces/IBehaviorReporter.js').IBehaviorReporter;

	// AI 调用计时（用于 AI_CALL 延迟统计）
	private _aiCallStartTime: number = 0;

	// P0-2: 流式响应检查点（用于流中断时保存已接收的部分数据）
	private _streamCheckpoint: {
		partialText: string;
		partialToolUses: Array<{ id: string; name: string; input: any }>;
		startedAt: number;
	} | null = null;

	// 步骤更新事件
	private readonly _onStepUpdated = this._register(new Emitter<{
		current: number;
		total: number;
		description: string;
		status: 'running' | 'completed' | 'error';
	}>());
	readonly onStepUpdated = this._onStepUpdated.event;

	// 任务列表更新事件（todowrite工具触发）
	private readonly _onTodoListUpdated = this._register(new Emitter<{
		todos: Array<{
			content: string;
			status: 'pending' | 'in_progress' | 'completed';
			activeForm: string;
		}>;
	}>());
	readonly onTodoListUpdated = this._onTodoListUpdated.event;

	constructor(options: TaskServiceOptions) {
		super();

		this.taskId = this.generateTaskId();
		this.apiHandler = options.apiHandler;
		this.toolExecutor = options.toolExecutor;
		this.getSystemPrompt = options.getSystemPrompt;
		this.getToolDefinitions = options.getToolDefinitions;
		this.consecutiveMistakeLimit = options.consecutiveMistakeLimit || MAX_CONSECUTIVE_MISTAKES;
		this.currentMode = options.currentMode || 'code';
		this.requireExplicitCompletionAfterToolUse = options.requireExplicitCompletionAfterToolUse ?? true;
		this.workspaceRoot = options.workspaceRoot || '.';
		this.behaviorReporter = options.behaviorReporter;

		// 初始化 Agent 配置
		this.agentConfig = { ...DEFAULT_AGENT_CONFIG, ...options.agentConfig };

		// 初始化工具重复检测器
		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit, this.workspaceRoot);

		// 初始化工具结果缓存
		this.toolCache = new ToolResultCache();

		// 初始化错误处理器
		this.errorHandler = new ErrorHandler({
			maxRetries: 3,
			baseDelayMs: 1000,
			maxDelayMs: 60000,
			jitterFactor: 0.2
		});

		// P0优化：初始化上下文压缩器
		this.contextCompactor = new ContextCompactor(MAX_CONTEXT_TOKENS);
		this.aiSummaryCompactor = new AISummaryCompactor();
		this.tieredCompactionManager = new TieredCompactionManager();

		// P0优化：初始化 FocusChain 任务进度管理器
		this.focusChainManager = new FocusChainManager();
		if (options.task) {
			this.focusChainManager.setTaskDescription(options.task);
		}

		// P2优化：初始化完整的上下文管理系统
		this.modelContextTracker = new ModelContextTracker(MAX_CONTEXT_TOKENS);
		this._fullContextManager = new ContextManager();  // TODO: 待完整集成
		this.stateMutex = new StateMutex();
		this.checkpointManager = new CheckpointManager();
		// 初始化 Agent 编排器
		this.agentOrchestrator = new AgentOrchestrator(
			this.toolExecutor,
			this.workspaceRoot,
			{
				enableExploration: this.agentConfig.enableExploration,
				enablePlanning: this.agentConfig.enablePlanning,
				autoExecute: this.agentConfig.autoExecute,
				verbose: this.agentConfig.verbose
			},
			{
				onPhaseChange: (_phase, _context) => {},
				onExplorationComplete: (_result) => {},
				onPlanningComplete: (_result) => {}
			}
		);

		this.metadata = {
			taskId: this.taskId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: TaskStatus.IDLE
		};

		// 注入初始历史（用于跨轮次新建 Task 时保留会话记忆）
		if (options.initialMessageHistory && options.initialMessageHistory.length > 0) {
			for (const historyMsg of options.initialMessageHistory) {
				this.pushHistory(this.cloneHistoryMessage(historyMsg));
			}
		}

		// 如果提供了初始任务，添加到历史（支持图片）
		if (options.task) {
			if (options.images && options.images.length > 0) {
				const contentBlocks: import('../api/types.js').ContentBlock[] = [
					{ type: 'text', text: options.task }
				];
				for (const imgBase64 of options.images) {
					let media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png';
					if (imgBase64.startsWith('/9j/')) media_type = 'image/jpeg';
					else if (imgBase64.startsWith('R0lGOD')) media_type = 'image/gif';
					else if (imgBase64.startsWith('UklGR')) media_type = 'image/webp';
					contentBlocks.push({
						type: 'image',
						source: { type: 'base64', data: imgBase64, media_type }
					} as import('../api/types.js').ImageContentBlock);
				}
				this.pushHistory({ role: 'user', content: contentBlocks as any });
			} else {
				this.pushHistory({
					role: 'user',
					content: options.task
				});
			}
		}
	}

	private debugLog(...args: any[]): void {
		if (!this.verboseRuntimeLogs) {
			return;
		}
		console.log(...args);
	}

	private emitToolTraceCall(
		toolUse: { id: string; name: string; input: any },
		source: 'top' | 'batch' = 'top'
	): void {
		this.emitToolTrace('call', {
			round: this.totalApiRounds,
			source,
			toolId: toolUse.id,
			tool: toolUse.name,
			input: this.summarizeForToolTrace(toolUse.input)
		});
	}

	private emitToolTraceResult(
		toolUseId: string,
		toolName: string,
		content: unknown,
		isError: boolean,
		source: 'top' | 'batch' = 'top'
	): void {
		const text = typeof content === 'string' ? content : JSON.stringify(content);
		this.emitToolTrace('result', {
			round: this.totalApiRounds,
			source,
			toolId: toolUseId,
			tool: toolName,
			isError,
			contentLength: text.length,
			contentPreview: text.length > 2000 ? `${text.slice(0, 2000)}...` : text
		});
	}

	private emitToolTrace(event: 'call' | 'result', payload: Record<string, unknown>): void {
		try {
			globalThis.console.log('[ToolTrace]', JSON.stringify({
				event,
				timestamp: new Date().toISOString(),
				...payload
			}));
		} catch {
			// ignore trace logging failures
		}
	}

	private summarizeForToolTrace(value: unknown): unknown {
		try {
			const serialized = JSON.stringify(value);
			if (!serialized) {
				return value;
			}
			if (serialized.length <= 2000) {
				return value;
			}
			return {
				truncated: true,
				originalLength: serialized.length,
				preview: serialized.slice(0, 2000) + '...'
			};
		} catch {
			return String(value);
		}
	}

	/**
	 * 复用同一 task_id 时重置运行期瞬时状态，避免跨轮污染。
	 * 保留对话历史与已写文件追踪，便于子任务继续上下文。
	 */
	public prepareForResumeRun(): void {
		this.abort = false;
		this.abortReason = undefined;
		this.askResolve = undefined;
		this.askResponse = undefined;
		this.askResponseText = undefined;
		this.askResponseImages = undefined;
		this.consecutiveMistakeCount = 0;
		this.mainThreadExplorationGuardActive = false;
		this.mainThreadSearchBurstCount = 0;
		this.runtimeGuidanceKeys.clear();
		this.resetExplorationProgress();
		// 重置工具使用计数，避免上一轮 hasUsedTools=true 触发"必须 attempt_completion"死循环
		this.toolUsage = {};
		// 重置全局 API 轮次计数，避免第二条消息继承第一条的轮次导致提前触发轮次上限
		this.totalApiRounds = 0;
		this._outputLimitHits = 0;
	}

	/**
	 * 生成任务ID
	 */
	private generateTaskId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * 生成消息时间戳 - 单调递增，避免忙等待
	 */
	private nextClineMessageTimestamp(): number {
		return Math.max(Date.now(), (this.clineMessages[this.clineMessages.length - 1]?.ts ?? 0) + 1);
	}

	/**
	 * 获取当前状态
	 */
	get status(): TaskStatus {
		return this._status;
	}

	/**
	 * 设置状态
	 */
	private setStatus(status: TaskStatus): void {
		if (this._status !== status) {
			this._status = status;
			this.metadata.status = status;
			this.metadata.updatedAt = Date.now();
			this._onStatusChanged.fire(status);
		}
	}

	// ========== Ask/Say消息系统 - 参照kilocode完整实现 ==========

	/**
	 * Ask - 向用户询问并等待响应
	 * 参照kilocode的ask方法完整实现
	 */
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		extra?: Partial<ClineMessage>
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		if (this.abort) {
			throw new Error(`[TaskService#ask] task ${this.taskId} aborted`);
		}

		let askTs: number;

		if (partial !== undefined) {
			const lastMessage = this.clineMessages[this.clineMessages.length - 1];

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === 'ask' && lastMessage.ask === type;

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// 更新现有的partial消息
					lastMessage.text = text;
					lastMessage.partial = partial;
					lastMessage.progressStatus = progressStatus;
					this._onMessageAdded.fire(lastMessage);
					throw new Error('Current ask promise was ignored (#1)');
				} else {
					// 新的partial消息
					askTs = this.nextClineMessageTimestamp();
					this.lastMessageTs = askTs;
					const message: ClineMessage = { ts: askTs, type: 'ask', ask: type, text, partial, ...(extra || {}) };
					this.clineMessages.push(message);
					this._onMessageAdded.fire(message);
					throw new Error('Current ask promise was ignored (#2)');
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// 完成之前的partial消息
					this.askResponse = undefined;
					this.askResponseText = undefined;
					this.askResponseImages = undefined;

					askTs = lastMessage.ts;
					this.lastMessageTs = askTs;
					lastMessage.text = text;
					lastMessage.partial = false;
					lastMessage.progressStatus = progressStatus;
					this._onMessageAdded.fire(lastMessage);
				} else {
					// 新的完整消息
					this.askResponse = undefined;
					this.askResponseText = undefined;
					this.askResponseImages = undefined;
					askTs = this.nextClineMessageTimestamp();
					this.lastMessageTs = askTs;
					const message: ClineMessage = { ts: askTs, type: 'ask', ask: type, text, ...(extra || {}) };
					this.clineMessages.push(message);
					this._onMessageAdded.fire(message);
				}
			}
		} else {
			// 新的非partial消息
			this.askResponse = undefined;
			this.askResponseText = undefined;
			this.askResponseImages = undefined;
			askTs = this.nextClineMessageTimestamp();
			this.lastMessageTs = askTs;
			const message: ClineMessage = { ts: askTs, type: 'ask', ask: type, text, ...(extra || {}) };
			this.clineMessages.push(message);
			this._onMessageAdded.fire(message);
		}

		// 等待用户响应
		await this.waitForAskResponse(askTs);

		const result = {
			response: this.askResponse!,
			text: this.askResponseText,
			images: this.askResponseImages
		};

		// 清空响应
		this.askResponse = undefined;
		this.askResponseText = undefined;
		this.askResponseImages = undefined;

		return result;
	}

	/**
	 * 等待ask响应（Promise-based，无忙轮询）
	 */
	private async waitForAskResponse(askTs: number): Promise<void> {
		if (this.abort) {
			throw new Error(`[TaskService] task ${this.taskId} aborted while waiting for ask response`);
		}
		// 已有响应则直接返回
		if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			this.askResolve = resolve;
			// 用 abort 检测作为兜底：每500ms检查一次abort标志，避免永久阻塞
			const abortCheck = setInterval(() => {
				if (this.abort) {
					clearInterval(abortCheck);
					this.askResolve = undefined;
					reject(new Error(`[TaskService] task ${this.taskId} aborted while waiting for ask response`));
				} else if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
					clearInterval(abortCheck);
					this.askResolve = undefined;
					resolve();
				}
			}, 500);
		});
	}

	/**
	 * 处理webview的ask响应 - 由MaxianService调用
	 */
	public handleWebviewAskResponse(askTs: number, response: ClineAskResponse, text?: string, images?: string[]): void {
		// 验证askTs是否匹配当前等待的ask
		if (this.lastMessageTs !== askTs) {
			console.warn(`[TaskService] Ask响应时间戳不匹配: 期望 ${this.lastMessageTs}, 收到 ${askTs}`);
			return;
		}

		this.askResponse = response;
		this.askResponseText = text;
		this.askResponseImages = images;
		// 唤醒 waitForAskResponse 中的 Promise
		this.askResolve?.();
		this.askResolve = undefined;
	}

	/**
	 * 恢复任务并添加用户输入 - 由MaxianService调用
	 * 用于submitUserResponse的实现
	 */
	public resumeWithUserInput(userMessage: string): void {
		// 添加用户消息到历史
		this.addUserMessage(userMessage);

		// 如果正在等待ask响应,将其设置为messageResponse
		if (this.lastMessageTs !== undefined) {
			this.askResponse = 'messageResponse';
			this.askResponseText = userMessage;
			this.askResponseImages = undefined;
			// 唤醒 waitForAskResponse 中的 Promise
			this.askResolve?.();
			this.askResolve = undefined;
		}
	}

	/**
	 * Say - 向用户发送消息
	 * 参照kilocode的say方法完整实现
	 */
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		progressStatus?: ToolProgressStatus
	): Promise<void> {
		if (this.abort) {
			throw new Error(`[TaskService#say] task ${this.taskId} aborted`);
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages[this.clineMessages.length - 1];

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === 'say' && lastMessage.say === type;

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// 更新现有的partial消息
					lastMessage.text = text;
					lastMessage.images = images;
					lastMessage.partial = partial;
					lastMessage.progressStatus = progressStatus;
					this._onMessageAdded.fire(lastMessage);
				} else {
					// 新的partial消息
					const sayTs = this.nextClineMessageTimestamp();
					this.lastMessageTs = sayTs;
					const message: ClineMessage = { ts: sayTs, type: 'say', say: type, text, images, partial };
					this.clineMessages.push(message);
					this._onMessageAdded.fire(message);
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// 完成之前的partial消息
					this.lastMessageTs = lastMessage.ts;
					lastMessage.text = text;
					lastMessage.images = images;
					lastMessage.partial = false;
					lastMessage.progressStatus = progressStatus;
					this._onMessageAdded.fire(lastMessage);
				} else {
					// 新的完整消息
					const sayTs = this.nextClineMessageTimestamp();
					this.lastMessageTs = sayTs;
					const message: ClineMessage = { ts: sayTs, type: 'say', say: type, text, images };
					this.clineMessages.push(message);
					this._onMessageAdded.fire(message);
				}
			}
		} else {
			// 新的非partial消息
			const sayTs = this.nextClineMessageTimestamp();
			this.lastMessageTs = sayTs;
			const message: ClineMessage = { ts: sayTs, type: 'say', say: type, text, images };
			this.clineMessages.push(message);
			this._onMessageAdded.fire(message);
		}
	}

	/**
	 * 缺少参数错误并say
	 */
	async sayAndCreateMissingParamError(toolName: string, paramName: string): Promise<string> {
		await this.say('error', `AI尝试使用 ${toolName} 但缺少必需参数 '${paramName}'。正在重试...`);
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName));
	}

	// ========== 任务主循环 ==========

	/**
	 * 添加用户消息
	 * 如果提供了 images（base64 字符串数组），会构建多模态内容块传给 AI
	 */
	public addUserMessage(message: string, images?: string[]): void {
		if (images && images.length > 0) {
			// 多模态消息：文本 + 图片
			const contentBlocks: import('../api/types.js').ContentBlock[] = [
				{ type: 'text', text: message }
			];
			for (const imgBase64 of images) {
				// 检测 MIME 类型（PNG/JPEG/GIF/WebP）
				let media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png';
				if (imgBase64.startsWith('/9j/')) media_type = 'image/jpeg';
				else if (imgBase64.startsWith('R0lGOD')) media_type = 'image/gif';
				else if (imgBase64.startsWith('UklGR')) media_type = 'image/webp';

				contentBlocks.push({
					type: 'image',
					source: {
						type: 'base64',
						data: imgBase64,
						media_type
					}
				} as import('../api/types.js').ImageContentBlock);
			}
			this.pushHistory({ role: 'user', content: contentBlocks as any });
		} else {
			this.pushHistory({ role: 'user', content: message });
		}

		// 不使用say，直接添加以避免异步问题
		const ts = Date.now();
		const clineMessage: ClineMessage = {
			ts,
			type: 'say',
			say: 'user_feedback',
			text: message,
			images
		};
		this.clineMessages.push(clineMessage);
		this._onMessageAdded.fire(clineMessage);
	}

	/**
	 * 开始任务执行
	 */
	public async start(): Promise<void> {
		if (this.abort) {
			return;
		}

		// 每轮启动前重置本轮文件变更统计（会话上下文保留，但变更摘要按轮次输出）
		this.fileChangesWritten.clear();
		this.fileChangesDeleted.clear();
		this.fileWriteCountTracker.clear();
		this.fileWriteAttemptCountTracker.clear();
		this.fileNoProgressWriteTracker.clear();
		this.totalWriteToolAttemptCount = 0;

		this.setStatus(TaskStatus.PROCESSING);

		// 埋点：任务开始
		this.behaviorReporter?.reportTaskStart(this.taskId);

		// 🎯 参考OpenCode设计：简化流程，移除强制explore-planning阶段
		// AI通过task tool自主决定何时需要探索代码库
		this.setTotalSteps(3); // 简化流程：分析 -> 执行 -> 完成
		this.updateStep('正在分析任务...');

		try {
			// 执行主任务循环
			this.updateStep('正在执行任务...');
			await this.initiateTaskLoop();

			// 任务完成
			this.updateStep('任务已完成', 'completed');
			this.setStatus(TaskStatus.COMPLETED);
			// 埋点：任务成功结束
			this.behaviorReporter?.reportTaskEnd(this.taskId, 'success');
		} catch (error) {
			console.error('[TaskService] 任务执行错误:', error);
			this.updateStep('任务执行出错', 'error');
			this.setStatus(TaskStatus.ERROR);
			// 埋点：任务失败
			this.behaviorReporter?.reportTaskEnd(this.taskId, 'failed');
		}
	}

	/**
	 * 任务主循环 - 参照kilocode
	 */
	private async initiateTaskLoop(): Promise<void> {
		globalLspDiagnosticsHandler.clearDiagnosticHistory();
		let noProgressRounds = 0;
		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests();

			if (didEndLoop) {
				break;
			}

			noProgressRounds++;
			if (noProgressRounds <= 3) {
				// 放宽到 3 轮：模型可能在分析文件内容后决定下一步，不需要被提前打断
				if (noProgressRounds === 3) {
					this.pushHistory({
						role: 'user',
						content: '[SYSTEM] 连续 3 轮无工具调用。请立即调用工具推进或 attempt_completion。'
					});
				}
				continue;
			}

			// 连续两轮无推进，停止自动循环，等待用户下一步指令
			break;
		}
	}

	/**
	 * A3: 检测 413/prompt_too_long 错误（用于 E3 ReactiveCompact）
	 */
	private isPromptTooLongError(error: unknown): boolean {
		const msg = error instanceof Error ? error.message : String(error);
		const lower = msg.toLowerCase();
		return lower.includes('413') ||
			lower.includes('prompt_too_long') ||
			lower.includes('prompt too long') ||
			lower.includes('context length exceeded') ||
			lower.includes('context_length_exceeded') ||
			lower.includes('maximum context') ||
			lower.includes('tokens exceed') ||
			lower.includes('token limit');
	}

	/**
	 * A3: 迭代主循环（替代原尾递归实现）
	 * 消除 50-100 层 async 调用栈积压，避免长任务内存溢出风险
	 *
	 * E3: ReactiveCompact 集成
	 * API 返回 413/prompt_too_long 时自动强制压缩后重试，无需用户介入
	 */
	private async recursivelyMakeClineRequests(initialRetryAttempt: number = 0): Promise<boolean> {
		let retryAttempt = initialRetryAttempt;

		while (true) {  // A3: while 迭代替代尾递归
			if (this.abort) {
				return true;
			}

			// 全局轮次上限：防止 AI 无限循环（无论读写，每轮 API 调用都计数）
			this.totalApiRounds++;
			const isLastRound = this.totalApiRounds >= TaskService.MAX_TOTAL_API_ROUNDS;

			// 接近上限时（最后10轮）提前注入警告，让 AI 尽快收尾
			if (this.totalApiRounds === TaskService.MAX_TOTAL_API_ROUNDS - 10) {
				this.pushHistory({
					role: 'user',
					content: `[SYSTEM] ⚠️ 你已进行了 ${this.totalApiRounds} 轮操作，距离最大轮次（${TaskService.MAX_TOTAL_API_ROUNDS}）还剩 10 轮。请尽快完成任务：\n- 如已完成：立即调用 attempt_completion\n- 如未完成：优先处理最关键的剩余工作，完成后调用 attempt_completion 并说明哪些工作尚未完成`
				});
			}

			if (isLastRound) {
				console.warn(`[TaskService] 已达到全局 API 轮次上限 ${TaskService.MAX_TOTAL_API_ROUNDS}`);
				// 参照 OpenCode：注入 assistant 消息告知 AI 已达上限，强迫它输出文字总结而非继续调用工具
				this.pushHistory({
					role: 'assistant' as const,
					content: `[已达到最大操作步数 ${TaskService.MAX_TOTAL_API_ROUNDS}，工具调用已禁用]\n\n我需要停止工具调用，总结当前进展：`
				});
				// 继续本轮 API 调用——模型看到"自己说停了"，会输出文字总结，不再调用工具
			}

			try {
				// 调用API
				const stream = await this.attemptApiRequest(retryAttempt);

				// 处理流式响应
				const { assistantMessage, toolUses, hasError, stopReason } = await this.processApiStream(stream);

				if (hasError) {
					return true;
				}

				// E2优化：检测 max_output_tokens 命中，自动发送续写提示
				if (stopReason === 'length') {
					this._outputLimitHits++;
					console.warn(`[TaskService] E2: 命中输出 token 上限 (第 ${this._outputLimitHits} 次)`);

					if (this._outputLimitHits <= TaskService.MAX_OUTPUT_LIMIT_HITS) {
						// 添加已有的助手响应（截断的部分）
						if (assistantMessage || toolUses.length > 0) {
							await this.addAssistantResponse(assistantMessage, toolUses);
						}
						// 注入续写提示，让模型从中断处继续
						this.pushHistory({
							role: 'user',
							content: 'Output token limit hit. Continue directly from where you left off without any commentary, preamble, or explanation of what you are doing.',
						});
						console.log(`[TaskService] E2: 注入续写提示，继续第 ${this._outputLimitHits} 次恢复`);
						retryAttempt = 0;
						continue;  // A3: 迭代替代递归
					} else {
						// 超过最大恢复次数，告知用户
						await this.say('text', `[E2] 输出 token 已连续 ${TaskService.MAX_OUTPUT_LIMIT_HITS} 次达到上限，请尝试拆分任务为更小的步骤。`);
						this._outputLimitHits = 0;
						return true;
					}
				}

				// 输出正常（未截断），重置计数器
				if (this._outputLimitHits > 0) {
					this._outputLimitHits = 0;
				}

				// 添加助手响应到历史
				if (assistantMessage || toolUses.length > 0) {
					await this.addAssistantResponse(assistantMessage, toolUses);
				} else {
					// API 返回了完全空的响应（无文本、无工具调用）
					// 必须插入一条占位 assistant 消息，否则连续 user 消息会导致 OpenAI API 报错
					console.warn('[TaskService] API 返回空响应，插入占位 assistant 消息');
					this.pushHistory({
						role: 'assistant',
						content: ''
					});
				}

				// 没有工具调用 - 这是AI的最终回复，显示给用户
				if (toolUses.length === 0) {
					if (assistantMessage) {
						const trimmedMessage = assistantMessage.trim();
						const hasUsedTools = Object.values(this.toolUsage).some(count => (count || 0) > 0);
						const shouldRequireExplicitCompletion = this.requireExplicitCompletionAfterToolUse && hasUsedTools;

						// Solo 模式：纯文本回复也可以结束任务，不强制 attempt_completion
						if (this.currentMode === 'solo' && trimmedMessage.length > 0) {
							await this.say('text', assistantMessage);
							console.log('[TaskService][Solo] 纯文本回复，直接结束任务');
							return true;
						}

						if (shouldRequireExplicitCompletion && trimmedMessage.length > 0) {
							console.warn('[TaskService] 工具执行后收到纯文本回复，不视为完成，要求显式调用 attempt_completion');
							this.pushHistory({
								role: 'user',
								content: '[SYSTEM] 你刚刚在使用过工具后直接输出了文本，但这不会结束当前任务。若任务已完成，必须立即调用 attempt_completion，并用简洁结果摘要说明完成内容；若未完成，请继续使用必要工具。不要重复复述，不要重复派发相同的 task(explore)。'
							});
							continue;
						}

						if (hasUsedTools && this.isLikelyInternalMetaResponse(trimmedMessage)) {
							console.warn('[TaskService] 工具执行后收到策略性/内部性文本，不视为完成，继续推进任务');
							this.pushHistory({
								role: 'user',
								content: '[SYSTEM] 你刚刚输出的内容更像策略说明、内部纠偏提示或等待状态，而不是对用户的最终结果。不要结束任务，也不要把这种内部说明直接回复给用户。请基于当前已有结果继续推进：如果目标文件已明确，就继续修改或验证；如果只是需要补充少量依据，只读取明确文件；只有真正完成后，再给出面向用户的最终结果。'
							});
							continue;
						}

						// 显示AI的最终回复（不是工具调用前的"思考"文本）
						await this.say('text', assistantMessage);
						if (trimmedMessage.length > 0) {
							console.log('[TaskService] AI输出了最终文本回答（无工具调用），直接结束任务');
							return true;
						}
					}
					return false;
				}
				// 有工具调用时，assistantMessage 是AI的"思考"文本，不显示给用户

				// 执行工具
				const { shouldContinue, shouldEndLoop } = await this.executeTools(toolUses);

				// 混合模型调度：根据本轮工具类型决定下一轮用 flash（探索）还是 plus（生成）
				this.updateModelTierForNextRound(toolUses);

				if (shouldEndLoop) {
					return true;
				}

				if (!shouldContinue) {
					return true;
				}

				// D7: 工具执行完成后，后台启动轻量压缩（不 await，与下轮 API 请求并行）
				// 下轮循环开始时（truncateHistoryIfNeeded 之前）会 await 确保完成
				this._pendingBackgroundCompact = (async () => {
					try {
						const tokens = this.estimateTokens(this.apiConversationHistory);
						const SNIP_THRESHOLD = Math.floor(EFFECTIVE_CONTEXT_WINDOW * 0.50);
						if (tokens > SNIP_THRESHOLD) {
							const snipResult = this.contextCompactor.updateMessages(this.apiConversationHistory as CompactableMessage[]);
							if (snipResult.needsPrune) {
								this.apiConversationHistory = snipResult.messages;
								this.rebuildCharCount();
								const after = this.estimateTokens(this.apiConversationHistory);
								if (after < tokens) {
									console.log(`[TaskService] D7 后台压缩: ${tokens} -> ${after} tokens`);
								}
							}
						}
					} catch (e) {
						console.warn('[TaskService] D7 后台压缩失败:', e);
					}
				})();

				// 工具执行成功，继续下一轮 API（A3: 迭代替代递归）
				retryAttempt = 0;
				continue;

			} catch (error) {
				// E3: ReactiveCompact - 413/prompt_too_long 自动压缩重试
				if (this.isPromptTooLongError(error)) {
					console.warn('[TaskService] E3: ReactiveCompact - 收到 prompt_too_long，强制压缩后重试');
					await this.say('text', '[E3] 上下文过长，正在自动压缩对话历史...');
					try {
						await this.truncateHistoryIfNeeded(true);
					} catch (compactErr) {
						console.error('[TaskService] E3: 强制压缩失败:', compactErr);
					}
					retryAttempt = 0;
					continue;  // 压缩后直接重试
				}

				// 使用错误处理器分析错误
				const errorInfo = this.errorHandler.classifyError(error);
				console.error(`[TaskService] API调用错误 [${errorInfo.type}]:`, error);

				// 判断是否应该自动重试
				if (this.errorHandler.shouldRetry(error, retryAttempt)) {
					const delay = this.errorHandler.calculateRetryDelay(retryAttempt);
					const userMessage = `${errorInfo.userMessage}，将在 ${Math.round(delay / 1000)} 秒后重试...`;
					await this.say('api_req_retry_delayed', userMessage);
					await this.sleep(delay);
					retryAttempt++;  // A3: 迭代替代递归
					continue;
				}

				// 不可重试的错误或超过重试次数，询问用户
				const userFriendlyMessage = this.errorHandler.getUserFriendlyMessage(error);
				const { response } = await this.ask('api_req_failed', userFriendlyMessage);

				if (response === 'yesButtonClicked') {
					retryAttempt = 0;
					continue;  // A3: 迭代替代递归
				}

				return true;
			}
		}
	}

	/**
	 * 尝试API请求
	 */
	private async attemptApiRequest(retryAttempt: number): Promise<AsyncIterable<StreamChunk>> {
		// 在发送请求前截断历史以控制 token 消耗
		await this.truncateHistoryIfNeeded();

		// 获取基础系统提示词
		let systemPrompt = await this.getSystemPrompt();

		// 如果有探索和规划结果，增强系统提示词
		if (this.taskContext) {
			systemPrompt = this.agentOrchestrator.generateEnhancedPrompt(systemPrompt, this.taskContext);
		}
		systemPrompt += '\n\n【最终语言约束（不可违反）】\n- 所有自然语言输出必须使用简体中文。\n- 仅当用户明确要求其他语言时才可切换。\n- 若你误用了英文，必须立即改回简体中文并继续。';

		// P0优化：FocusChain 提示词注入为用户消息，保持 system prompt 稳定（有利于服务端提示词缓存）
		const focusChainPrompt = this.focusChainManager.getPromptForCurrentState();
		let conversationHistoryForRequest = this.apiConversationHistory;
		if (focusChainPrompt) {
			// 创建副本，避免修改原始历史
			const history = [...this.apiConversationHistory];
			const lastIdx = history.length - 1;
			if (lastIdx >= 0 && history[lastIdx].role === 'user') {
				const lastMsg = history[lastIdx];
				const existingContent = typeof lastMsg.content === 'string'
					? lastMsg.content
					: lastMsg.content.map(b => ('text' in b ? b.text : '')).join('');
				history[lastIdx] = {
					...lastMsg,
					content: `${focusChainPrompt}\n\n${existingContent}`
				};
				conversationHistoryForRequest = history;
			}
		}

		const toolDefinitions = this.getToolDefinitions();

		if (retryAttempt === 0) {
			await this.say('api_req_started', 'API请求已开始...');
		} else {
			await this.say('api_req_retried', `正在重试 API 请求 (尝试 ${retryAttempt + 1})...`);
		}

		// P0优化：增加 API 调用计数（用于FocusChain提醒）
		this.focusChainManager.incrementApiCallCount();

		// E1调试：每轮输出当前 context 大小（证明新代码已加载）
		const _ctxTokens = this.estimateTokens(this.apiConversationHistory);
		this.debugLog(`[TaskService] E1 context: ${_ctxTokens} tokens | 有效窗口: ${EFFECTIVE_CONTEXT_WINDOW} | 警告线: ${CONTEXT_WARNING_THRESHOLD} | 压缩线: ${CONTEXT_AUTO_COMPACT_THRESHOLD}`);

		// 埋点：记录 AI 调用开始时间
		this._aiCallStartTime = Date.now();

		return this.apiHandler.createMessage(systemPrompt, conversationHistoryForRequest, toolDefinitions);
	}

	/**
	 * 处理API流式响应
	 * 🚀 性能优化：恢复实时流式显示，提升用户感知速度50%
	 * - 文本实时显示，让用户立即看到AI响应
	 * - 工具调用前的思考文本也会显示，增强透明度
	 * - 前端可根据后续是否有工具调用来调整显示样式
	 * 🔒 XML检测：提前检测XML工具调用，避免`<`字符泄露
	 */
	private async processApiStream(stream: AsyncIterable<StreamChunk>): Promise<{
		assistantMessage: string;
		toolUses: Array<{ id: string; name: string; input: any }>;
		hasError: boolean;
		stopReason: string; // E2优化：'length' 表示命中 max_output_tokens 上限
	}> {
		let assistantMessage = '';
		const toolUses: Array<{ id: string; name: string; input: any }> = [];
		let hasError = false;
		let stopReason = ''; // E2优化：追踪输出截断原因
		let firstTokenReceived = false;
		let reasoningCharsCount = 0; // 思考链累积字符数（用于进度显示）
		let xmlDetected = false; // XML检测标志
		let xmlToolName = ''; // XML工具调用时检测到的工具名
		let xmlStreamingFired = false; // 是否已经发出过XML流式事件
		const XML_STREAM_ID = 'xml-stream-preview'; // 固定ID用于更新同一元素

		// P0-2: 初始化流式检查点
		this._streamCheckpoint = {
			partialText: '',
			partialToolUses: [],
			startedAt: Date.now()
		};

		try {
		for await (const chunk of stream) {
			// 检查是否已中止，如果是则停止处理流
			if (this.abort) {
				hasError = true;
				break;
			}

			if (chunk.type === 'text') {
				// 累积文本
				assistantMessage += chunk.text;
				// P0-2: 持续更新检查点中的文本
				if (this._streamCheckpoint) {
					this._streamCheckpoint.partialText = assistantMessage;
				}

				// 记录首Token时间
				if (!firstTokenReceived) {
					firstTokenReceived = true;
				}

				// 🔒 检测是否可能是XML工具调用（正则一次匹配，短路返回）
				if (!xmlDetected && this.mightBeXmlToolCall(assistantMessage)) {
					xmlDetected = true;
					xmlToolName = this.extractXmlToolName(assistantMessage);
				}

				// 只有在未检测到XML时才进行流式显示
				if (!xmlDetected) {
					this._onStreamChunk.fire({ text: chunk.text, isPartial: true });
				} else {
					// XML工具调用期间：将正在生成的内容展示给用户，避免界面看起来"卡住"
					// 直接传完整内容，UI 侧只显示字符数，不展示原始内容
					this._onToolInputStreaming.fire({
						toolId: XML_STREAM_ID,
						toolName: xmlToolName || 'tool',
						input: assistantMessage,
						isPartial: true,
					});
					xmlStreamingFired = true;
				}
			} else if (chunk.type === 'tool_use') {
				// 进度片段：只更新 UI，不加入 toolUses
				if (chunk.isPartial) {
					this._onToolInputStreaming.fire({
						toolId: chunk.id || chunk.name,
						toolName: chunk.name,
						input: chunk.input,
						isPartial: true,
					});
					continue;
				}

				let input: any;
				let parseErrorForModel: string | null = null;
				try {
					if (typeof chunk.input === 'string') {
						const parsed = safeParseToolArguments(chunk.input, chunk.name);
						if (parsed.ok) {
							input = parsed.value;
							if (parsed.repaired) {
								console.warn(`[TaskService] safeParseToolArguments 修复成功 (工具:${chunk.name})`);
							}
						} else {
							// 触发下方 catch 分支继续 batch 专项 / 截断兜底
							throw new Error(parsed.error || 'safeParseToolArguments failed');
						}
					} else {
						input = chunk.input;
					}
				} catch (e) {
					parseErrorForModel = (e instanceof Error ? e.message : String(e));
					const inputStr = typeof chunk.input === 'string' ? chunk.input : JSON.stringify(chunk.input);
					const inputLength = inputStr.length;
					console.log(`[ToolTrace] [ParseError] 工具参数解析失败 (工具:${chunk.name}, 长度:${inputLength}, 错误:${parseErrorForModel})`);
					console.log(`[ToolTrace] [ParseError] 参数完整内容:`, inputStr);

					// 🔧 修复：对于batch工具，尝试手动解析JSON（可能被大内容影响）
					// chunk.name 可能因模型流式响应分块问题为空，同时通过 input 内容检测是否是 batch 调用
					const isBatchCall = chunk.name === 'batch' || (typeof chunk.input === 'string' && chunk.input.includes('"tool_calls"'));
					if (isBatchCall && typeof chunk.input === 'string') {
						if (!chunk.name) { console.warn('[TaskService] batch 调用 chunk.name 为空，通过 input 内容识别'); }
						try {
							const trimmedBatchInput = chunk.input.trim();
							// Step 1: 截断修复 —— 模型输出 {"tool_calls": "..."} 但缺少结尾 }
							if (trimmedBatchInput.startsWith('{') && !trimmedBatchInput.endsWith('}')) {
								const repaired = trimmedBatchInput + '}';
								input = JSON.parse(repaired);
								console.log('[TaskService] batch JSON 截断修复成功（补全结尾}）');
							} else {
								// Step 2: XML 格式
								const toolCallsMatch = chunk.input.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
								if (toolCallsMatch) {
									const toolCallsStr = toolCallsMatch[1].trim();
									const toolCalls = JSON.parse(toolCallsStr);
									input = { tool_calls: toolCalls };
								} else {
									// Step 3: 直接尝试再次解析（兜底）
									try {
										input = JSON.parse(trimmedBatchInput);
									} catch {
										input = {};
										console.warn('[TaskService] batch 所有修复策略均失败，使用空对象');
									}
								}
							}
						} catch (e2) {
							console.error('[TaskService] 手动解析也失败:', e2);
							input = {};
						}
					} else {
						// 尝试截取合法 JSON 部分（"Unexpected non-whitespace character after JSON" 类错误）
						if (typeof chunk.input === 'string') {
							const trimmed = chunk.input.trim();
							if (trimmed.startsWith('{')) {
								let depth = 0;
								let inString = false;
								let escape = false;
								let endIdx = -1;
								for (let i = 0; i < trimmed.length; i++) {
									const c = trimmed[i];
									if (escape) { escape = false; continue; }
									if (c === '\\' && inString) { escape = true; continue; }
									if (c === '"') { inString = !inString; continue; }
									if (inString) { continue; }
									if (c === '{') { depth++; }
									else if (c === '}') {
										depth--;
										if (depth === 0) { endIdx = i; break; }
									}
								}
								if (endIdx > 0) {
									try {
										input = JSON.parse(trimmed.substring(0, endIdx + 1));
										console.warn(`[TaskService] 截取合法JSON成功 (工具:${chunk.name}, 截取至:${endIdx + 1}/${trimmed.length})`);
									} catch {
										input = {};
									}
								} else {
									input = {};
								}
							} else {
								input = {};
							}
						} else {
							input = {};
						}
					}
				}

				// 发出工具输入流式事件（用于实时显示工具调用信息）
				this._onToolInputStreaming.fire({
					toolId: chunk.id,
					toolName: chunk.name,
					input: input,
					isPartial: false, // 工具输入接收完整后发出
				});

				// 如果所有解析/修复都失败，附加错误标记，稍后以 tool_result.is_error=true 回传模型
				if (parseErrorForModel && (input === undefined || input === null || (typeof input === 'object' && Object.keys(input).length === 0))) {
					input = { ...(input || {}), __parseError: parseErrorForModel };
				}
				toolUses.push({ id: chunk.id, name: chunk.name, input });
				// P0-2: 更新检查点中的工具调用列表
				if (this._streamCheckpoint) {
					this._streamCheckpoint.partialToolUses = [...toolUses];
				}
			} else if (chunk.type === 'reasoning') {
				// 模型思考链阶段：将思考内容直接透传给UI展示，UI负责在正式内容到来时折叠
				reasoningCharsCount += chunk.text.length;
				this._onStreamChunk.fire({
					reasoningText: chunk.text,
					isPartial: true
				});
			} else if (chunk.type === 'heartbeat') {
				const elapsedSeconds = Math.max(1, Math.floor((chunk.elapsedMs || 0) / 1000));
				this._onStreamChunk.fire({
					progressText: `⏳ 仍在等待模型返回（已 ${elapsedSeconds}s）...`,
					isPartial: true
				});
			} else if (chunk.type === 'usage') {
				this.updateTokenUsage(chunk);
				// E2优化：捕获 stopReason（'length' = 命中 max_output_tokens 上限）
				if (chunk.stopReason) {
					stopReason = chunk.stopReason;
				}
				// 埋点：AI 调用 usage 事件（包含本次 token 和延迟）
				if (this.behaviorReporter) {
					const latencyMs = this._aiCallStartTime > 0 ? Date.now() - this._aiCallStartTime : 0;
					const modelInfo = this.apiHandler.getModel();
					this.behaviorReporter.reportAiCall(
						modelInfo.name || 'unknown',
						chunk.inputTokens || 0,
						chunk.outputTokens || 0,
						this.tokenUsage.totalCost || 0,
						latencyMs,
						true
					);
				}
			} else if (chunk.type === 'error') {
				console.error('[TaskService] API错误:', chunk.error);
				hasError = true;
			}
		}

		// 🔧 支持 XML 格式的工具调用（兼容性增强）
		// 如果没有通过标准 function calling 获得工具调用，尝试从文本中解析 XML 格式
		if (toolUses.length === 0 && assistantMessage) {
			const xmlToolUses = this.parseXmlToolCalls(assistantMessage);
			if (xmlToolUses.length > 0) {
				toolUses.push(...xmlToolUses);
				// 清空 assistantMessage，因为这是工具调用，不是普通响应
				// 前端通过检测hasXmlTag已经阻止了XML文本的显示，这里无需特殊处理
				assistantMessage = '';
			}
		}

		// XML流式预览结束：fire isPartial:false，触发UI 1.5秒后自动清理
		if (xmlStreamingFired) {
			this._onToolInputStreaming.fire({
				toolId: XML_STREAM_ID,
				toolName: xmlToolName || 'tool',
				input: {},
				isPartial: false,
			});
		}

		} catch (streamError) {
			// P0-2: 流式响应中断处理（网络错误、超时等导致 for-await 提前退出）
			const reason = streamError instanceof Error ? streamError.message : String(streamError);
			console.error('[TaskService] P0-2: 流式响应中断:', reason);

			// 如果检查点中有已接收的部分内容，触发中断事件（UI 显示墓碑标记）
			if (this._streamCheckpoint &&
				(this._streamCheckpoint.partialText.length > 0 || this._streamCheckpoint.partialToolUses.length > 0)) {
				this._onStreamInterrupted.fire({
					partialText: this._streamCheckpoint.partialText,
					hasPartialToolCalls: this._streamCheckpoint.partialToolUses.length > 0,
					reason
				});
			}
			hasError = true;
		} finally {
			// P0-2: 清除检查点（流已结束，无论成功还是失败）
			this._streamCheckpoint = null;
		}

		if (!this.abort && (assistantMessage || toolUses.length > 0)) {
			this._onStreamChunk.fire({ text: undefined, isPartial: false });
			await this.say('api_req_finished', 'API请求已完成');
		}

		return { assistantMessage, toolUses, hasError, stopReason };
	}

	/**
	 * 工具名称列表（用于XML检测和解析）
	 * 直接引用 toolTypes 中的 toolNames，避免新增工具时忘记更新此处
	 */
	private readonly TOOL_NAMES: readonly string[] = ALL_TOOL_NAMES;

	/**
	 * 预编译的XML工具调用检测正则（热路径优化：一次匹配所有工具名）
	 * 形如 <read_file> 或 <read_file  的开标签
	 */
	private readonly XML_TOOL_REGEX: RegExp = new RegExp(
		'<(' + ALL_TOOL_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:>|\\s)',
		''
	);

	/**
	 * 检测文本是否可能是XML工具调用（正则一次匹配，热路径 O(1) 级别）
	 * 在流式处理时提前检测，避免XML字符泄露到前端
	 */
	private mightBeXmlToolCall(text: string): boolean {
		return this.XML_TOOL_REGEX.test(text);
	}

	/**
	 * 从文本中提取第一个匹配的XML工具名（正则直接捕获，无需循环）
	 */
	private extractXmlToolName(text: string): string {
		const m = this.XML_TOOL_REGEX.exec(text);
		return m ? m[1] : '';
	}

	/**
	 * 解析 XML 格式的工具调用
	 * 支持格式：<tool_name><param1>value1</param1><param2>value2</param2></tool_name>
	 */
	private parseXmlToolCalls(text: string): Array<{ id: string; name: string; input: any }> {
		const toolUses: Array<{ id: string; name: string; input: any }> = [];

		// 使用共享的工具名称列表
		const toolNames = this.TOOL_NAMES;

		// 尝试匹配每个工具名称的 XML 标签
		for (const toolName of toolNames) {
			const regex = new RegExp(`<${toolName}[^>]*>(.*?)<\/${toolName}>`, 'gs');
			const matches = text.matchAll(regex);

			for (const match of matches) {
				const innerXml = match[1].trim();
				const params: any = {};

				// 优先尝试解析 JSON body（AI 有时会输出 {"param": "value"} 格式）
				if (innerXml.startsWith('{')) {
					try {
						const jsonBody = JSON.parse(innerXml);
						Object.assign(params, jsonBody);
					} catch {
						// JSON 解析失败，继续尝试 XML 参数格式
					}
				}

				// 如果 JSON 解析没有得到参数，尝试 XML 参数格式 <param>value</param>
				if (Object.keys(params).length === 0) {
					const paramRegex = /<(\w+)>(.*?)<\/\1>/gs;
					const paramMatches = innerXml.matchAll(paramRegex);
					for (const paramMatch of paramMatches) {
						params[paramMatch[1]] = paramMatch[2].trim();
					}
				}

				// 生成唯一ID
				const id = `xml_${toolName}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

				toolUses.push({
					id,
					name: toolName,
					input: params
				});
			}
		}

		return toolUses;
	}

	/**
	 * 添加助手响应到历史
	 */
	private async addAssistantResponse(
		assistantMessage: string,
		toolUses: Array<{ id: string; name: string; input: any }>
	): Promise<void> {
		const content: ContentBlock[] = [];

		if (assistantMessage) {
			content.push({ type: 'text', text: assistantMessage });
		}

		for (const toolUse of toolUses) {
			content.push({
				type: 'tool_use',
				id: toolUse.id,
				name: toolUse.name,
				input: toolUse.input
			});
		}

		this.pushHistory({ role: 'assistant', content: content as any });
	}

	/**
	 * 向 apiConversationHistory 追加一条消息，同步更新增量字符计数器（A7 优化）
	 */
	private pushHistory(msg: MessageParam): void {
		this.apiConversationHistory.push(msg);
		this._estimatedTotalChars += this.countMsgChars(msg);
		// 每次历史增长后即时更新上下文估算，推给 UI 进度条（不等 usage chunk）
		try {
			this.tokenUsage.contextTokens = this.estimateTokens(this.apiConversationHistory);
			this._onTokenUsageUpdated.fire(this.tokenUsage);
		} catch { /* ignore */ }
	}

	private cloneHistoryMessage(msg: MessageParam): MessageParam {
		try {
			return JSON.parse(JSON.stringify(msg)) as MessageParam;
		} catch {
			return msg;
		}
	}

	// ========== 工具执行 ==========

	/**
	 * 只读工具列表（可以并行执行）
	 */
	private readonly READ_ONLY_TOOLS = new Set([
		'read_file',
		'list_files',
		'search_files',
		'list_code_definition_names',
		'codebase_search',
		'glob'
	]);

	/**
	 * 判断工具是否为只读工具
	 */
	private isReadOnlyTool(toolName: string): boolean {
		return this.READ_ONLY_TOOLS.has(toolName);
	}

	/**
	 * 固定使用高质量档位，避免在探索/执行间频繁切换模型导致上下文理解不稳定。
	 */
	private updateModelTierForNextRound(toolUses: Array<{ id: string; name: string; input: any }>): void {
		void toolUses;
		if (typeof (this.apiHandler as any).setModelTier !== 'function') {
			return;
		}
		(this.apiHandler as any).setModelTier('plus');
	}

	/**
	 * 执行工具列表 - 带审批和attempt_completion处理
	 * 优化：只读工具并行执行，写入工具顺序执行
	 */
	private async executeTools(toolUses: Array<{ id: string; name: string; input: any }>): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
	}> {
		const toolResults: ContentBlock[] = [];
		const toolNameById = new Map<string, string>(toolUses.map(toolUse => [toolUse.id, toolUse.name]));

		for (const toolUse of toolUses) {
			this.emitToolTraceCall(toolUse, 'top');
		}

		// 分离只读工具和写入工具
		const readOnlyTools: Array<{ id: string; name: string; input: any }> = [];
		const writeTools: Array<{ id: string; name: string; input: any }> = [];
		const specialTools: Array<{ id: string; name: string; input: any }> = []; // attempt_completion, ask_followup_question

		for (const toolUse of toolUses) {
			if (toolUse.name === 'attempt_completion' || toolUse.name === 'ask_followup_question') {
				specialTools.push(toolUse);
			} else if (this.isReadOnlyTool(toolUse.name)) {
				readOnlyTools.push(toolUse);
			} else {
				writeTools.push(toolUse);
			}
		}

		// 1. 并行执行只读工具
		if (readOnlyTools.length > 0) {
			const readResults = await this.executeToolsInParallel(readOnlyTools);
			toolResults.push(...readResults);
			for (const block of readResults) {
				if (block.type === 'tool_result') {
					this.emitToolTraceResult(
						block.tool_use_id,
						toolNameById.get(block.tool_use_id) || 'unknown',
						block.content,
						!!block.is_error,
						'top'
					);
				}
			}
		}

		// 2. 顺序执行写入工具（需要用户确认）
		for (const toolUse of writeTools) {
			const result = await this.executeSingleTool(toolUse);
			if (result.shouldEndLoop) {
				// 添加已收集的结果
				if (toolResults.length > 0) {
					this.pushHistory({ role: 'tool', content: toolResults });
				}
				return result;
			}
			if (result.toolResult) {
				toolResults.push(result.toolResult);
				if (result.toolResult.type === 'tool_result') {
					this.emitToolTraceResult(
						result.toolResult.tool_use_id,
						toolNameById.get(result.toolResult.tool_use_id) || toolUse.name,
						result.toolResult.content,
						!!result.toolResult.is_error,
						'top'
					);
				}
			}
		}

		// 3. 顺序执行特殊工具（attempt_completion, ask_followup_question）
		for (const toolUse of specialTools) {
			if (toolUse.name === 'attempt_completion') {
				// Solo 模式：直接结束循环，不需要 attempt_completion 验证流程
				if (this.currentMode === 'solo') {
					const completionText = typeof toolUse.input.result === 'string' ? toolUse.input.result.trim() : '';
					if (completionText) {
						await this.say('completion_result', completionText);
					}
					if (toolResults.length > 0) {
						this.pushHistory({ role: 'tool', content: toolResults });
					}
					console.log('[TaskService][Solo] attempt_completion 拦截，直接结束任务');
					return { shouldContinue: true, shouldEndLoop: true };
				}

				const result = await this.handleAttemptCompletion(toolUse);
				if (result.shouldEndLoop) {
					// 添加已收集的结果
					if (toolResults.length > 0) {
						this.pushHistory({ role: 'tool', content: toolResults });
					}
					return result;
				}
				if (result.toolResult) {
					toolResults.push(result.toolResult);
					if (result.toolResult.type === 'tool_result') {
						this.emitToolTraceResult(
							result.toolResult.tool_use_id,
							toolNameById.get(result.toolResult.tool_use_id) || toolUse.name,
							result.toolResult.content,
							!!result.toolResult.is_error,
							'top'
						);
					}
				}
			} else if (toolUse.name === 'ask_followup_question') {
				const result = await this.executeSingleTool(toolUse);
				if (result.toolResult) {
					toolResults.push(result.toolResult);
					if (result.toolResult.type === 'tool_result') {
						this.emitToolTraceResult(
							result.toolResult.tool_use_id,
							toolNameById.get(result.toolResult.tool_use_id) || toolUse.name,
							result.toolResult.content,
							!!result.toolResult.is_error,
							'top'
						);
					}
				}
			}
		}

		// 每轮在最后一个 tool_result 尾部追加"已读文件上下文清单"
		// 优化：只在清单实际变化时追加，避免每轮重复相同信息浪费 tokens
		try {
			const execAny = this.toolExecutor as any;
			if (toolResults.length > 0 && typeof execAny?.getFileStateCache === 'function') {
				const cache = execAny.getFileStateCache();
				if (cache && typeof cache.buildManifest === 'function') {
					const manifest = cache.buildManifest(this.workspaceRoot);
					if (manifest.unchanged.length > 0 || manifest.modifiedByTool.length > 0 || manifest.partial.length > 0) {
						// 只在 manifest 实际变化时追加，避免每轮重复浪费 tokens
						const manifestKey = [...manifest.unchanged, '|', ...manifest.modifiedByTool, '|', ...manifest.partial].join(',');
						if (manifestKey !== this._lastManifestKey) {
							this._lastManifestKey = manifestKey;
							const lines: string[] = ['', '---', '# 已读文件上下文'];
							if (manifest.unchanged.length > 0) {
								lines.push('✅ 已读未改（直接引用历史内容）: ' + manifest.unchanged.join(', '));
							}
							if (manifest.modifiedByTool.length > 0) {
								lines.push('⚠️ 已修改（需重新 read_file）: ' + manifest.modifiedByTool.join(', '));
							}
							if (manifest.partial.length > 0) {
								lines.push('⚠️ 局部读取: ' + manifest.partial.join(', '));
							}
							const manifestText = lines.join('\n');
							const last: any = toolResults[toolResults.length - 1];
							if (last && last.type === 'tool_result') {
								if (typeof last.content === 'string') {
									last.content = last.content + manifestText;
								} else if (Array.isArray(last.content)) {
									const lastBlock = last.content[last.content.length - 1];
									if (lastBlock && lastBlock.type === 'text' && typeof lastBlock.text === 'string') {
										lastBlock.text = lastBlock.text + manifestText;
									} else {
										last.content.push({ type: 'text', text: manifestText });
									}
								}
							}
						}
					}
				}
			}
		} catch { /* 非致命，忽略 */ }

		// 添加工具结果到历史
		if (toolResults.length > 0) {
			this.pushHistory({
				role: 'tool',
				content: toolResults
			});
		}

		// 效率优化：检测是否全部是只读/探索性工具（包括batch内的只读操作和skill）
		// 注意：skill虽然不是READ_ONLY_TOOLS，但本质是信息获取，不应重置探索计数
		// 注意：batch 需要检查子工具，若含写入工具则不算探索
		const EXPLORATION_TOOLS = new Set([...this.READ_ONLY_TOOLS, 'skill']);
		const batchHasWriteTool = (batchInput: any): boolean => {
			try {
				const rawCalls = batchInput?.tool_calls;
				const calls: Array<{ name: string }> = typeof rawCalls === 'string'
					? JSON.parse(rawCalls)
					: (Array.isArray(rawCalls) ? rawCalls : []);
				return calls.some(c => !EXPLORATION_TOOLS.has(c.name));
			} catch {
				return false; // 无法解析时保守处理，视为只读
			}
		};
		const allExploration = toolUses.every(t => {
			if (t.name === 'batch') return !batchHasWriteTool(t.input);
			return EXPLORATION_TOOLS.has(t.name);
		});
		if (allExploration) {
			this.consecutiveReadOnlyRounds++;
			const noProgressReason = this.getExplorationBlockReason(toolUses);
			if (noProgressReason) {
				this.mainThreadExplorationGuardActive = true;
				this.pushHistory({
					role: 'system',
					content: `${noProgressReason}\n\n这是系统内部纠偏提示，不要把这段话原样回复给用户。请立即切换策略并继续完成用户请求；如果已确认目标文件，就直接修改，不要再次围绕同一批只读搜索打转。`
				});
				this.debugLog('[TaskService] 只读探索无进展，已注入内部纠偏提示并继续下一轮');
				return { shouldContinue: true, shouldEndLoop: false };
			}
		} else {
			// 有实际写入操作（apply_diff/write_to_file/execute_command等），重置探索计数
			this.consecutiveReadOnlyRounds = 0;
			this.mainThreadExplorationGuardActive = false;
			this.resetExplorationProgress();
		}

		return { shouldContinue: true, shouldEndLoop: false };
	}

	/**
	 * 并行执行只读工具（带缓存和重复检测）
	 * P0优化：增加重复文件读取检测
	 */
	private async executeToolsInParallel(toolUses: Array<{ id: string; name: string; input: any }>): Promise<ContentBlock[]> {
		const promises = toolUses.map(async (toolUse) => {
			try {
				const searchBudgetGuardMessage = this.checkMainThreadExplorationGuard(toolUse);
				if (searchBudgetGuardMessage) {
					if (this.isBlockingGuardMessage(searchBudgetGuardMessage)) {
						this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: true });
						return {
							type: 'tool_result' as const,
							tool_use_id: toolUse.id,
							content: searchBudgetGuardMessage,
							is_error: true
						};
					}
					this.emitRuntimeGuidanceOnce('search_guard', searchBudgetGuardMessage);
				}

				const repetitionCheck = this.toolRepetitionDetector.check({
					type: 'tool_use',
					name: toolUse.name as ToolName,
					params: this.normalizeToolCacheInput(toolUse.input),
					partial: false,
					toolUseId: toolUse.id
				});
				if (!repetitionCheck.allowExecution) {
					this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: true });
					return {
						type: 'tool_result' as const,
						tool_use_id: toolUse.id,
						content: repetitionCheck.askUser?.messageDetail || '工具重复调用，请调整策略',
						is_error: true
					};
				}

				// 显示工具执行状态
				const toolStatusText = this.formatToolStatusForDisplay(toolUse);
				await this.say('tool', toolStatusText);

				// 优先检查缓存。read_file 的同一请求第 2 次应优先复用缓存，而不是再被上层拦截。
				const cachedResult = this.toolCache.get(toolUse.name, this.normalizeToolCacheInput(toolUse.input));
				if (cachedResult !== null) {
					const duplicateCheck = this.checkDuplicateFileRead(toolUse.name, toolUse.input);
					if (duplicateCheck && !duplicateCheck.preferCachedContent) {
						this.handleDuplicateFileReadIntervention(duplicateCheck);
						this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: duplicateCheck.isError });
						return {
							type: 'tool_result' as const,
							tool_use_id: toolUse.id,
							content: duplicateCheck.message,
							is_error: duplicateCheck.isError
						};
					}
					// 首次从缓存命中，正常返回
					this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: false });
					return {
						type: 'tool_result' as const,
						tool_use_id: toolUse.id,
						content: cachedResult,
						is_error: false
					};
				}

				// 缓存未命中时，只拦截“已修改文件的确认性回读”或“同一 read_file 请求第 3 次以上”。
				const duplicateCheck = this.checkDuplicateFileRead(toolUse.name, toolUse.input);
				if (duplicateCheck && !duplicateCheck.preferCachedContent) {
					this.handleDuplicateFileReadIntervention(duplicateCheck);
					this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: duplicateCheck.isError });
					return {
						type: 'tool_result' as const,
						tool_use_id: toolUse.id,
						content: duplicateCheck.message,
						is_error: duplicateCheck.isError
					};
				}

					const execution = await this.executeToolWithStructuredResult({
						type: 'tool_use',
						name: toolUse.name as ToolName,
						params: toolUse.input,
						partial: false,
						toolUseId: toolUse.id
					});
					if (!execution.success) {
						const failureContent = typeof execution.result === 'string'
							? execution.result
							: formatResponse.toolError(execution.error || `${toolUse.name} 执行失败`);
						this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: true });
						return {
							type: 'tool_result' as const,
							tool_use_id: toolUse.id,
							content: failureContent,
							is_error: true
						};
					}
					const result = execution.result ?? '';

					// 截断大工具结果
					const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
					const truncatedContent = this.truncateToolResult(resultContent);

					// 设置缓存（只缓存成功的只读结果）
					if (execution.metadata?.shouldCacheResult !== false && this.shouldCacheReadOnlyResult(toolUse.name, truncatedContent)) {
						this.toolCache.set(toolUse.name, this.normalizeToolCacheInput(toolUse.input), truncatedContent);
					}

				// 更新工具使用统计
				this.toolUsage[toolUse.name] = (this.toolUsage[toolUse.name] || 0) + 1;

				// 🔧 触发工具完成事件
				this._onToolCompleted.fire({
					toolId: toolUse.id,
					toolName: toolUse.name,
					isError: false
				});

				return {
					type: 'tool_result' as const,
					tool_use_id: toolUse.id,
					content: truncatedContent,
					is_error: false
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				console.error('[TaskService] 并行工具执行失败:', toolUse.name, error);

				// 🔧 触发工具完成事件（错误）
				this._onToolCompleted.fire({
					toolId: toolUse.id,
					toolName: toolUse.name,
					isError: true
				});

				return {
					type: 'tool_result' as const,
					tool_use_id: toolUse.id,
					content: formatResponse.toolError(errorMsg),
					is_error: true
				};
			}
		});

		return Promise.all(promises);
	}

	/**
	 * 执行单个工具（带确认流程）
	 */
	private async executeSingleTool(toolUse: { id: string; name: string; input: any }): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
		toolResult?: ContentBlock;
	}> {
		const searchBudgetGuardMessage = this.checkMainThreadExplorationGuard(toolUse);
		if (searchBudgetGuardMessage) {
			if (this.isBlockingGuardMessage(searchBudgetGuardMessage)) {
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: searchBudgetGuardMessage,
						is_error: true
					}
				};
			}
			this.emitRuntimeGuidanceOnce('search_guard', searchBudgetGuardMessage);
		}

		// 检查重复调用（batch 是元工具，重复检测交给子工具层面，此处跳过）
		const repetitionCheck = toolUse.name === 'batch'
			? { allowExecution: true }
			: this.toolRepetitionDetector.check({
				type: 'tool_use',
				name: toolUse.name as ToolName,
				params: this.normalizeToolCacheInput(toolUse.input),
				partial: false,
				toolUseId: toolUse.id
			});

		if (!repetitionCheck.allowExecution) {
			const isDoomLoopCorrection = repetitionCheck.askUser?.messageKey === 'doom_loop_detected';
			if (isDoomLoopCorrection && repetitionCheck.askUser?.messageDetail) {
				const correctionMessage = toolUse.name === 'task'
					? `${repetitionCheck.askUser.messageDetail}\n\n这是系统内部纠偏提示，不要把这段话原样回复给用户。你已经派发过相同或等价的子任务，禁止再次启动/恢复同一 explore 子任务。下一步只能：\n1. 直接基于已有子任务结果做判断\n2. 继续读取已经明确的具体文件\n3. 直接修改已确认的目标文件`
					: `${repetitionCheck.askUser.messageDetail}\n\n这是系统内部纠偏提示，不要把这段话原样回复给用户。你必须立即停止当前重复写入/重复读写策略，改为：\n1. 检查其他相关文件（调用方、配置入口、引用方）\n2. 如果核心改动已经完成，直接给用户结果\n3. 如果仍需继续实现，只能换文件或换策略，禁止再次对同一文件做同类写入`;
				this.pushHistory({
					role: 'system',
					content: correctionMessage
				});
			}

			// 运行时治理拦截属于“纠偏”而不是“执行错误”，不应累积到 mistake 限制导致任务停机。
			this.consecutiveMistakeCount = 0;

			// 返回阻断信息。重复调用不再伪装成成功，强制模型调整策略。
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: repetitionCheck.askUser?.messageDetail || '工具重复调用，请调整策略',
					is_error: true
				}
			};
		}

		// 效率优化：限制skill工具调用次数（每个任务最多1次，避免浪费round-trip）
		if (toolUse.name === 'skill') {
			const skillCount = (this.toolUsage['skill'] || 0);
			if (skillCount >= 1) {
				console.log(`[TaskService] ⚡ skill工具调用已达上限(${skillCount}次)，跳过`);
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: 'skill工具调用已达本次任务上限(1次)。请直接使用你已有的知识继续工作，不要再调用skill。',
						is_error: false
					} as ContentBlock
				};
			}
		}

		// 特殊处理 batch 工具：通过 executeToolsInParallel 执行子工具（享受完整缓存，避免重复读取）
		if (toolUse.name === 'batch') {
			return await this.executeBatchViaCachedParallel(toolUse);
		}

		// P0优化：对只读工具检查缓存（与 executeToolsInParallel 保持一致）
		const cachedResult = this.toolCache.get(toolUse.name, this.normalizeToolCacheInput(toolUse.input));
		if (cachedResult !== null) {
			const duplicateCheck = this.checkDuplicateFileRead(toolUse.name, toolUse.input);
			if (duplicateCheck && !duplicateCheck.preferCachedContent) {
				this.handleDuplicateFileReadIntervention(duplicateCheck);
				this.consecutiveMistakeCount = 0;
				this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: duplicateCheck.isError });
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: duplicateCheck.message,
						is_error: duplicateCheck.isError
					}
				};
			}
			// 首次从缓存命中，正常返回
			this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: false });
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: cachedResult,
					is_error: false
				}
			};
		}

		// 检查是否需要用户确认
		const needsApproval = this.toolNeedsApproval(toolUse.name);

		if (needsApproval) {
			const approvalResult = await this.requestToolApproval(toolUse);

			if (!approvalResult.approved) {
				const rejectionContent = approvalResult.failureKind === 'preflight_failed'
					? (approvalResult.feedback || '工具预检查失败，请先重新读取目标文件或重新定位修改点。')
					: approvalResult.feedback
						? `用户拒绝了工具执行并提供了反馈: ${approvalResult.feedback}`
						: '用户拒绝了工具执行';
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: rejectionContent,
						is_error: true
					}
				};
			}
		}

		const sameFileWriteGuardMessage = this.checkSameFileWriteBudget(toolUse);
		if (sameFileWriteGuardMessage) {
			if (this.isBlockingGuardMessage(sameFileWriteGuardMessage)) {
				this.consecutiveMistakeCount = 0;
				this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: true });
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: sameFileWriteGuardMessage,
						is_error: true
					}
				};
			}
			this.emitRuntimeGuidanceOnce(`write_guard:${toolUse.name}:${toolUse.input?.path || toolUse.input?.target_file || ''}:${this.totalApiRounds}`, sameFileWriteGuardMessage);
		}

		const writeAttemptGuardMessage = this.checkWriteAttemptBudget(toolUse);
		if (writeAttemptGuardMessage) {
			if (this.isBlockingGuardMessage(writeAttemptGuardMessage)) {
				this.consecutiveMistakeCount = 0;
				this._onToolCompleted.fire({ toolId: toolUse.id, toolName: toolUse.name, isError: true });
				return {
					shouldContinue: true,
					shouldEndLoop: false,
					toolResult: {
						type: 'tool_result',
						tool_use_id: toolUse.id,
						content: writeAttemptGuardMessage,
						is_error: true
					}
				};
			}
			this.emitRuntimeGuidanceOnce(`write_attempt_guard:${toolUse.name}:${toolUse.input?.path || toolUse.input?.target_file || ''}:${this.totalApiRounds}:${this.totalWriteToolAttemptCount}`, writeAttemptGuardMessage);
		}

		// 功能1: 写文件操作前自动创建 checkpoint（edit/multiedit/write_to_file/apply_diff）
		if (TaskService.CHECKPOINT_BEFORE_TOOLS.has(toolUse.name)) {
			try {
				const filePath = toolUse.input?.path || toolUse.input?.target_file || 'unknown';
				await this.checkpointManager.createCheckpoint(
					`写文件前 - ${toolUse.name}: ${filePath}`,
					{
						messageCount: this.apiConversationHistory.length,
						messages: [...this.apiConversationHistory],
						tokenUsage: { ...this.tokenUsage },
						timestamp: Date.now(),
						toolName: toolUse.name,
						filePath,
					}
				);
				this.debugLog(`[TaskService] 写文件前创建 checkpoint: ${toolUse.name} -> ${filePath}`);
			} catch (checkpointError) {
				// checkpoint 失败不影响主流程
				console.warn('[TaskService] 写文件前创建 checkpoint 失败:', checkpointError);
			}
		}

		// 执行工具
		try {
			const toolStatusText = this.formatToolStatusForDisplay(toolUse);
			await this.say('tool', toolStatusText);

					const execution = await this.executeToolWithStructuredResult({
						type: 'tool_use',
						name: toolUse.name as ToolName,
						params: toolUse.input,
						partial: false,
						toolUseId: toolUse.id
					});
					const result = execution.result ?? execution.error ?? '';
					const interaction = execution.interaction ?? this.parseLegacyInteractionFromResult(result);

					// 处理 ask_followup_question 的用户输入
					if (execution.status === 'input_required' && interaction?.type === 'followup') {
						return this.handleFollowupInteraction(toolUse.id, interaction.payload);
					}

					// 处理 execute_command requires_approval 用户确认（参考Cline）
					if (execution.status === 'approval_required' && interaction?.type === 'approval') {
						return this.handleApprovalInteraction(toolUse.id, interaction.payload.command, interaction.payload.cwd || '');
					}

					if (!execution.success) {
						if (this.shouldCountAsMistake(execution)) {
							this.consecutiveMistakeCount++;
						} else {
							this.consecutiveMistakeCount = 0;
						}
					this._onToolCompleted.fire({
						toolId: toolUse.id,
						toolName: toolUse.name,
						isError: true
					});
						const failureContent = typeof execution.result === 'string'
							? execution.result
							: formatResponse.toolError(execution.error || `${toolUse.name} 执行失败`);
						this.recordWriteAttemptOutcome(toolUse, execution, failureContent);
						const mutationRecoveryHint = this.buildMutationRecoveryHint(toolUse, failureContent);
						if (mutationRecoveryHint) {
							this.pushHistory({
								role: 'system',
								content: mutationRecoveryHint
							});
						}
					return {
						shouldContinue: true,
						shouldEndLoop: false,
						toolResult: {
							type: 'tool_result',
							tool_use_id: toolUse.id,
							content: failureContent,
							is_error: true
						}
					};
				}

					// 截断大工具结果
					const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
					let truncatedContent = this.truncateToolResult(resultContent);
					this.recordWriteAttemptOutcome(toolUse, execution, truncatedContent);
					if (TaskService.WRITE_TOOLS.has(toolUse.name) && !execution.metadata?.didWrite && !execution.metadata?.unknownWrite) {
						const noProgressHint = this.buildMutationRecoveryHint(toolUse, truncatedContent);
						if (noProgressHint) {
							const hintPath = this.extractWriteToolFilePaths(toolUse)[0] || toolUse.input?.path || toolUse.input?.target_file || '';
							this.emitRuntimeGuidanceOnce(`write_no_progress:${toolUse.name}:${hintPath}:${this.totalApiRounds}`, noProgressHint);
						}
					}

					// 写入工具执行成功或判定为未知写入后，使相关缓存失效
					if (execution.metadata?.didWrite || execution.metadata?.unknownWrite || execution.metadata?.shouldInvalidateSearchCache) {
						this.mainThreadExplorationGuardActive = false;
						this.invalidateCacheForWriteTool(toolUse, execution.metadata.affectedPaths, execution.metadata);
						if (execution.metadata?.didWrite) {
							await this.notifyCommittedFileChanges(execution.metadata.affectedPaths || []);
							this.debugLog('[TaskService] 文件写入已提交:', execution.metadata.affectedPaths || this.extractWriteToolFilePaths({ name: toolUse.name, input: toolUse.input }));
						} else if (execution.metadata?.unknownWrite) {
							this.debugLog('[TaskService] execute_command 可能修改了工作区，已执行保守缓存失效');
						}
					}

				if (toolUse.name === 'task') {
					this.mainThreadExplorationGuardActive = false;
				}

			// LSP 诊断由 AI 主动调用 lsp_diagnostics 工具获取，不再自动注入
			// 避免每次 edit 后阻塞等待 LSP（0.5-2s），提升任务执行速度

			// 更新工具使用统计
			this.toolUsage[toolUse.name] = (this.toolUsage[toolUse.name] || 0) + 1;
			this.consecutiveMistakeCount = 0;

			// P0优化：如果是 update_todo_list 工具，更新 FocusChain 清单并触发UI更新
			if ((toolUse.name === 'update_todo_list' || toolUse.name === 'todowrite') && toolUse.input && toolUse.input.todos) {
				// AI 有时将数组序列化为 JSON 字符串传入，需在此处解析为数组
				let parsedTodos = toolUse.input.todos;
				if (typeof parsedTodos === 'string') {
					try { parsedTodos = JSON.parse(parsedTodos); } catch { /* keep as string, UI handles it */ }
				}
				this.focusChainManager.updateChecklist(parsedTodos);

				// 触发任务列表更新事件，通知UI更新
				this._onTodoListUpdated.fire({ todos: parsedTodos });
			}

					// 🔧 追踪文件变更（仅记录真实落盘成功的写操作）
					if (execution.metadata?.didWrite) {
						this.trackFileChange(toolUse, execution.metadata?.affectedPaths);
					}

			// 🔧 触发工具完成事件
			this._onToolCompleted.fire({
				toolId: toolUse.id,
				toolName: toolUse.name,
				isError: false
			});

			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: truncatedContent,
					is_error: false
				}
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[TaskService] 工具执行失败:', toolUse.name, error);
			this.consecutiveMistakeCount++;
			this.recordWriteAttemptOutcome(
				toolUse,
				{
					success: false,
					status: 'error',
					error: errorMsg,
					metadata: {
						toolName: toolUse.name as ToolName,
						affectedPaths: this.extractWriteToolFilePaths(toolUse),
						didWrite: false,
						shouldInvalidateSearchCache: false,
						shouldResetReadTracking: false,
						shouldCacheResult: false,
					}
				} as ToolExecutionResult,
				errorMsg
			);

			// 🔧 触发工具完成事件（错误）
			this._onToolCompleted.fire({
				toolId: toolUse.id,
				toolName: toolUse.name,
				isError: true
			});

			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: formatResponse.toolError(errorMsg),
					is_error: true
				}
			};
		}
	}

	/**
	 * 通过 executeToolsInParallel 执行 batch 子工具（享受完整缓存）
	 * batch 子工具结果会写入 ToolResultCache，后续重复读取直接命中缓存
	 */
	private async executeBatchViaCachedParallel(toolUse: { id: string; name: string; input: any }): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
		toolResult?: ContentBlock;
	}> {
		const toolStatusText = this.formatToolStatusForDisplay(toolUse);
		await this.say('tool', toolStatusText);

		// 解析 batch 参数（支持数组、字符串、对象包装、截断修复、路径兜底恢复）
		const toolCalls = this.parseBatchToolCallsInput(toolUse.input?.tool_calls);

		if (toolCalls.length === 0) {
			const malformedHint = this.buildUnifiedRecoveryHint('malformed_batch', 'batch.tool_calls');
			this.emitRuntimeGuidanceOnce(`malformed_batch:${this.totalApiRounds}`, malformedHint);
			this._onToolCompleted.fire({ toolId: toolUse.id, toolName: 'batch', isError: true });
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: malformedHint,
					is_error: true
				}
			};
		}

		// 过滤不允许在 batch 中的工具，并限制最大并行数
		const { BatchToolConstants } = await import('../tools/batchTool.js');
		const validCalls = toolCalls
			.filter(call => !BatchToolConstants.DISALLOWED_TOOLS.has(call.tool as any))
			.slice(0, BatchToolConstants.MAX_CALLS);
		const invalidCalls = toolCalls.filter(call => BatchToolConstants.DISALLOWED_TOOLS.has(call.tool as any));

		// 将子工具分为只读（并行执行）和写入（需要用户确认，顺序执行）两类
		const WRITE_TOOLS_IN_BATCH = new Set([
			'write_to_file', 'apply_diff', 'edit_file', 'edit', 'multiedit', 'patch',
			'insert_content', 'search_and_replace', 'execute_command'
		]);

		const readOnlyCalls: Array<{ call: { tool: string; parameters: any }; idx: number }> = [];
		const writeCalls: Array<{ call: { tool: string; parameters: any }; idx: number }> = [];
		validCalls.forEach((call, idx) => {
			if (WRITE_TOOLS_IN_BATCH.has(call.tool)) {
				writeCalls.push({ call, idx });
			} else {
				readOnlyCalls.push({ call, idx });
			}
		});

		// 并行执行只读子工具
		const readOnlySubToolUses = readOnlyCalls.map(({ call, idx }) => ({
			id: `${toolUse.id}_sub_${idx}`,
			name: call.tool,
			input: call.parameters ?? {}
		}));
		for (const subToolUse of readOnlySubToolUses) {
			this.emitToolTraceCall(subToolUse, 'batch');
		}
		const readResults = await this.executeToolsInParallel(readOnlySubToolUses) as ToolResultContentBlock[];

		// 顺序执行写入子工具（走 executeSingleTool，包含用户确认流程）
		const writeResultMap = new Map<number, ToolResultContentBlock>();
		for (const { call, idx } of writeCalls) {
			const subToolUse = {
				id: `${toolUse.id}_sub_${idx}`,
				name: call.tool,
				input: call.parameters ?? {}
			};
			const singleResult = await this.executeSingleTool(subToolUse);
			if (singleResult.toolResult) {
				writeResultMap.set(idx, singleResult.toolResult as ToolResultContentBlock);
			} else {
				writeResultMap.set(idx, {
					type: 'tool_result',
					tool_use_id: subToolUse.id,
					content: '用户拒绝了工具执行',
					is_error: true
				} as ToolResultContentBlock);
			}
			// 如果子工具触发了流程终止，直接中止 batch
			if (singleResult.shouldEndLoop) {
				this._onToolCompleted.fire({ toolId: toolUse.id, toolName: 'batch', isError: false });
				return { shouldContinue: singleResult.shouldContinue, shouldEndLoop: true };
			}
		}

		// 按原始顺序合并结果
		const subResults: ToolResultContentBlock[] = validCalls.map((call, idx) => {
			if (WRITE_TOOLS_IN_BATCH.has(call.tool)) {
				return writeResultMap.get(idx)!;
			}
			const readIdx = readOnlyCalls.findIndex(r => r.idx === idx);
			return readResults[readIdx] ?? {
				type: 'tool_result',
				tool_use_id: `${toolUse.id}_sub_${idx}`,
				content: `batch: 子工具 ${call.tool} 未返回结果`,
				is_error: true
			} as ToolResultContentBlock;
		});

		// 格式化批量结果（与原 BatchToolExecutor.formatBatchResponse 保持一致）
		const parts: string[] = [];
		let successful = 0;
		let failed = 0;

		for (let i = 0; i < subResults.length; i++) {
			const subResult = subResults[i];
			const callName = validCalls[i]?.tool ?? 'unknown';
			this.emitToolTraceResult(subResult.tool_use_id, callName, subResult.content, !!subResult.is_error, 'batch');
			if (subResult.is_error) {
				parts.push(`[${callName}] 失败: ${subResult.content}`);
				failed++;
			} else {
				parts.push(`[${callName}] 成功:\n${subResult.content}`);
				successful++;
			}
		}

		// 添加被过滤的禁止工具的错误提示
		for (const invalidCall of invalidCalls) {
			this.emitToolTraceResult(
				`${toolUse.id}_invalid_${invalidCall.tool}`,
				invalidCall.tool,
				'该工具不允许在 batch 中使用',
				true,
				'batch'
			);
			parts.push(`[${invalidCall.tool}] 失败: 该工具不允许在 batch 中使用`);
			failed++;
		}

		const summary = failed === 0
			? `✅ All ${successful} tools executed successfully.\n\nKeep using the batch tool for optimal performance!`
			: `⚠️ Partially successful: ${successful}/${subResults.length + invalidCalls.length} succeeded, ${failed} failed.`;

		const combinedContent = parts.join('\n\n---\n\n') + `\n\n${summary}`;

		this.toolUsage['batch'] = (this.toolUsage['batch'] || 0) + 1;
		this.consecutiveMistakeCount = 0;
		this._onToolCompleted.fire({ toolId: toolUse.id, toolName: 'batch', isError: false });

		return {
			shouldContinue: true,
			shouldEndLoop: false,
			toolResult: {
				type: 'tool_result',
				tool_use_id: toolUse.id,
				content: combinedContent,
				is_error: false
			}
		};
	}

	/**
	 * 写入工具执行后使相关缓存失效
	 */
	/**
	 * 会修改文件的工具集合（用于 LSP 诊断注入）
	 * 参考 OpenCode tool/write.ts：写入后自动查询 LSP 诊断
	 */
	private static readonly WRITE_TOOLS = new Set([
		'write_to_file', 'apply_diff', 'edit', 'edit_file', 'insert_content', 'multiedit', 'patch',
	]);

	/**
	 * 写文件操作前需要创建 checkpoint 的工具集合（功能1）
	 */
	private static readonly CHECKPOINT_BEFORE_TOOLS = new Set([
		'edit', 'multiedit', 'write_to_file', 'apply_diff',
	]);

	/**
	 * 提取写入工具影响的文件绝对路径列表
	 */
	private extractWriteToolFilePaths(toolUse: { name: string; input: any }): string[] {
		const params = toolUse.input;
		const resolve = (p: string) => {
			if (!p) { return ''; }
			if (p.startsWith('/')) { return p; }
			return `${this.workspaceRoot.replace(/\/$/, '')}/${p}`;
		};

		switch (toolUse.name) {
			case 'write_to_file':
			case 'apply_diff':
			case 'edit':
			case 'multiedit':
			case 'insert_content': {
				const p = resolve(params.path);
				return p ? [p] : [];
			}
			case 'edit_file': {
				const p = resolve(params.target_file);
				return p ? [p] : [];
			}
			case 'patch': {
				try {
					const patches: Array<{ path: string }> = typeof params.patches === 'string'
						? JSON.parse(params.patches)
						: (params.patches || []);
					return patches.map(p => resolve(p.path)).filter(Boolean);
				} catch {
					return [];
				}
			}
			default:
				return [];
		}
	}

	/**
	 * 追踪文件变更（write/delete工具执行成功后调用）
	 */
	private trackFileChange(toolUse: { name: string; input: any }, affectedPaths?: string[]): void {
		const params = toolUse.input;
		if (!params) { return; }

		if (toolUse.name === 'delete_file') {
			const path = this.normalizeWorkspacePath(params.path as string);
			if (path) {
				this.fileChangesDeleted.add(path);
				this.fileChangesWritten.delete(path); // 先创建后删除 → 只保留删除
			}
		} else if (TaskService.WRITE_TOOLS.has(toolUse.name)) {
			const paths = (affectedPaths && affectedPaths.length > 0)
				? affectedPaths.map(currentPath => this.normalizeWorkspacePath(currentPath)).filter(Boolean)
				: this.extractWriteToolFilePaths(toolUse);
			for (const p of paths) {
				if (p) {
					this.fileChangesWritten.add(p);
					const prevWriteCount = this.fileWriteCountTracker.get(p) || 0;
					this.fileWriteCountTracker.set(p, prevWriteCount + 1);
				}
			}
		}
	}

	private checkSameFileWriteBudget(toolUse: { name: string; input: any }): string | null {
		if (!TaskService.WRITE_TOOLS.has(toolUse.name)) {
			return null;
		}

		const targetPaths = this.extractWriteToolFilePaths(toolUse)
			.map(currentPath => this.normalizeWorkspacePath(currentPath))
			.filter(Boolean);

		if (targetPaths.length === 0) {
			return null;
		}
		this.pruneNoProgressWriteTracker(targetPaths);

		const currentSignature = this.buildWriteSignature(toolUse);
		for (const targetPath of targetPaths) {
			const noProgressState = this.fileNoProgressWriteTracker.get(targetPath);
			if (noProgressState && noProgressState.signature === currentSignature) {
				if (noProgressState.count >= TaskService.SAME_SIGNATURE_BLOCK_AFTER) {
					return this.buildUnifiedRecoveryHint('same_signature_block', targetPath);
				}
				if (noProgressState.count >= TaskService.SAME_SIGNATURE_GUIDANCE_AFTER) {
					return this.buildUnifiedRecoveryHint('same_signature_guidance', targetPath);
				}
			}
		}

		const overBudgetPath = targetPaths.find(currentPath => (this.fileWriteCountTracker.get(currentPath) || 0) >= TaskService.MAX_WRITES_PER_FILE);
		if (!overBudgetPath) {
			return null;
		}

		const writeCount = this.fileWriteCountTracker.get(overBudgetPath) || 0;
		return `[GUIDANCE] 文件 "${overBudgetPath}" 在本轮已产生 ${writeCount} 次有效写入。请避免继续在同文件细碎改动：\n1. 同文件剩余修改合并为一次 multiedit\n2. 若目标已实现，read_file 一次确认后 attempt_completion\n3. 若问题已转移，优先检查调用方/配置入口/引用方`;
	}

	private checkWriteAttemptBudget(toolUse: { name: string; input: any }): string | null {
		if (!TaskService.WRITE_TOOLS.has(toolUse.name)) {
			return null;
		}

		const targetPaths = this.extractWriteToolFilePaths(toolUse)
			.map(currentPath => this.normalizeWorkspacePath(currentPath))
			.filter(Boolean);
		if (targetPaths.length === 0) {
			return null;
		}

		if (this.totalWriteToolAttemptCount >= TaskService.MAX_TOTAL_WRITE_ATTEMPTS) {
			return `[BLOCK] 当前任务写入尝试次数已达到 ${this.totalWriteToolAttemptCount} 次，系统判定进入高风险反复修改回路，已停止继续写入。\n\n请改用以下路径推进：\n1. 若核心功能已实现，直接总结并 attempt_completion\n2. 若仍有问题，先收敛到明确单点，再进行一次最小修改\n3. 必要时向用户确认优先级，避免继续大范围反复改动`;
		}

		let warningPath = '';
		let warningCount = 0;
		for (const targetPath of targetPaths) {
			const currentCount = this.fileWriteAttemptCountTracker.get(targetPath) || 0;
			if (currentCount >= TaskService.HARD_WRITE_ATTEMPT_BLOCK_AFTER) {
				return `[BLOCK] 文件 "${targetPath}" 的写入尝试次数已达到 ${currentCount} 次（含失败重试），系统判定为重复回路并停止继续写入该文件。\n\n请立即切换策略：\n1. 不再继续同文件重试，转查调用方/配置入口/引用方\n2. 先 read_file 一次确认当前最终内容，再决定是否收尾\n3. 若必须继续修改，只允许一次合并后的最小补丁（multiedit）`;
			}
			if (currentCount >= TaskService.MAX_WRITE_ATTEMPTS_PER_FILE && currentCount > warningCount) {
				warningPath = targetPath;
				warningCount = currentCount;
			}
		}

		if (warningPath) {
			return `[GUIDANCE] 文件 "${warningPath}" 的写入尝试已达 ${warningCount} 次（含失败重试），接近循环阈值。\n\n请优先执行：\n1. 重新确认是否还在修同一个问题\n2. 将同文件剩余改动合并为一次 multiedit\n3. 若问题已转移，立即改查其他文件`;
		}

		return null;
	}

	private recordWriteAttemptOutcome(
		toolUse: { name: string; input: any },
		execution: ToolExecutionResult,
		feedbackContent?: string
	): void {
		if (!TaskService.WRITE_TOOLS.has(toolUse.name)) {
			return;
		}

		const targetPaths = this.extractWriteToolFilePaths(toolUse)
			.map(currentPath => this.normalizeWorkspacePath(currentPath))
			.filter(Boolean);
		if (targetPaths.length === 0) {
			return;
		}

		const currentSignature = this.buildWriteSignature(toolUse);
		const wroteSuccessfully = execution.success && execution.metadata?.didWrite;
		if (wroteSuccessfully) {
			// 登记到"本任务已修改文件"集合，在上下文压缩时注入提醒给模型
			for (const targetPath of targetPaths) {
				this.recentlyModifiedFiles.add(targetPath);
			}
			let recoveredAttempts = 0;
			for (const targetPath of targetPaths) {
				recoveredAttempts += this.fileWriteAttemptCountTracker.get(targetPath) || 0;
				this.fileWriteAttemptCountTracker.delete(targetPath);
				this.fileNoProgressWriteTracker.delete(targetPath);
			}
			if (recoveredAttempts > 0 && this.totalWriteToolAttemptCount > 0) {
				this.totalWriteToolAttemptCount = Math.max(0, this.totalWriteToolAttemptCount - recoveredAttempts);
			}
			return;
		}

		if (execution.success) {
			this.updateNoProgressWriteTracker(targetPaths, currentSignature, toolUse.name);
			return;
		}

		const normalizedFeedback = (feedbackContent || execution.error || '').toLowerCase();
		const shouldCountFailure = this.shouldCountWriteFailureAttempt(normalizedFeedback);
		this.updateNoProgressWriteTracker(targetPaths, currentSignature, toolUse.name);
		if (!shouldCountFailure) {
			return;
		}

		this.totalWriteToolAttemptCount++;
		for (const targetPath of targetPaths) {
			const nextCount = (this.fileWriteAttemptCountTracker.get(targetPath) || 0) + 1;
			this.fileWriteAttemptCountTracker.set(targetPath, nextCount);
		}
	}

	private shouldCountWriteFailureAttempt(feedback: string): boolean {
		if (!feedback) {
			return true;
		}

		const ignorePatterns = [
			'用户拒绝',
			'approval required',
			'等待用户确认',
			'oldstring not found in content',
			'found multiple matches for oldstring',
			'file has not been read yet',
			'file has only been partially read',
			'file has been modified since read',
			'预检查失败',
			'未产生任何修改',
			'内容完全一致',
			'batch.tool_calls',
			'tool_calls 为空或格式无效',
		];

		return !ignorePatterns.some(pattern => feedback.includes(pattern));
	}

	private updateNoProgressWriteTracker(paths: string[], signature: string, toolName: string): void {
		this.pruneNoProgressWriteTracker(paths);
		const now = Date.now();
		for (const targetPath of paths) {
			const previous = this.fileNoProgressWriteTracker.get(targetPath);
			if (!previous || previous.signature !== signature) {
				this.fileNoProgressWriteTracker.set(targetPath, {
					signature,
					count: 1,
					tool: toolName,
					updatedAt: now
				});
				continue;
			}
			this.fileNoProgressWriteTracker.set(targetPath, {
				signature,
				count: previous.count + 1,
				tool: toolName,
				updatedAt: now
			});
		}
	}

	private pruneNoProgressWriteTracker(paths?: string[]): void {
		const now = Date.now();
		const shouldDelete = (state: { updatedAt: number }): boolean =>
			(now - state.updatedAt) > TaskService.NO_PROGRESS_WRITE_TRACKER_TTL_MS;

		if (paths && paths.length > 0) {
			for (const currentPath of paths) {
				const state = this.fileNoProgressWriteTracker.get(currentPath);
				if (state && shouldDelete(state)) {
					this.fileNoProgressWriteTracker.delete(currentPath);
				}
			}
			return;
		}

		for (const [currentPath, state] of this.fileNoProgressWriteTracker.entries()) {
			if (shouldDelete(state)) {
				this.fileNoProgressWriteTracker.delete(currentPath);
			}
		}
	}

	private buildWriteSignature(toolUse: { name: string; input: any }): string {
		const normalizedInput = this.normalizeForWriteSignature(toolUse.input);
		return JSON.stringify({
			name: toolUse.name,
			input: normalizedInput
		});
	}

	private normalizeForWriteSignature(value: any): any {
		if (Array.isArray(value)) {
			return value.map(item => this.normalizeForWriteSignature(item));
		}
		if (!value || typeof value !== 'object') {
			return value;
		}
		const sortedKeys = Object.keys(value).sort();
		const result: Record<string, any> = {};
		for (const key of sortedKeys) {
			// 与语义无关的执行控制参数不参与签名
			if (key === 'requires_approval' || key === 'description') {
				continue;
			}
			result[key] = this.normalizeForWriteSignature((value as Record<string, any>)[key]);
		}
		return result;
	}

	private buildUnifiedRecoveryHint(
		type: 'same_signature_guidance' | 'same_signature_block' | 'malformed_batch',
		target: string
	): string {
		if (type === 'malformed_batch') {
			return `[RECOVER] batch 参数解析失败（${target} 无效）。请按统一恢复路径处理：\n1. 只保留有效 JSON：{"tool_calls":[{"tool":"read_file","parameters":{"path":"..."}}]}\n2. 不要重复发送同一损坏参数；先最小化为 1-2 个可验证调用\n3. 若目标已明确，优先直接使用 read_file/edit/multiedit 推进`;
		}

		if (type === 'same_signature_block') {
			return `[BLOCK] 文件 "${target}" 已连续收到等价写入请求，系统判定为无效重试并停止继续写入。\n\n统一恢复路径：\n1. 先 read_file 确认当前内容是否已包含目标改动\n2. 若已生效，直接 attempt_completion\n3. 若未生效，必须生成“不同签名”的最小补丁（不要换工具重复同一改动）`;
		}

		return `[GUIDANCE] 文件 "${target}" 刚发生一次无进展写入（等价签名）。\n\n统一恢复路径：\n1. 先 read_file 校验当前状态\n2. 若改动已在文件中，停止重复写入并继续后续步骤\n3. 若需要继续修改，合并为一次新的最小补丁（参数必须与上次不同）`;
	}

	/**
	 * 获取本次任务的文件变更汇总
	 */
	public getFileChanges(): { written: string[]; deleted: string[] } {
		return {
			written: Array.from(this.fileChangesWritten),
			deleted: Array.from(this.fileChangesDeleted)
		};
	}

	private invalidateCacheForWriteTool(
		toolUse: { id: string; name: string; input: any },
		affectedPaths?: string[],
		metadata?: { unknownWrite?: boolean; shouldInvalidateSearchCache?: boolean; shouldResetReadTracking?: boolean }
	): void {
		const isKnownWriteTool = TaskService.WRITE_TOOLS.has(toolUse.name) || toolUse.name === 'delete_file' || toolUse.name === 'create_directory';
		const shouldInvalidate = isKnownWriteTool || metadata?.unknownWrite || metadata?.shouldInvalidateSearchCache;
		if (!shouldInvalidate) {
			return;
		}

		const hasConcretePaths = Array.isArray(affectedPaths) && affectedPaths.length > 0;
		if (metadata?.unknownWrite || (!hasConcretePaths && toolUse.name === 'execute_command')) {
			// execute_command 等非结构化写入场景：保守清空缓存，避免读到旧内容。
			this.toolCache.clear();
			if (metadata?.shouldResetReadTracking !== false) {
				this.resetFileReadTracker();
			}
			return;
		}

		const paths = hasConcretePaths
			? (affectedPaths as string[])
			: this.extractWriteToolFilePaths(toolUse);

		if (paths.length === 0) {
			this.toolCache.clear();
			if (metadata?.shouldResetReadTracking !== false) {
				this.resetFileReadTracker();
			}
			return;
		}

			const normalizedPaths = paths
				.map(currentPath => this.normalizeWorkspacePath(currentPath))
				.filter(Boolean);

			for (const filePath of normalizedPaths) {
				this.toolCache.invalidateFile(filePath);

				const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
				if (dirPath) {
					this.toolCache.invalidateDirectory(dirPath);
				}
			}

			// 同步驱动 ToolExecutor 的提交态清理（含 search_files 缓存失效），
			// 避免 didWrite 判定偏差时出现“文件已删但搜索仍命中”的短暂旧结果。
			const detailedExecutor = this.toolExecutor as IToolExecutor & {
				clearCommittedStateForPaths?: (paths: string[]) => void;
			};
			if (normalizedPaths.length > 0) {
				detailedExecutor.clearCommittedStateForPaths?.(normalizedPaths);
			}

		if (metadata?.shouldResetReadTracking) {
			this.resetFileReadTracker();
		}
	}

	/**
	 * read_file 重复读取策略：
	 * - 已修改文件：禁止再用 read_file 做确认性回读
	 * - 同一路径同一范围：第 2 次优先复用缓存/底层 stub，第 3 次起视为循环
	 * - 同一路径不同范围：允许继续读取，避免误伤正常的补充定位
	 */
	private checkDuplicateFileRead(toolName: string, params: any): DuplicateFileReadCheckResult | null {
		if (toolName !== 'read_file') {
			return null;
		}

		const filePath = this.normalizeWorkspacePath(params.path);
		if (!filePath) {
			return null;
		}

		const fileReadCount = this.fileReadTracker.get(filePath) || 0;
		this.fileReadTracker.set(filePath, fileReadCount + 1);

		const requestKey = this.buildReadFileRequestKey(filePath, params);
		const requestCount = this.readFileRequestTracker.get(requestKey) || 0;
		this.readFileRequestTracker.set(requestKey, requestCount + 1);

		if (this.fileChangesWritten.has(filePath)) {
			if (requestCount === 0) {
				return null;
			}
			if (requestCount === 1) {
				return {
					filePath,
					requestKey,
					message: `[GUIDANCE] 文件 "${filePath}" 本轮已被修改。你已完成一次确认读取，请优先基于当前内容继续推进，不要再次围绕同一 read_file 重试。`,
					isError: false,
					preferCachedContent: true,
				};
			}
			if (requestCount === 2) {
				return {
					filePath,
					requestKey,
					message: `[GUIDANCE] 文件 "${filePath}" 已出现“修改后反复确认读取”的趋势。下一步请直接修改关联文件或总结结果，不要继续对同一路径重复 read_file。`,
					isError: false,
					activateRedirect: true,
				};
			}
			return {
				filePath,
				requestKey,
				message: `[BLOCK] 文件 "${filePath}" 已在修改后被重复 read_file ${requestCount + 1} 次。系统判定为回读空转，当前回合禁止继续该读取请求。\n\n请改用其他推进方式：\n1. 基于已有修改继续后续步骤\n2. 查调用方/引用方/配置入口等其他明确文件\n3. 必要时直接 edit/multiedit，不要再回读确认`,
				isError: true,
				activateRedirect: true,
			};
		}

		if (requestCount === 0) {
			return null;
		}

		if (requestCount === 1) {
			return {
				filePath,
				requestKey,
				message: `[DUPLICATE_READ] 文件 "${filePath}" 的同一 read_file 请求已执行过一次。若缓存命中请直接复用；若缓存未命中，本次读取后请立即推进，不要继续重试同一请求。`,
				isError: false,
				preferCachedContent: true,
			};
		}

		if (requestCount === 2) {
			return {
				filePath,
				requestKey,
				message: `[GUIDANCE] 文件 "${filePath}" 的同一 read_file 请求已重复 3 次。请停止同请求重试，改为读取其他相关文件或直接基于已有内容继续修改。`,
				isError: false,
				activateRedirect: true,
			};
		}

		return {
			filePath,
			requestKey,
			message: `[BLOCK] 文件 "${filePath}" 的同一 read_file 请求已重复执行 ${requestCount + 1} 次。系统判定为读取空转，当前回合禁止继续同一路径同一范围重试。\n\n请改为：\n1. 直接使用已有内容继续修改或总结\n2. 如仍缺信息，读取其他明确相关文件`,
			isError: true,
			activateRedirect: true,
		};
	}

	private buildReadFileRequestKey(filePath: string, params: any): string {
		const startLine = params?.start_line ?? '';
		const endLine = params?.end_line ?? '';
		return `${filePath}::${startLine}-${endLine}`;
	}

	private handleDuplicateFileReadIntervention(result: DuplicateFileReadCheckResult): void {
		if (!result.activateRedirect || this.duplicateReadRedirectTracker.has(result.requestKey)) {
			return;
		}

		this.duplicateReadRedirectTracker.add(result.requestKey);
		this.mainThreadExplorationGuardActive = true;
		this.pushHistory({
			role: 'system',
			content: `你刚刚对 "${result.filePath}" 的 read_file 已经进入重复/空转状态。\n\n这是系统内部纠偏提示，不要把这段话原样回复给用户。下一步只能：\n1. 直接基于已拿到的内容继续修改或给出结论\n2. 如果仍缺依据，只去看调用方、引用方、配置入口或报错来源等其他明确文件\n3. 如果该文件已在本任务中修改过，禁止再用 read_file 回读确认\n\n不要再继续同一个 read_file 请求，也不要再围绕这个文件空转。`
		});
	}

	private normalizeWorkspacePath(filePath?: string): string {
		if (!filePath) {
			return '';
		}
		const normalizedInput = filePath.replace(/^file:\/\//, '');
		const absolutePath = normalizedInput.startsWith('/')
			? normalizedInput
			: `${this.workspaceRoot.replace(/\/$/, '')}/${normalizedInput.replace(/^\.\//, '')}`;
		return path.normalize(absolutePath);
	}

	private normalizeToolCacheInput(input: any): any {
		if (Array.isArray(input)) {
			return input.map(item => this.normalizeToolCacheInput(item));
		}

		if (!input || typeof input !== 'object') {
			return input;
		}

		const normalized: Record<string, any> = {};
		for (const [key, value] of Object.entries(input)) {
			if (typeof value === 'string' && ['path', 'cwd', 'target_file'].includes(key)) {
				normalized[key] = this.normalizeWorkspacePath(value);
				continue;
			}
			normalized[key] = this.normalizeToolCacheInput(value);
		}

		return normalized;
	}

	private buildExplorationFingerprints(toolUses: Array<{ id: string; name: string; input: any }>): string[] {
		const fingerprints = new Set<string>();

		const addFingerprint = (toolName: string, input: any) => {
			switch (toolName) {
				case 'read_file':
					fingerprints.add(`read:${this.normalizeWorkspacePath(input?.path)}`);
					break;
				case 'list_files':
					fingerprints.add(`list:${this.normalizeWorkspacePath(input?.path)}:${input?.recursive ?? 'false'}:${input?.max_depth ?? ''}`);
					break;
				case 'glob':
					fingerprints.add(`glob:${this.normalizeWorkspacePath(input?.path)}:${input?.file_pattern ?? ''}`);
					break;
				case 'search_files':
					fingerprints.add(`search:${this.normalizeWorkspacePath(input?.path)}:${input?.regex ?? ''}:${input?.file_pattern ?? ''}`);
					break;
				case 'codebase_search':
					fingerprints.add(`codebase:${this.normalizeWorkspacePath(input?.path)}:${input?.query ?? ''}:${input?.file_pattern ?? ''}`);
					break;
				case 'skill':
					fingerprints.add(`skill:${JSON.stringify(input ?? {})}`);
					break;
				default:
					fingerprints.add(`${toolName}:${JSON.stringify(this.normalizeToolCacheInput(input))}`);
					break;
			}
		};

		for (const toolUse of toolUses) {
			if (toolUse.name === 'batch') {
				try {
					const rawCalls = toolUse.input?.tool_calls;
					const calls: Array<{ name: string; params?: any; input?: any }> = typeof rawCalls === 'string'
						? JSON.parse(rawCalls)
						: (Array.isArray(rawCalls) ? rawCalls : []);
					for (const call of calls) {
						addFingerprint(call.name, call.params ?? call.input ?? {});
					}
				} catch {
					fingerprints.add(`batch:${JSON.stringify(this.normalizeToolCacheInput(toolUse.input))}`);
				}
				continue;
			}

			addFingerprint(toolUse.name, toolUse.input);
		}

		return Array.from(fingerprints);
	}

	private resetExplorationProgress(): void {
		this.consecutiveNoProgressExplorationRounds = 0;
		this.explorationFingerprintsSeen.clear();
		this.mainThreadSearchBurstCount = 0;
	}

	private normalizeTextValue(value: unknown): string {
		return typeof value === 'string' ? value.trim() : '';
	}

	private getExplorationBlockReason(toolUses: Array<{ id: string; name: string; input: any }>): string | null {
		const fingerprints = this.buildExplorationFingerprints(toolUses);
		const hasNewInformation = fingerprints.some(fingerprint => !this.explorationFingerprintsSeen.has(fingerprint));

		for (const fingerprint of fingerprints) {
			this.explorationFingerprintsSeen.add(fingerprint);
		}

		if (hasNewInformation) {
			this.consecutiveNoProgressExplorationRounds = 0;
			return null;
		}

		this.consecutiveNoProgressExplorationRounds++;
		if (this.consecutiveNoProgressExplorationRounds < this.NO_PROGRESS_EXPLORATION_THRESHOLD) {
			return null;
		}

		return `检测到连续 ${this.consecutiveNoProgressExplorationRounds} 轮只读探索都没有获得新的文件或搜索线索，当前策略已无进展。\n\n立即停止继续读取/搜索同一批目标，改用不同策略：\n1. 重新定位目标文件路径或模块边界\n2. 直接对已确认的目标文件执行修改\n3. 如果需要大范围重构或删功能，先询问用户`;
	}

	private isLikelyInternalMetaResponse(message: string): boolean {
		if (!message) {
			return false;
		}

		const suspiciousPatterns = [
			/不要把这段话原样回复给用户/,
			/系统内部纠偏提示/,
			/只读探索/,
			/主线程/,
			/宽泛搜索/,
			/task\(explore\)/,
			/subagent_type="explore"/,
			/下一轮必须/,
			/改用不同策略/,
			/继续读取\/搜索同一批目标/,
			/等待同一 task_id/,
			/不要重复派发/,
			/子 Agent .*正在执行中/,
		];

		return suspiciousPatterns.some(pattern => pattern.test(message));
	}

	// @ts-ignore 保留这段策略文案，供后续重新启用更温和的探索重定向时复用
	private getExplorationRedirectReason(toolUses: Array<{ id: string; name: string; input: any }>): string | null {
		if (this.fileChangesWritten.size > 0) {
			return null;
		}

		if (this.consecutiveReadOnlyRounds < this.EXPLORATION_REDIRECT_ROUNDS) {
			return null;
		}

		const filesRead = this.fileReadTracker.size;
		if (filesRead < this.EXPLORATION_REDIRECT_MIN_FILES) {
			return null;
		}

		const containsBroadExploration = toolUses.some(toolUse => {
			if (this.MAIN_THREAD_SEARCH_TOOLS.has(toolUse.name)) {
				return true;
			}
			if (toolUse.name !== 'batch') {
				return false;
			}
			try {
				const rawCalls = toolUse.input?.tool_calls;
				const calls: Array<{ tool?: string; name?: string }> = typeof rawCalls === 'string'
					? JSON.parse(rawCalls)
					: (Array.isArray(rawCalls) ? rawCalls : []);
				return calls.some(call => this.MAIN_THREAD_SEARCH_TOOLS.has(call.tool || call.name || ''));
			} catch {
				return false;
			}
		});

		if (!containsBroadExploration) {
			return null;
		}

		return `你已经完成 ${this.consecutiveReadOnlyRounds} 轮只读探索，并且已读取 ${filesRead} 个文件。参照 Claude Code / OpenCode 的调度逻辑，不要继续在主线程做宽泛搜索（glob/search_files/codebase_search/list_files）。\n\n下一轮应优先基于已有结果推进：\n1. 如果目标文件已明确：直接修改已确认的目标文件\n2. 如果还缺少少量依据：只读取明确目标文件，不要继续宽搜\n3. 只有当调查明显跨模块、需要独立多轮探索时，才考虑使用 task 工具，subagent_type="explore"\n\n禁止继续在主线程里围绕同一批搜索工具兜圈子。`;
	}

	private isBlockingGuardMessage(message: string): boolean {
		return message.startsWith('[BLOCK]');
	}

	private emitRuntimeGuidanceOnce(key: string, message: string): void {
		if (this.runtimeGuidanceKeys.has(key)) {
			return;
		}
		this.runtimeGuidanceKeys.add(key);
		this.pushHistory({
			role: 'system',
			content: message
		});
	}

	private checkMainThreadExplorationGuard(toolUse: { id: string; name: string; input: any }): string | null {
		const prematureExploreMessage = this.checkPrematureExploreDelegation(toolUse);
		if (prematureExploreMessage) {
			return prematureExploreMessage;
		}

		const isBroadSearch = this.isBroadSearchToolCall(toolUse);
		if (isBroadSearch) {
			this.mainThreadSearchBurstCount++;
		}

		if (!this.mainThreadExplorationGuardActive) {
			return null;
		}

		if (toolUse.name === 'task') {
			return null;
		}

		if (!isBroadSearch) {
			return null;
		}

		const maxBursts = this.explorationBudget.maxMainThreadSearchBursts;
		if (this.mainThreadSearchBurstCount <= maxBursts) {
			return null;
		}

		if (this.mainThreadSearchBurstCount <= maxBursts + 2) {
			return `[GUIDANCE] 主线程宽搜 ${this.mainThreadSearchBurstCount} 次，超过预算 ${maxBursts}。\n请收敛：优先改已确认文件；缺证据时只读明确文件；确属跨模块再用 task(explore)。`;
		}

		return `[BLOCK] 主线程宽搜 ${this.mainThreadSearchBurstCount} 次且未收敛，当前回合禁止继续 glob/search_files/codebase_search/list_files（含 batch）。请先基于已有结果推进实现或收尾。`;
	}

	private checkPrematureExploreDelegation(toolUse: { id: string; name: string; input: any }): string | null {
		if (toolUse.name !== 'task') {
			return null;
		}

		const subagentType = this.normalizeTextValue(toolUse.input?.subagent_type ?? '');
		if (subagentType !== 'explore') {
			return null;
		}

		if (toolUse.input?.task_id) {
			return null;
		}

		if (this.fileChangesWritten.size > 0) {
			return null;
		}

		const filesRead = this.fileReadTracker.size;
		const hasMainThreadNarrowing =
			filesRead >= this.explorationBudget.minFilesBeforeDelegation &&
			this.consecutiveReadOnlyRounds >= this.explorationBudget.minReadOnlyRoundsBeforeDelegation;
		if (hasMainThreadNarrowing || this.mainThreadExplorationGuardActive) {
			return null;
		}

		const rawPrompt = this.normalizeTextValue(toolUse.input?.prompt ?? toolUse.input?.task ?? '');
		const asksForBroadSurvey = /(完整结构|整体架构|所有(?:java)?文件|所有实现|所有类|完整返回|全部文件|整个模块|模块的所有|完整分析)/.test(rawPrompt);
		const firstRounds = this.totalApiRounds <= this.explorationBudget.maxMainThreadSearchBursts;
		const hasAnyMainThreadWork = filesRead > 0 || this.consecutiveReadOnlyRounds > 0;

		if (asksForBroadSurvey && hasAnyMainThreadWork) {
			return null;
		}

		if (!firstRounds && !asksForBroadSurvey) {
			return null;
		}

		return `[GUIDANCE] 暂不建议直接 task(explore)：主线程尚未完成 ${this.explorationBudget.minReadOnlyRoundsBeforeDelegation} 轮只读收敛，且关键文件少于 ${this.explorationBudget.minFilesBeforeDelegation} 个。\n先在主线程缩小范围并读取关键文件，确认仍跨模块再委托 explore。`;
	}

	private isBroadSearchToolCall(toolUse: { name: string; input: any }): boolean {
		if (this.MAIN_THREAD_SEARCH_TOOLS.has(toolUse.name)) {
			return true;
		}

		if (toolUse.name !== 'batch') {
			return false;
		}

		try {
			const rawCalls = toolUse.input?.tool_calls;
			const calls: Array<{ tool?: string; name?: string }> = typeof rawCalls === 'string'
				? JSON.parse(rawCalls)
				: (Array.isArray(rawCalls) ? rawCalls : []);
			return calls.some(call => this.MAIN_THREAD_SEARCH_TOOLS.has(call.tool || call.name || ''));
		} catch {
			return false;
		}
	}

	private shouldCacheReadOnlyResult(toolName: string, content: string): boolean {
		// search_files/codebase_search 的结果高度依赖实时文件状态；
		// 避免 batch 子工具命中全局缓存后返回已删除文件的旧结果。
		if (toolName === 'search_files' || toolName === 'codebase_search') {
			return false;
		}
		const normalized = content.trim();
		if (!normalized) {
			return false;
		}
		return !(
			normalized.includes('<error>') ||
			normalized.includes('<fatal_error>') ||
			normalized.startsWith('错误:') ||
			normalized.startsWith('编辑失败:') ||
			normalized.startsWith('多处编辑失败:') ||
			normalized.startsWith('搜索文件失败:') ||
			normalized.startsWith('代码库搜索失败:') ||
			normalized.startsWith('工具 ')
		);
	}

	private buildMutationRecoveryHint(toolUse: { name: string; input: any }, failureContent: string): string | null {
		if (!TaskService.WRITE_TOOLS.has(toolUse.name)) {
			return null;
		}

		const normalized = failureContent.trim();
		const targetPath = this.extractWriteToolFilePaths(toolUse)[0] || toolUse.input?.path || toolUse.input?.target_file || '当前文件';

		const staleContentFailure =
			normalized.includes('oldString not found in content') ||
			normalized.includes('Found multiple matches for oldString') ||
			normalized.includes('SEARCH块') ||
			normalized.includes('必须与文件内容完全匹配');

		const mutationReadinessFailure =
			normalized.includes('File has not been read yet') ||
			normalized.includes('File has only been partially read') ||
			normalized.includes('File has been modified since read') ||
			normalized.includes('预检查失败');

		const idempotentMutationFailure =
			normalized.includes('apply_diff 未产生任何修改') ||
			normalized.includes('最可能的原因：修改已存在于文件中') ||
			normalized.includes('write_to_file 未产生任何修改') ||
			normalized.includes('内容完全一致') ||
			normalized.includes('edit 未产生任何修改') ||
			normalized.includes('old_string 与 new_string 完全相同');

		if (!staleContentFailure && !mutationReadinessFailure && !idempotentMutationFailure) {
			return null;
		}

		if (idempotentMutationFailure) {
			return `[RECOVER] ${targetPath} 出现“无进展写入”（no-op/内容一致）。\n1. 先 read_file 确认当前文件\n2. 若目标已实现，直接 attempt_completion\n3. 若未实现，生成不同签名的最小补丁，不要重复提交同一 old_string/SEARCH 块`;
		}

		if (staleContentFailure) {
			return `[RECOVER] ${targetPath} 的写入基于过期定位（old_string/SEARCH 不匹配）。\n1. 先完整 read_file 当前版本\n2. 同文件剩余改动合并为一次 multiedit\n3. 若错误已转移，改查调用方/配置入口，不要继续同块重试`;
		}

		return `[RECOVER] ${targetPath} 当前不满足安全修改条件（读写前置条件未满足）。\n1. 先完整 read_file 当前版本，确保上下文新鲜\n2. 不要继续同类写入重试\n3. 只在必要时提交一次合并后的最小修改`;
	}

	private parseLegacyInteractionFromResult(result: unknown): ToolInteractionRequest | undefined {
		if (typeof result !== 'string') {
			return undefined;
		}

		const approvalPayload = parseLegacyApprovalRequired(result);
		if (approvalPayload) {
			return {
				type: 'approval',
				payload: approvalPayload
			};
		}

		const followupPayload = parseLegacyFollowupRequired(result);
		if (followupPayload) {
			return {
				type: 'followup',
				payload: followupPayload
			};
		}

		return undefined;
	}

	private async handleFollowupInteraction(
		toolUseId: string,
		payload: { question: string; options: Array<{ label: string; description: string; value: string }> }
	): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
		toolResult?: ToolResultContentBlock;
	}> {
		const normalizedOptions = ensureFollowupOptions(payload.options);
		const askExtra: Partial<ClineMessage> = {
			metadata: {
				kiloCode: {
					options: normalizedOptions
				}
			}
		};

		const { response, text } = await this.ask('followup', payload.question, undefined, undefined, askExtra);
		if (response === 'messageResponse') {
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUseId,
					content: `用户回复: ${text}`,
					is_error: false
				}
			};
		}

		return {
			shouldContinue: true,
			shouldEndLoop: false,
			toolResult: {
				type: 'tool_result',
				tool_use_id: toolUseId,
				content: '用户未提供有效回复，请给出默认方案或继续询问。',
				is_error: false
			}
		};
	}

	private async handleApprovalInteraction(
		toolUseId: string,
		command: string,
		cwd: string
	): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
		toolResult?: ToolResultContentBlock;
	}> {
		const approvalQuestion = `AI 请求执行以下命令，该命令可能产生副作用，请确认是否允许：\n\n\`\`\`\n${command}\n\`\`\`\n${cwd ? `工作目录：${cwd}` : ''}`;
		const { response, text } = await this.ask('followup', approvalQuestion);
		const approved = response === 'messageResponse'
			&& !!text
			&& ['是', 'yes', '确认', '允许'].includes(text.trim().toLowerCase());

		if (approved) {
			const execExecution = await this.executeToolWithStructuredResult({
				type: 'tool_use',
				name: 'execute_command',
				params: { command, cwd, requires_approval: 'false' },
				partial: false,
				toolUseId
			});
			const execResult = execExecution.result ?? execExecution.error ?? '';
			const execContent = typeof execResult === 'string' ? execResult : JSON.stringify(execResult);
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUseId,
					content: execContent,
					is_error: !execExecution.success
				}
			};
		}

		return {
			shouldContinue: true,
			shouldEndLoop: false,
			toolResult: {
				type: 'tool_result',
				tool_use_id: toolUseId,
				content: `用户拒绝执行命令：${command}。请尝试其他方案或告知用户需要手动执行此命令。`,
				is_error: false
			}
		};
	}

	private shouldCountAsMistake(execution: ToolExecutionResult): boolean {
		if (
			execution.status === 'blocked_loop' ||
			execution.status === 'approval_required' ||
			execution.status === 'input_required'
		) {
			return false;
		}

		if (execution.nextAction && execution.nextAction !== 'none') {
			return false;
		}

		const code = (execution.code || '').toUpperCase();
		if (
			code.includes('LOOP') ||
			code.includes('PRECHECK') ||
			code.includes('READ_BEFORE_WRITE') ||
			code.includes('STALE') ||
			code.includes('UNCHANGED') ||
			code.includes('BUDGET') ||
			code.includes('REPETITION')
		) {
			return false;
		}

		const errorText = execution.error || '';
		if (
			errorText.includes('预检查失败') ||
			errorText.includes('must be read') ||
			errorText.includes('modified since read') ||
			errorText.includes('oldString not found in content') ||
			errorText.includes('同一 read_file 请求')
		) {
			return false;
		}

		return true;
	}

	private async executeToolWithStructuredResult(toolUse: { type: 'tool_use'; name: ToolName; params: any; partial: boolean; toolUseId?: string }): Promise<ToolExecutionResult> {
		const detailedExecutor = this.toolExecutor as IToolExecutor & {
			executeToolWithResult?: (toolUse: { type: 'tool_use'; name: ToolName; params: any; partial: boolean; toolUseId?: string }) => Promise<ToolExecutionResult>;
		};

		if (typeof detailedExecutor.executeToolWithResult === 'function') {
			return detailedExecutor.executeToolWithResult(toolUse);
		}

		const result = await this.toolExecutor.executeTool(toolUse);
		const text = typeof result === 'string' ? result : JSON.stringify(result);
		const normalized = text.trim();
		const protocolFatal = normalized.includes('<fatal_error>');
		const protocolError = normalized.includes('<error>');
		const approvalInteraction = parseLegacyApprovalRequired(normalized);
		const followupInteraction = parseLegacyFollowupRequired(normalized);
		const interaction: ToolInteractionRequest | undefined = approvalInteraction
			? { type: 'approval', payload: approvalInteraction }
			: followupInteraction
				? { type: 'followup', payload: followupInteraction }
				: undefined;
		const isApprovalRequired = !!approvalInteraction;
		const isInputRequired = !!followupInteraction;
		const hasCommonErrorPrefix =
			normalized.startsWith('错误:') ||
			normalized.startsWith('编辑失败:') ||
			normalized.startsWith('多处编辑失败:') ||
			normalized.startsWith('搜索文件失败:') ||
			normalized.startsWith('代码库搜索失败:') ||
			normalized.startsWith('[FATAL]');
		const hasError = protocolFatal || protocolError || hasCommonErrorPrefix;
		const status: ToolExecutionResult['status'] = isApprovalRequired
			? 'approval_required'
			: isInputRequired
				? 'input_required'
				: protocolFatal
					? 'fatal_error'
					: hasError
						? 'error'
						: 'success';
		const success = status === 'success' || status === 'approval_required' || status === 'input_required';
		const cleanedError = hasError ? normalized.replace(/<[^>]+>/g, '').trim() : undefined;
		const nextAction: ToolExecutionResult['nextAction'] = status === 'fatal_error'
			? 'ask_user'
			: status === 'error'
				? (
					cleanedError?.includes('预检查失败') ||
					cleanedError?.includes('must be read') ||
					cleanedError?.includes('modified since read')
				) ? 'read_before_write' : 'refocus'
				: undefined;
		return {
			success,
			status,
			result,
			error: cleanedError,
			interaction,
			code: hasError ? (protocolFatal ? 'FALLBACK_FATAL_ERROR' : 'FALLBACK_TOOL_ERROR') : undefined,
			retryable: hasError ? false : undefined,
			nextAction,
			metadata: {
				toolName: toolUse.name,
				affectedPaths: TaskService.WRITE_TOOLS.has(toolUse.name)
					? this.extractWriteToolFilePaths({ name: toolUse.name, input: toolUse.params })
					: [],
				didWrite: false,
				shouldCacheResult: !hasError && status !== 'approval_required' && status !== 'input_required',
			}
		};
	}

	private async notifyCommittedFileChanges(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			return;
		}

		const detailedExecutor = this.toolExecutor as IToolExecutor & {
			clearCommittedStateForPaths?: (paths: string[]) => void;
		};
		detailedExecutor.clearCommittedStateForPaths?.(paths.map(path => this.normalizeWorkspacePath(path)).filter(Boolean));
	}

	/**
	 * P0优化：获取文件读取统计
	 */
	public getFileReadStats(): { totalFiles: number; duplicateReads: number } {
		let duplicateReads = 0;
		this.fileReadTracker.forEach((count) => {
			if (count > 1) {
				duplicateReads += count - 1;
			}
		});
		return {
			totalFiles: this.fileReadTracker.size,
			duplicateReads
		};
	}

	/**
	 * P0优化：重置文件读取追踪器（用于新任务）
	 */
	public resetFileReadTracker(): void {
		this.fileReadTracker.clear();
		this.readFileRequestTracker.clear();
		this.duplicateReadRedirectTracker.clear();
		this.resetExplorationProgress();
	}

	/**
	 * 压缩后把"本任务内已成功修改过的文件清单"作为一条 user 提醒注入进 apiConversationHistory，
	 * 防止模型在压缩后忘记自己刚改过的内容，反复重复修改同一处。
	 *
	 * 调用时机：contextCompactor.updateMessages / tieredCompaction 之后，
	 * resetFileReadTracker() 之前。
	 */
	/**
	 * 扫描 apiConversationHistory，取最后一条 is_error=true 的 tool_result 内容
	 * （只取前 500 字符），用于压缩后注入"当前未解决 error"提醒。
	 */
	private findLatestToolErrorSnippet(): string | null {
		const history = this.apiConversationHistory as any[];
		for (let i = history.length - 1; i >= 0; i--) {
			const msg = history[i];
			if (!msg || !Array.isArray(msg.content)) {
				continue;
			}
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const block = msg.content[j];
				if (block && block.type === 'tool_result' && block.is_error === true) {
					const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
					return raw.substring(0, 500);
				}
			}
		}
		return this.lastToolErrorMessage;
	}

	private injectRecentlyModifiedFilesReminder(): void {
		const latestError = this.findLatestToolErrorSnippet();
		if (this.recentlyModifiedFiles.size === 0 && !latestError) {
			return;
		}
		const fileList = Array.from(this.recentlyModifiedFiles).slice(-30);
		const listText = fileList.length > 0
			? fileList.map(p => `- ${p}`).join('\n')
			: '（无）';
		const errorSection = latestError
			? `\n\n[当前未解决的 error 摘要]\n${latestError}\n\n请注意：上次工具执行失败的原因仍然存在，继续工作前请先分析此错误并避免重复同样的参数/调用。`
			: '';
		const reminder = `[系统提醒 · 压缩保护] 在本次上下文压缩前，当前任务已经通过 write_to_file / edit / multiedit / apply_diff 成功修改过以下文件：\n${listText}\n\n请注意：\n1. 这些文件的磁盘内容已经包含你之前做过的修改，**不要再次重复相同的修改**。\n2. 如果需要继续改动其中任何一个，必须先用 read_file 完整读取该文件的**最新内容**，再基于最新内容生成新的 old_string。\n3. 如果任务已经完成，直接调用 attempt_completion，不要再打开这些文件重新"检查一遍"。${errorSection}`;

		try {
			this.apiConversationHistory.push({
				role: 'user',
				content: [{ type: 'text', text: reminder }],
			} as any);
			this.rebuildCharCount();
		} catch (error) {
			console.warn('[TaskService] 注入压缩后"最近修改文件"提醒失败:', error);
		}
	}

	/**
	 * 检查工具是否需要用户确认
	 * 参照Kilocode：危险操作（文件修改、命令执行）需要确认
	 */
	private toolNeedsApproval(toolName: string): boolean {
		// 需要确认的工具列表
		const toolsRequiringApproval = [
			'write_to_file',      // 写入文件
			'apply_diff',         // 应用差异
			'edit_file',          // 编辑文件
			'edit',               // 编辑文件（alias）
			'multiedit',          // 多块编辑
			'patch',              // 补丁应用
			'insert_content',     // 插入内容
			'search_and_replace', // 搜索替换
			'execute_command'     // 执行命令
		];

		return toolsRequiringApproval.includes(toolName);
	}

	/**
	 * 请求工具执行确认 - 参照Kilocode实现
	 * 对于命令使用 ask('command')，对于其他工具使用 ask('tool')
	 */
	private async requestToolApproval(toolUse: { id: string; name: string; input: any }): Promise<{
		approved: boolean;
		feedback?: string;
		failureKind?: 'preflight_failed' | 'user_rejected';
	}> {
		const preflightFailure = await this.preflightApprovalToolUse(toolUse);
		if (preflightFailure) {
			return {
				approved: false,
				feedback: preflightFailure,
				failureKind: 'preflight_failed'
			};
		}

		// 构建工具描述信息
		const toolDescription = this.formatToolForApproval(toolUse);

		// 根据工具类型选择ask类型
		const askType = toolUse.name === 'execute_command' ? 'command' : 'tool';

		// 请求用户确认
		const { response, text } = await this.ask(askType, toolDescription);

		if (response === 'yesButtonClicked') {
			return { approved: true };
		} else if (response === 'messageResponse' && text) {
			// 用户提供了反馈，可能需要修改
			return { approved: false, feedback: text, failureKind: 'user_rejected' };
		} else {
			// 用户拒绝
			return { approved: false, failureKind: 'user_rejected' };
		}
	}

	private async preflightApprovalToolUse(toolUse: { id: string; name: string; input: any }): Promise<string | null> {
		if (typeof this.toolExecutor.preflightToolUse !== 'function') {
			return null;
		}

		const preflight = await this.toolExecutor.preflightToolUse({
			type: 'tool_use',
			name: toolUse.name as ToolName,
			params: toolUse.input,
			partial: false,
			toolUseId: toolUse.id
		});

		if (!preflight || preflight.success) {
			return null;
		}

		if (typeof preflight.result === 'string' && preflight.result.trim()) {
			return preflight.result;
		}

		if (preflight.error?.trim()) {
			return formatResponse.toolError(preflight.error);
		}

		return formatResponse.toolError(`${toolUse.name} 预检查失败`);
	}

	/**
	 * 格式化工具信息用于确认显示
	 */
	private formatToolForApproval(toolUse: { id: string; name: string; input: any }): string {
		const toolName = toolUse.name;
		const params = toolUse.input;

		switch (toolName) {
			case 'write_to_file':
				return JSON.stringify({
					tool: 'newFileCreated',
					path: params.path,
					content: params.content  // 🔧 不截断，保留完整内容用于文件保存
				});

			case 'apply_diff':
				return JSON.stringify({
					tool: 'appliedDiff',
					path: params.path,
					diff: params.diff
				});

			case 'edit_file':
				return JSON.stringify({
					tool: 'editedExistingFile',
					path: params.target_file,
					instructions: params.instructions,
					code_edit: params.code_edit?.substring(0, 500) + (params.code_edit?.length > 500 ? '...' : '')
				});

			case 'insert_content':
				return JSON.stringify({
					tool: 'insertContent',
					path: params.path,
					line: params.line,
					content: params.content  // 🔧 不截断，保留完整内容用于文件保存
				});

			case 'search_and_replace': {
				// 将operations数组转换为新旧内容，用于diff显示
				const operations = params.operations || [];
				let originalContent = '';
				let newContent = '';
				for (const op of operations) {
					if (op.search && op.replace !== undefined) {
						originalContent += op.search + '\n\n';
						newContent += op.replace + '\n\n';
					}
				}
				return JSON.stringify({
					tool: 'searchAndReplace',
					path: params.path,
					originalContent: originalContent.trim(),
					newContent: newContent.trim(),
					operationCount: operations.length
				});
			}

			case 'edit':
				return JSON.stringify({
					tool: 'edit',
					path: params.path,
					oldString: typeof params.old_string === 'string' ? params.old_string : '',
					newString: typeof params.new_string === 'string' ? params.new_string : '',
				});

			case 'multiedit': {
				let multieditEdits: Array<{ oldString: string; newString: string }> = [];
				try {
					const rawEdits = params.edits ? (typeof params.edits === 'string' ? JSON.parse(params.edits) : params.edits) : [];
					multieditEdits = rawEdits.map((e: any) => ({
						oldString: typeof e.oldString === 'string' ? e.oldString : '',
						newString: typeof e.newString === 'string' ? e.newString : '',
					}));
				} catch { /* ignore */ }
				return JSON.stringify({ tool: 'multiedit', path: params.path, edits: multieditEdits });
			}

case 'execute_command':
				// 命令直接显示命令文本
				return params.command;

			default:
				return JSON.stringify({
					tool: toolName,
					params: params
				});
		}
	}

	/**
	 * 解析 batch.tool_calls 参数
	 * 支持：
	 * 1. 标准数组
	 * 2. 字符串化数组
	 * 3. 字符串化对象（{ tool_calls: [...] }）
	 * 4. 截断 JSON 修复
	 * 5. 严重损坏时从 path/tool 片段恢复最小调用
	 */
	private parseBatchToolCallsInput(rawCalls: unknown): Array<{ tool: string; parameters: any }> {
		const normalize = (calls: unknown): Array<{ tool: string; parameters: any }> => {
			if (!Array.isArray(calls)) {
				return [];
			}
			const normalized = calls
				.map((call: any) => {
					if (!call || typeof call !== 'object') {
						return null;
					}
					const nestedParams = call.parameters && typeof call.parameters === 'object'
						? call.parameters
						: {};
					const rawTool = typeof call.tool === 'string'
						? call.tool
						: (typeof call.name === 'string' ? call.name : undefined);
					const liftedTool = !rawTool && typeof nestedParams.tool === 'string'
						? nestedParams.tool
						: undefined;
					const toolName = (rawTool || liftedTool || '').trim();
					const parameters = { ...nestedParams };
					if ('tool' in parameters) {
						delete parameters.tool;
					}
					return toolName
						? { tool: toolName, parameters }
						: null;
				})
				.filter((call): call is { tool: string; parameters: any } => !!call);
			return normalized;
		};

		if (Array.isArray(rawCalls)) {
			return normalize(rawCalls);
		}

		if (rawCalls && typeof rawCalls === 'object') {
			const nested = (rawCalls as any).tool_calls;
			return this.parseBatchToolCallsInput(nested);
		}

		if (typeof rawCalls !== 'string') {
			return [];
		}

		const trimmed = rawCalls.trim();
		if (!trimmed) {
			return [];
		}

		const xmlToolCallsMatch = trimmed.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
		if (xmlToolCallsMatch?.[1]) {
			return this.parseBatchToolCallsInput(xmlToolCallsMatch[1].trim());
		}

		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return normalize(parsed);
			}
			if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).tool_calls)) {
				return normalize((parsed as any).tool_calls);
			}
		} catch {
			// ignored, try repair flow
		}

		const repaired = this._repairTruncatedBatchJson(trimmed);
		if (repaired) {
			return normalize(repaired);
		}

		// 兜底恢复：提取 path + tool，避免整轮空转
		const extracted = this.extractBatchToolCallsFromMalformedString(trimmed);
		if (extracted.length > 0) {
			return extracted;
		}

		return [];
	}

	/**
	 * 从损坏的 batch 字符串中兜底提取工具调用
	 * 当前仅提取 path/tool 组合，适用于 read_file 类调用恢复
	 */
	private extractBatchToolCallsFromMalformedString(raw: string): Array<{ tool: string; parameters: any }> {
		const pathMatches = Array.from(raw.matchAll(/"path"\s*:\s*"([^"]+)"/g));
		if (pathMatches.length === 0) {
			return [];
		}

		const toolMatches = Array.from(raw.matchAll(/"tool"\s*:\s*"([^"]+)"/g));
		let defaultTool = 'read_file';
		if (toolMatches.length === 1 && typeof toolMatches[0]?.[1] === 'string') {
			defaultTool = toolMatches[0][1];
		}

		return pathMatches.map((match, index) => {
			const pathValue = match[1];
			const toolValue = toolMatches[index]?.[1] || defaultTool;
			return {
				tool: toolValue,
				parameters: { path: pathValue }
			};
		});
	}

	/**
	 * 修复截断的 batch tool_calls JSON 字符串
	 * 模型输出被截断时可能缺少结尾的 }、}] 等，通过多种策略尝试修复
	 */
	private _repairTruncatedBatchJson(raw: string): Array<{ tool: string; parameters: any }> | null {
		const candidates: string[] = [];

		// 策略1: 直接解析（可能已经完整）
		candidates.push(raw);

		// 策略2: 末尾补 ']'
		if (!raw.trimEnd().endsWith(']')) {
			candidates.push(raw.trimEnd() + ']');
		}

		// 策略3: 末尾补 '}]' （工具对象未关闭 + 数组未关闭）
		candidates.push(raw.trimEnd() + '}]');

		// 策略4: 末尾补 '}}]' （参数对象 + 工具对象 + 数组均未关闭）
		candidates.push(raw.trimEnd() + '}}]');

		// 策略5: 截断到最后一个完整的 {...} 对象，然后补 ']'
		// 找到最后一个完整对象：反向扫描找到匹配的 { }
		const lastCompleteObjEnd = this._findLastCompleteObjectEnd(raw);
		if (lastCompleteObjEnd > 0) {
			const openBracket = raw.indexOf('[');
			if (openBracket !== -1) {
				candidates.push(raw.substring(openBracket, lastCompleteObjEnd + 1) + ']');
			}
		}

		for (const candidate of candidates) {
			try {
				const parsed = JSON.parse(candidate);
				if (Array.isArray(parsed) && parsed.length > 0) {
					return parsed;
				}
			} catch {
				// 继续尝试下一个
			}
		}

		return null;
	}

	/**
	 * 在 JSON 字符串中找到最后一个完整 {...} 对象的结束位置
	 * （跳过字符串内容，正确处理转义）
	 */
	private _findLastCompleteObjectEnd(s: string): number {
		let lastEnd = -1;
		let depth = 0;
		let inString = false;
		let escape = false;

		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (escape) { escape = false; continue; }
			if (ch === '\\' && inString) { escape = true; continue; }
			if (ch === '"') { inString = !inString; continue; }
			if (inString) continue;

			if (ch === '{' || ch === '[') depth++;
			else if (ch === '}' || ch === ']') {
				depth--;
				if (ch === '}' && depth === 1) {
					// depth=1 means we just closed an element of the top-level array
					lastEnd = i;
				}
			}
		}

		return lastEnd;
	}

	/**
	 * 格式化工具状态用于UI显示
	 * 用于在聊天框中显示当前正在执行什么工具
	 */
	private formatToolStatusForDisplay(toolUse: { id: string; name: string; input: any }): string {
		const toolName = toolUse.name;
		const params = toolUse.input;
		const toolId = toolUse.id; // 🔧 提取toolId用于前端元素管理

		switch (toolName) {
			case 'read_file':
				return JSON.stringify({
					toolId,
					tool: 'readFile',
					path: params.path
				});

			case 'list_files':
				return JSON.stringify({
					toolId,
					tool: 'listFiles',
					path: params.path,
					recursive: params.recursive || false
				});

			case 'search_files':
				return JSON.stringify({
					toolId,
					tool: 'searchFiles',
					path: params.path,
					regex: params.regex
				});

			case 'list_code_definition_names':
				return JSON.stringify({
					toolId,
					tool: 'listCodeDefinitionNames',
					path: params.path
				});

			case 'write_to_file':
				return JSON.stringify({
					toolId,
					tool: 'newFileCreated',
					path: params.path
				});

			case 'edit':
				return JSON.stringify({
					toolId,
					tool: 'edit',
					path: params.path,
					oldString: typeof params.old_string === 'string' ? params.old_string.substring(0, 2000) : '',
					newString: typeof params.new_string === 'string' ? params.new_string.substring(0, 2000) : '',
				});

			case 'multiedit': {
				let multieditEdits: Array<{ oldString: string; newString: string }> = [];
				try {
					const rawEdits = params.edits ? (typeof params.edits === 'string' ? JSON.parse(params.edits) : params.edits) : [];
					multieditEdits = rawEdits.map((e: any) => ({
						oldString: typeof e.oldString === 'string' ? e.oldString.substring(0, 1000) : '',
						newString: typeof e.newString === 'string' ? e.newString.substring(0, 1000) : '',
					}));
				} catch { /* ignore */ }
				return JSON.stringify({
					toolId,
					tool: 'multiedit',
					path: params.path,
					edits: multieditEdits,
				});
			}

			case 'apply_diff':
				return JSON.stringify({
					toolId,
					tool: 'appliedDiff',
					path: params.path
				});

			case 'edit_file':
				return JSON.stringify({
					toolId,
					tool: 'editedExistingFile',
					path: params.target_file
				});

			case 'insert_content':
				return JSON.stringify({
					toolId,
					tool: 'insertContent',
					path: params.path,
					line: params.line
				});

			case 'execute_command':
				return JSON.stringify({
					toolId,
					tool: 'executeCommand',
					command: params.command?.substring(0, 100) + (params.command?.length > 100 ? '...' : '')
				});

			case 'ask_followup_question':
				return JSON.stringify({
					toolId,
					tool: 'askFollowupQuestion',
					question: params.question?.substring(0, 100) + (params.question?.length > 100 ? '...' : '')
				});

			case 'attempt_completion':
				return JSON.stringify({
					toolId,
					tool: 'attemptCompletion'
				});

			case 'skill':
				return JSON.stringify({
					toolId,
					tool: 'skill',
					skillName: params.skill_name || params.name || 'unknown'
				});

			case 'task':
				return JSON.stringify({
					toolId,
					tool: 'task',
					description: params.description || 'unknown',
					subagentType: params.subagent_type || 'unknown'
				});

			default:
				return JSON.stringify({
					toolId,
					tool: toolName,
					params: Object.keys(params || {})
				});
		}
	}

	/**
	 * 处理attempt_completion - 参照kilocode完整实现
	 */
	private async handleAttemptCompletion(toolUse: { id: string; name: string; input: any }): Promise<{
		shouldContinue: boolean;
		shouldEndLoop: boolean;
		toolResult?: ContentBlock;
	}> {
		const result = typeof toolUse.input.result === 'string' ? toolUse.input.result.trim() : '';

		if (!result) {
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: '[FATAL] attempt_completion 缺少 result 摘要。不要省略结果，也不要依赖系统帮你从最近文本里猜测完成内容。请立即重试 attempt_completion，并用 3-8 行高信噪比摘要明确说明：改了什么、验证了什么、还剩什么（如果确实没有剩余就不要写“待办”）。',
					is_error: true
				}
			};
		}

		if (this.isLikelyInternalMetaResponse(result) || /[?？]\s*$/.test(result)) {
			return {
				shouldContinue: true,
				shouldEndLoop: false,
				toolResult: {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: '[FATAL] 当前 attempt_completion 的 result 更像内部策略说明、等待状态，或以问题结尾，不是可交付的最终结果。请只保留面向用户的完成摘要，再次调用 attempt_completion。',
					is_error: true
				}
			};
		}

		// 功能2: Debug 模式自动测试循环
		if (this.currentMode === 'debug' && this._debugTestRetryCount < TaskService.MAX_DEBUG_TEST_RETRIES) {
			const testResult = await this.runDebugTests();
			if (testResult !== null) {
				// 测试有结果（不是"无法检测项目类型"的null）
				if (!testResult.passed) {
					// 测试失败，将错误注入对话，让 AI 继续修复
					this._debugTestRetryCount++;
					console.log(`[TaskService] Debug 测试失败（第${this._debugTestRetryCount}次），注入测试错误让 AI 修复`);
					await this.say('tool', `[Debug 自动测试] 运行 ${testResult.command} 失败（第 ${this._debugTestRetryCount}/${TaskService.MAX_DEBUG_TEST_RETRIES} 次）`);

					return {
						shouldContinue: true,
						shouldEndLoop: false,
						toolResult: {
							type: 'tool_result',
							tool_use_id: toolUse.id,
							content: `[DEBUG_TEST_FAILED] 测试命令 \`${testResult.command}\` 执行失败，请修复错误后再次尝试完成任务。\n\n测试输出：\n${testResult.output}`,
							is_error: false
						}
					};
				}
				// 测试通过，重置计数器，继续正常完成流程
				console.log(`[TaskService] Debug 测试通过：${testResult.command}`);
				this._debugTestRetryCount = 0;
			}
		}

		// 显示完成结果
		await this.say('completion_result', result);

		// 问答模式和 Solo 模式：不需要用户确认，直接结束
		if (this.currentMode === 'ask' || this.currentMode === 'solo') {
			return {
				shouldContinue: true,
				shouldEndLoop: true
			};
		}

		// 询问用户（仅 IDE 模式的非 ask/solo）
		const { response, text, images } = await this.ask('completion_result', '');

		if (response === 'yesButtonClicked') {
			// 用户接受，任务完成
			return {
				shouldContinue: true,
				shouldEndLoop: true
			};
		}

		// 用户提供反馈，继续任务
		await this.say('user_feedback', text || '', images);

		return {
			shouldContinue: true,
			shouldEndLoop: false,
			toolResult: {
				type: 'tool_result',
				tool_use_id: toolUse.id,
				content: formatResponse.attemptCompletionFeedback(text || ''),
				is_error: false
			}
		};
	}

	// ========== 功能2: Debug 自动测试 ==========

	/**
	 * 检测项目类型并运行测试（Debug 模式专用）
	 * @returns { passed, command, output } 测试结果，null 表示无法检测项目类型
	 */
	private async runDebugTests(): Promise<{ passed: boolean; command: string; output: string } | null> {
		const cwd = this.workspaceRoot;

		// 检测项目类型（通过 execute_command 执行 ls 检测文件）
		let testCommand: string | null = null;

		try {
			// 检测 mvnw（Maven Wrapper 优先）
			const checkMvnw = await this.toolExecutor.executeTool({
				type: 'tool_use',
				name: 'execute_command' as ToolName,
				params: { command: 'test -f mvnw && echo "mvnw" || echo "none"', cwd, requires_approval: 'false', description: 'Check mvnw' },
				partial: false,
				toolUseId: `debug_check_mvnw_${Date.now()}`
			});
			if (typeof checkMvnw === 'string' && checkMvnw.includes('mvnw')) {
				testCommand = './mvnw test -q';
			}
		} catch { /* ignore */ }

		if (!testCommand) {
			try {
				// 检测 pom.xml（Maven）
				const checkPom = await this.toolExecutor.executeTool({
					type: 'tool_use',
					name: 'execute_command' as ToolName,
					params: { command: 'test -f pom.xml && echo "pom" || echo "none"', cwd, requires_approval: 'false', description: 'Check pom.xml' },
					partial: false,
					toolUseId: `debug_check_pom_${Date.now()}`
				});
				if (typeof checkPom === 'string' && checkPom.includes('pom')) {
					testCommand = 'mvn test -q';
				}
			} catch { /* ignore */ }
		}

		if (!testCommand) {
			try {
				// 检测 package.json（Node.js）
				const checkPkg = await this.toolExecutor.executeTool({
					type: 'tool_use',
					name: 'execute_command' as ToolName,
					params: { command: 'test -f package.json && node -e "const p=require(\'./package.json\');console.log(p.scripts&&p.scripts.test?\'has_test\':\'no_test\')"', cwd, requires_approval: 'false', description: 'Check package.json test script' },
					partial: false,
					toolUseId: `debug_check_pkg_${Date.now()}`
				});
				if (typeof checkPkg === 'string' && checkPkg.includes('has_test')) {
					testCommand = 'npm test -- --run';
				}
			} catch { /* ignore */ }
		}

		if (!testCommand) {
			try {
				// 检测 pytest.ini 或 setup.py（Python）
				const checkPy = await this.toolExecutor.executeTool({
					type: 'tool_use',
					name: 'execute_command' as ToolName,
					params: { command: '(test -f pytest.ini || test -f setup.py || test -f pyproject.toml) && echo "pytest" || echo "none"', cwd, requires_approval: 'false', description: 'Check pytest' },
					partial: false,
					toolUseId: `debug_check_py_${Date.now()}`
				});
				if (typeof checkPy === 'string' && checkPy.includes('pytest')) {
					testCommand = 'pytest -q';
				}
			} catch { /* ignore */ }
		}

		if (!testCommand) {
			// 无法识别项目类型，跳过测试
			console.log('[TaskService] Debug 测试：无法识别项目类型，跳过自动测试');
			return null;
		}

		// 执行测试命令
		console.log(`[TaskService] Debug 自动运行测试：${testCommand}`);
		try {
			const testOutput = await this.toolExecutor.executeTool({
				type: 'tool_use',
				name: 'execute_command' as ToolName,
				params: { command: testCommand, cwd, requires_approval: 'false', description: 'Debug auto test' },
				partial: false,
				toolUseId: `debug_test_${Date.now()}`
			});
			const outputStr = typeof testOutput === 'string' ? testOutput : JSON.stringify(testOutput);

			// 解析退出码：execute_command 成功则 exit code 为 0
			// 输出中如果包含错误关键字，视为失败
			const lowerOutput = outputStr.toLowerCase();
			const hasFailed = lowerOutput.includes('tests failed') ||
				lowerOutput.includes('test failed') ||
				lowerOutput.includes('failures=') ||
				lowerOutput.includes('error:') ||
				lowerOutput.includes('build failure') ||
				lowerOutput.includes('build failed') ||
				(lowerOutput.includes('exit code') && !lowerOutput.includes('exit code 0'));

			return {
				passed: !hasFailed,
				command: testCommand,
				output: outputStr.length > 3000 ? outputStr.substring(0, 3000) + '\n... (输出截断)' : outputStr
			};
		} catch (error) {
			// 命令执行失败（非0退出码），视为测试失败
			const errMsg = error instanceof Error ? error.message : String(error);
			return {
				passed: false,
				command: testCommand,
				output: errMsg.length > 3000 ? errMsg.substring(0, 3000) + '\n... (输出截断)' : errMsg
			};
		}
	}

	// ========== 功能1: Checkpoint 回滚 ==========

	/**
	 * 回滚到最后一个 checkpoint（由 maxian.rollbackCheckpoint 命令调用）
	 * 恢复保存的对话历史状态
	 */
	public async rollbackToLastCheckpoint(): Promise<{ success: boolean; message: string }> {
		const latest = this.checkpointManager.getLatestCheckpoint();
		if (!latest) {
			return { success: false, message: '没有可用的 checkpoint' };
		}

		try {
			const data = await this.checkpointManager.restoreCheckpoint(latest.id);
			if (!data) {
				return { success: false, message: `无法恢复 checkpoint: ${latest.id}` };
			}

			// 恢复对话历史
			if (data.messages && Array.isArray(data.messages)) {
				this.apiConversationHistory = data.messages;
				this.rebuildCharCount();
			}

			// 恢复 token 使用统计
			if (data.tokenUsage) {
				this.tokenUsage = { ...this.tokenUsage, ...data.tokenUsage };
			}

			console.log(`[TaskService] 已回滚到 checkpoint: ${latest.id} (${latest.description})`);
			return {
				success: true,
				message: `已回滚到 checkpoint: ${latest.description}（创建于 ${new Date(latest.timestamp).toLocaleString()}）`
			};
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error('[TaskService] 回滚 checkpoint 失败:', error);
			return { success: false, message: `回滚失败: ${errMsg}` };
		}
	}

	/**
	 * 获取所有可用 checkpoint 列表
	 */
	public getCheckpoints(): import('../checkpoints/CheckpointManager.js').Checkpoint[] {
		return this.checkpointManager.getAllCheckpoints();
	}

	// ========== 辅助方法 ==========

	/**
	 * 更新Token使用统计
	 * 支持精确 Token 统计和缓存 Token 统计
	 */
	private updateTokenUsage(usageChunk: any): void {
		// 精确输入 Token
		if (usageChunk.inputTokens) {
			this.tokenUsage.totalTokensIn += usageChunk.inputTokens;
		}

		// 精确输出 Token
		if (usageChunk.outputTokens) {
			this.tokenUsage.totalTokensOut += usageChunk.outputTokens;
		}

		// 缓存写入 Token（prompt caching）
		if (usageChunk.cacheCreationInputTokens) {
			this.tokenUsage.totalCacheWrites = (this.tokenUsage.totalCacheWrites || 0) + usageChunk.cacheCreationInputTokens;
		}

		// 缓存读取 Token（prompt caching）
		if (usageChunk.cacheReadInputTokens) {
			this.tokenUsage.totalCacheReads = (this.tokenUsage.totalCacheReads || 0) + usageChunk.cacheReadInputTokens;
		}

		// 更新上下文 Token（当前消息历史的估算）
		this.tokenUsage.contextTokens = this.estimateTokens(this.apiConversationHistory);

		this._onTokenUsageUpdated.fire(this.tokenUsage);
	}

	/**
	 * 更新步骤状态
	 * 发出步骤更新事件，用于UI显示当前进度
	 */
	private updateStep(description: string, status: 'running' | 'completed' | 'error' = 'running'): void {
		if (status === 'running') {
			this.currentStepIndex++;
			this.currentStepDescription = description;
		}

		this._onStepUpdated.fire({
			current: this.currentStepIndex,
			total: this.totalSteps,
			description: description,
			status: status,
		});

	}

	/**
	 * 设置总步骤数
	 * 根据规划结果或估算设置总步骤数
	 */
	private setTotalSteps(steps: number): void {
		this.totalSteps = steps;
		this.currentStepIndex = 0;
	}

	/**
	 * 获取当前步骤信息
	 */
	public getStepInfo(): { current: number; total: number; description: string } {
		return {
			current: this.currentStepIndex,
			total: this.totalSteps,
			description: this.currentStepDescription,
		};
	}

	/**
	 * 中止任务
	 */
	public abortTask(reason?: ClineApiReqCancelReason): void {
		this.abort = true;
		this.abortReason = reason;
		this.setStatus(TaskStatus.ABORTED);
		// 埋点：任务中止
		this.behaviorReporter?.reportTaskEnd(this.taskId, 'aborted');
		// 立即中止当前 API 请求（通过 AbortController 取消 fetch）
		if (this.apiHandler && typeof (this.apiHandler as any).stopCurrentRequest === 'function') {
			(this.apiHandler as any).stopCurrentRequest().catch(() => { /* ignore */ });
		}
		// 发出步骤中止事件
		this._onStepUpdated.fire({
			current: this.currentStepIndex,
			total: this.totalSteps,
			description: '任务已取消',
			status: 'error',
		});
		console.log('[TaskService] 任务已中止:', this.taskId, reason);
	}

	/**
	 * Sleep辅助函数
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * 获取消息历史
	 */
	public getMessageHistory(): MessageParam[] {
		return this.apiConversationHistory;
	}

	/**
	 * 获取Cline消息
	 */
	public getClineMessages(): ClineMessage[] {
		return this.clineMessages;
	}

	/**
	 * 获取Token使用
	 */
	public getTokenUsage(): TokenUsage {
		return { ...this.tokenUsage };
	}

	/**
	 * 获取工具使用
	 */
	public getToolUsage(): ToolUsage {
		return { ...this.toolUsage };
	}

	/**
	 * 获取当前任务上下文（探索和规划结果）
	 */
	public getTaskContext(): TaskContext | undefined {
		return this.taskContext;
	}

	/**
	 * 获取 Agent 配置
	 */
	public getAgentConfig(): AgentConfig {
		return { ...this.agentConfig };
	}

	/**
	 * 获取 Agent 编排器
	 * 用于外部访问探索和规划功能
	 */
	public getAgentOrchestrator(): AgentOrchestrator {
		return this.agentOrchestrator;
	}

	// ========== 上下文管理方法 ==========

	/**
	 * 统计单条消息的字符数（供增量计数器使用）
	 */
	private countMsgChars(msg: MessageParam): number {
		let chars = 0;
		if (typeof msg.content === 'string') {
			chars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text') {
					chars += block.text.length;
				} else if (block.type === 'tool_result') {
					chars += typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length;
				} else if (block.type === 'tool_use') {
					chars += JSON.stringify(block.input).length;
				}
			}
		}
		return chars;
	}

	/**
	 * 重建增量字符计数器（compaction 后 apiConversationHistory 被替换时调用）
	 */
	private rebuildCharCount(): void {
		let total = 0;
		for (const msg of this.apiConversationHistory) {
			total += this.countMsgChars(msg);
		}
		this._estimatedTotalChars = total;
	}

	/**
	 * 估算消息的 token 数量
	 * 统一估算：4字符/token
	 * 当传入 this.apiConversationHistory 时，直接用增量计数器，O(1)
	 */
	private estimateTokens(messages: MessageParam[]): number {
		if (messages === this.apiConversationHistory) {
			return estimateTokensFromChars(this._estimatedTotalChars);
		}
		let totalChars = 0;
		for (const msg of messages) {
			totalChars += this.countMsgChars(msg);
		}
		return estimateTokensFromChars(totalChars);
	}

	/**
	 * P0优化：截断对话历史以控制 token 数量
	 * 增强策略：
	 * 1. 使用 ContextCompactor 自动检测和修剪工具输出
	 * 2. 使用 AI 摘要压缩旧消息
	 * 3. 如果仍然超限，再截断消息
	 */
	private async truncateHistoryIfNeeded(force: boolean = false): Promise<void> {
		// D7: 确保后台压缩已完成（通常已在 API 流式期间完成，此处零等待）
		if (this._pendingBackgroundCompact) {
			const pendingCompact = this._pendingBackgroundCompact;
			const compactSettled = await Promise.race([
				pendingCompact.then(() => true).catch(() => true),
				this.sleep(300).then(() => false)
			]);
			if (!compactSettled) {
				console.warn('[TaskService] D7 后台压缩等待超时(300ms)，跳过阻塞等待，继续请求流程');
			}
			this._pendingBackgroundCompact = null;
		}

		// E1优化：使用有效 context 窗口和精确四级阈值（对齐 Claude Code）
		// 使用增量计数器 O(1) 估算，比 ModelContextTracker.estimateUsage 更精确
		let currentTokens = this.estimateTokens(this.apiConversationHistory);
		const usagePct = ((currentTokens / EFFECTIVE_CONTEXT_WINDOW) * 100).toFixed(1);

		// D6: Snip 预处理层 — 50% 以上开始轻量级修剪工具输出，推迟重量级压缩
		// 对齐 Claude Code 第1层 Snip（per-turn 轻量预处理，追踪 snipTokensFreed）
		const SNIP_THRESHOLD = Math.floor(EFFECTIVE_CONTEXT_WINDOW * 0.50); // ~40000
		if (!force && currentTokens > SNIP_THRESHOLD) {
			const snipBefore = currentTokens;
			const snipResult = this.contextCompactor.updateMessages(this.apiConversationHistory as CompactableMessage[]);
			if (snipResult.needsPrune) {
				this.apiConversationHistory = snipResult.messages;
				this.rebuildCharCount();
				currentTokens = this.estimateTokens(this.apiConversationHistory);
				const freed = snipBefore - currentTokens;
				if (freed > 0) {
					console.log(`[TaskService] D6 Snip: 修剪工具输出 ${snipBefore} -> ${currentTokens} tokens (-${freed})`);
				}
			}
		}

		if (!force) {
			// 低于警告阈值：无需任何处理
			if (currentTokens < CONTEXT_WARNING_THRESHOLD) {
				return;
			}

			// 警告阈值 (75%)：记录警告
			console.warn(`[TaskService] E1 上下文警告: ${((currentTokens / EFFECTIVE_CONTEXT_WINDOW) * 100).toFixed(1)}% (${currentTokens}/${EFFECTIVE_CONTEXT_WINDOW} tokens)`);

			// 低于自动压缩阈值 (~83.75%)：仅警告，不触发压缩
			if (currentTokens < CONTEXT_AUTO_COMPACT_THRESHOLD) {
				return;
			}
		} else {
			// E3 ReactiveCompact：强制压缩模式，跳过阈值检查
			console.warn(`[TaskService] E3 ReactiveCompact: 强制压缩 ${usagePct}% (${currentTokens}/${EFFECTIVE_CONTEXT_WINDOW} tokens)`);
		}

		// 紧急阻断阈值 (~96.25%)：打印错误，立即压缩
		if (currentTokens >= CONTEXT_BLOCKING_LIMIT) {
			console.error(`[TaskService] E1 紧急阻断: 上下文 ${((currentTokens / EFFECTIVE_CONTEXT_WINDOW) * 100).toFixed(1)}% 超过 blockingLimit (${CONTEXT_BLOCKING_LIMIT})，立即执行强制压缩`);
		}

		// 压缩目标：降至警告阈值以下（留出足够空间）
		const allowedTokens = CONTEXT_WARNING_THRESHOLD;

		// 创建检查点（压缩前保存状态）
		await this.createCheckpointBeforeCompaction();

		console.log(`[TaskService] 上下文需要优化: tokens=${currentTokens}, messages=${this.apiConversationHistory.length}`);

		// 第一层：P0-3: 使用 ContextCompactor 自动修剪工具输出
		const compactResult = this.contextCompactor.updateMessages(this.apiConversationHistory as CompactableMessage[]);
		if (compactResult.needsPrune) {
			this.apiConversationHistory = compactResult.messages;
			this.rebuildCharCount();
			const newTokens = this.estimateTokens(this.apiConversationHistory);
			const stats = this.contextCompactor.getStats();
			console.log(`[TaskService] ContextCompactor 修剪完成: 修剪了 ${stats.compactedParts} 个工具输出, 节省 ${stats.savedTokens} tokens, 当前 ${newTokens} tokens`);

			// 修剪后：先注入"最近修改文件"提醒，再重置文件读取追踪器
			// 这样模型知道哪些文件已经改过，不会因为追踪器被清空而重复修改
			this.injectRecentlyModifiedFilesReminder();
			this.resetFileReadTracker();

			// 如果修剪后仍在限制内，直接返回
			if (newTokens <= allowedTokens) {
				return;
			}
		}

			// 第二层：分层压缩策略
			const messages = this.apiConversationHistory as CompactableMessage[];
			const afterPruneTokens = this.estimateTokens(this.apiConversationHistory);

			if (this.tieredCompactionManager.shouldTieredCompact(messages, afterPruneTokens)) {
				console.log(`[TaskService] 执行分层压缩策略`);

				const tieredResult = this.tieredCompactionManager.executeTieredCompaction(messages);

				// 更新消息历史
				this.apiConversationHistory = tieredResult.messages as MessageParam[];
				this.rebuildCharCount();
				const afterTieredTokens = this.estimateTokens(this.apiConversationHistory);

				console.log(`[TaskService] 分层压缩完成: Tier1=${tieredResult.tierCounts.tier1}, Tier2=${tieredResult.tierCounts.tier2}, Tier3=${tieredResult.tierCounts.tier3}, Tier4=${tieredResult.tierCounts.tier4}`);
				console.log(`[TaskService] Token变化: ${tieredResult.originalTokens} -> ${afterTieredTokens} (节省 ${tieredResult.originalTokens - afterTieredTokens})`);

				const shouldAllowAISummary =
					force ||
					currentTokens >= CONTEXT_BLOCKING_LIMIT;

				// 如果需要 AI 摘要（Tier 4 有消息）
				if (tieredResult.needsAISummary && tieredResult.summaryPrompt) {
					if (!shouldAllowAISummary) {
						console.log('[TaskService] 分层压缩跳过 AI 摘要（常规轮次优先低延迟，避免大项目重构时卡住）');
					} else if (this.tieredCompactionManager.isCircuitOpen()) {
						// E4优化：检查熔断器，连续失败3次后跳过 AI 摘要
						console.warn(`[TaskService] E4: 压缩熔断器已触发，跳过分层压缩 AI 摘要`);
					} else {
						console.log(`[TaskService] 分层压缩需要 AI 摘要 (Tier4 消息数: ${tieredResult.tierCounts.tier4})`);

						try {
							// 调用 AI 生成摘要
							const summaryStream = this.apiHandler.createMessage(
								'你是一个专门生成对话摘要的助手。请根据提供的对话历史生成一个详细的摘要，保留所有关键技术细节。',
								[{ role: 'user', content: [{ type: 'text', text: tieredResult.summaryPrompt }] }],
								[]
							);

							let summaryText = '';
							for await (const chunk of summaryStream) {
								if (chunk.type === 'text') {
									summaryText += chunk.text;
								}
							}

							if (!summaryText) {
								throw new Error('AI 返回空摘要');
							}

							// 整合摘要到压缩结果
							const finalMessages = this.tieredCompactionManager.integrateSummary(tieredResult, summaryText);
							this.apiConversationHistory = finalMessages as MessageParam[];
							this.rebuildCharCount();

							const finalTokens = this.estimateTokens(this.apiConversationHistory);
							console.log(`[TaskService] 分层压缩+AI摘要完成: ${tieredResult.originalTokens} -> ${finalTokens} tokens`);

							// E4优化：压缩成功，重置熔断器
							this.tieredCompactionManager.recordCompactionSuccess();

							// 发出压缩完成事件
							this.say('condense_context', JSON.stringify({
								status: 'completed',
								prevContextTokens: tieredResult.originalTokens,
								newContextTokens: finalTokens,
								summary: summaryText.substring(0, 200) + '...',
								cost: 0,
								autoContinue: true,
								tiered: true, // 标记这是分层压缩
								tierCounts: tieredResult.tierCounts,
							}));
						} catch (error) {
							console.error(`[TaskService] 分层压缩 AI 摘要失败:`, error);
							// E4优化：记录失败，更新熔断器计数
							this.tieredCompactionManager.recordCompactionFailure();
							// AI 摘要失败，但分层压缩仍然有效
						}
					}
				}

				// 分层压缩后：先注入"最近修改文件"提醒，再重置文件读取追踪器
				// 这样模型知道哪些文件已经改过，不会因为追踪器被清空而重复修改
				this.injectRecentlyModifiedFilesReminder();
				this.resetFileReadTracker();
				console.log('[TaskService] 上下文压缩完成，重置文件读取追踪器');

				// 如果分层压缩后仍在限制内，直接返回
				const newTokens = this.estimateTokens(this.apiConversationHistory);
				if (newTokens <= allowedTokens) {
					return;
				}
			}

			// 第三层：P0-2: 尝试传统 AI 摘要压缩
			const messagesAfterTiered = this.apiConversationHistory as CompactableMessage[];
			const tokensAfterTiered = this.estimateTokens(this.apiConversationHistory);

			if (this.aiSummaryCompactor.shouldSummarize(messagesAfterTiered, tokensAfterTiered)) {
				const shouldAllowTraditionalSummary =
					force ||
					currentTokens >= CONTEXT_BLOCKING_LIMIT;
				if (!shouldAllowTraditionalSummary) {
					console.log('[TaskService] 跳过传统 AI 摘要压缩（常规轮次优先低延迟）');
				} else if (this.tieredCompactionManager.isCircuitOpen()) {
					// E4优化：检查熔断器，连续失败3次后跳过 AI 摘要
					console.warn(`[TaskService] E4: 压缩熔断器已触发，跳过传统 AI 摘要压缩`);
				} else {
					console.log(`[TaskService] 尝试 AI 摘要压缩`);

					try {
						const summaryResult = await this.condenseContext();
						if (summaryResult.success) {
							const newTokens = this.estimateTokens(this.apiConversationHistory);
							console.log(`[TaskService] AI摘要压缩完成: 从 ${summaryResult.originalTokens} tokens 压缩到 ${summaryResult.newTokens} tokens`);

							// E4优化：压缩成功，重置熔断器
							this.tieredCompactionManager.recordCompactionSuccess();

							// 如果压缩后仍在限制内，直接返回
							if (newTokens <= allowedTokens) {
								return;
							}
						}
					} catch (error) {
						console.error(`[TaskService] AI摘要压缩失败:`, error);
						// E4优化：记录失败，更新熔断器计数
						this.tieredCompactionManager.recordCompactionFailure();
						// 压缩失败，继续使用截断策略
					}
				}
			}

		// 最终层：仍然超限，执行消息截断
		console.log(`[TaskService] 处理后仍超限，执行消息截断`);

		// 保留第一条消息（任务描述）
		const firstMessage = this.apiConversationHistory[0];
		const remainingMessages = this.apiConversationHistory.slice(1);

		// 计算需要移除的消息数量
		const rawMessagesToRemove = Math.floor(remainingMessages.length * TRUNCATE_FRACTION);
		// 确保移除偶数个消息（保持user/assistant配对）
		const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2);

		if (messagesToRemove > 0) {
			const keptMessages = remainingMessages.slice(messagesToRemove);
			this.apiConversationHistory = [firstMessage, ...keptMessages];
			this.rebuildCharCount();

			console.log(`[TaskService] 截断完成: 移除了 ${messagesToRemove} 条消息, 剩余 ${this.apiConversationHistory.length} 条`);
		}
	}

	/**
	 * P2优化：在压缩前创建检查点
	 */
	private async createCheckpointBeforeCompaction(): Promise<void> {
		try {
			await this.checkpointManager.createCheckpoint(
				`压缩前检查点 - ${this.apiConversationHistory.length} 条消息`,
				{
					messageCount: this.apiConversationHistory.length,
					messages: [...this.apiConversationHistory],
					tokenUsage: { ...this.tokenUsage },
					timestamp: Date.now()
				}
			);
		} catch (error) {
			console.error('[TaskService] 创建检查点失败:', error);
		}
	}

	/**
	 * P2优化：使用状态锁执行关键操作
	 * TODO: 在关键状态修改处使用
	 */
	// @ts-ignore - TODO: 在关键状态修改处使用
	private async _withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn);
	}

	/**
	 * AI摘要压缩
	 * 调用 AI 生成对话历史的摘要，替换旧消息
	 */
	private async condenseContext(): Promise<{
		success: boolean;
		originalTokens: number;
		newTokens: number;
		summary?: string;
	}> {
		const messages = this.apiConversationHistory as CompactableMessage[];
		const originalTokens = this.estimateTokens(this.apiConversationHistory);

		// 准备压缩数据
		const compactionPlan = this.aiSummaryCompactor.prepareCompaction(messages);

		if (!compactionPlan.needsSummary) {
			return {
				success: false,
				originalTokens,
				newTokens: originalTokens,
			};
		}

		// 发出压缩开始事件（通知 UI）
		this.say('condense_context', JSON.stringify({
			status: 'started',
			prevContextTokens: originalTokens,
			messageCount: messages.length,
		}));

		try {
			// 调用 AI 生成摘要
			const summaryPrompt = compactionPlan.summaryPrompt!;
			const summaryStream = this.apiHandler.createMessage(
				'你是一个专门生成对话摘要的助手。请根据提供的对话历史生成一个详细的摘要，保留所有关键技术细节。',
				[{ role: 'user', content: [{ type: 'text', text: summaryPrompt }] }],
				[] // 不使用工具
			);

			// 提取摘要文本
			let summaryText = '';
			for await (const chunk of summaryStream) {
				if (chunk.type === 'text') {
					summaryText += chunk.text;
				}
			}

			if (!summaryText) {
				throw new Error('AI 返回空摘要');
			}

			// 处理摘要，创建新的消息历史
			const result = this.aiSummaryCompactor.processSummary(
				summaryText,
				compactionPlan.messagesToKeep
			);

			// 更新消息历史
			this.apiConversationHistory = result.messages as MessageParam[];
			this.rebuildCharCount();
			const newTokens = this.estimateTokens(this.apiConversationHistory);

			// 发出压缩完成事件
			this.say('condense_context', JSON.stringify({
				status: 'completed',
				prevContextTokens: originalTokens,
				newContextTokens: newTokens,
				summary: summaryText.substring(0, 200) + '...',
				cost: 0, // 摘要调用的成本（可选）
				autoContinue: true, // 标记将自动继续任务
			}));

			console.log(`[TaskService] AI摘要压缩成功: ${originalTokens} -> ${newTokens} tokens，自动继续任务`);

			return {
				success: true,
				originalTokens,
				newTokens,
				summary: summaryText,
			};

		} catch (error) {
			// 发出压缩错误事件
			this.say('condense_context_error', JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
				prevContextTokens: originalTokens,
			}));

			console.error(`[TaskService] AI摘要压缩失败:`, error);

			return {
				success: false,
				originalTokens,
				newTokens: originalTokens,
			};
		}
	}

	/**
	 * 🚀 智能截断工具结果
	 * 根据内容类型选择不同的截断策略，优先保留关键信息
	 */
	private truncateToolResult(content: string): string {
		if (content.length <= MAX_TOOL_RESULT_LENGTH) {
			return content;
		}

		// 检测内容类型
		const contentType = this.detectContentType(content);
		const originalLength = content.length;

		let result: string;
		switch (contentType) {
			case 'error_log':
				// 错误日志：优先保留错误信息和堆栈
				result = this.truncateErrorLog(content);
				break;
			case 'code':
				// 代码文件：优先保留类定义和函数签名
				result = this.truncateCode(content);
				break;
			case 'json':
				// JSON：保留结构信息
				result = this.truncateJson(content);
				break;
			default:
				// 默认策略：头尾保留
				result = this.truncateDefault(content);
		}

		this.debugLog(`[TaskService] 工具结果截断: ${originalLength} -> ${result.length} 字符, 类型: ${contentType}`);
		return result;
	}

	/**
	 * 检测内容类型
	 */
	private detectContentType(content: string): 'error_log' | 'code' | 'json' | 'default' {
		// 检测JSON
		if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
			return 'json';
		}
		// 检测错误日志
		if (content.includes('Error:') || content.includes('Exception') ||
			content.includes('Traceback') || content.includes('at ') && content.includes('(')) {
			return 'error_log';
		}
		// 检测代码（通过常见关键字）
		if (content.includes('function ') || content.includes('class ') ||
			content.includes('def ') || content.includes('import ') ||
			content.includes('package ') || content.includes('public ') ||
			content.includes('private ')) {
			return 'code';
		}
		return 'default';
	}

	/**
	 * 截断错误日志：优先保留错误信息和堆栈跟踪
	 */
	private truncateErrorLog(content: string): string {
		const lines = content.split('\n');
		const importantLines: string[] = [];
		const otherLines: string[] = [];

		for (const line of lines) {
			// 识别重要行：错误信息、堆栈跟踪、警告
			if (line.includes('Error') || line.includes('Exception') ||
				line.includes('Warning') || line.includes('FAILED') ||
				line.includes('at ') || line.includes('Caused by')) {
				importantLines.push(line);
			} else {
				otherLines.push(line);
			}
		}

		// 优先保留重要行，剩余空间保留其他行
		const maxImportant = Math.floor(MAX_TOOL_RESULT_LENGTH * 0.6);
		const maxOther = MAX_TOOL_RESULT_LENGTH - Math.min(importantLines.join('\n').length, maxImportant);

		let result = importantLines.slice(0, 100).join('\n');
		if (result.length > maxImportant) {
			result = result.substring(0, maxImportant);
		}

		const otherContent = otherLines.join('\n');
		if (otherContent.length > 0 && maxOther > 100) {
			const halfOther = Math.floor(maxOther / 2);
			result = otherContent.substring(0, halfOther) +
				'\n\n... [日志已截断，保留了错误信息] ...\n\n' +
				result;
		}

		return result;
	}

	/**
	 * 截断代码：优先保留类定义和函数签名
	 */
	private truncateCode(content: string): string {
		const lines = content.split('\n');
		const signatureLines: string[] = [];
		const bodyLines: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			// 识别函数/类/方法签名
			if (trimmed.startsWith('function ') || trimmed.startsWith('class ') ||
				trimmed.startsWith('def ') || trimmed.startsWith('public ') ||
				trimmed.startsWith('private ') || trimmed.startsWith('protected ') ||
				trimmed.startsWith('export ') || trimmed.startsWith('interface ') ||
				trimmed.startsWith('import ') || trimmed.startsWith('package ')) {
				signatureLines.push(line);
			} else {
				bodyLines.push(line);
			}
		}

		// 60%空间给签名，40%给函数体
		const maxSignatures = Math.floor(MAX_TOOL_RESULT_LENGTH * 0.6);
		const maxBody = MAX_TOOL_RESULT_LENGTH - maxSignatures;

		let signatures = signatureLines.join('\n');
		if (signatures.length > maxSignatures) {
			signatures = signatures.substring(0, maxSignatures);
		}

		const body = bodyLines.join('\n');
		const halfBody = Math.floor(maxBody / 2);
		const bodyHead = body.substring(0, halfBody);
		const bodyTail = body.substring(body.length - halfBody);

		return `${signatures}\n\n... [代码已截断，保留了签名和部分实现] ...\n\n${bodyHead}\n...\n${bodyTail}`;
	}

	/**
	 * 截断JSON：保留结构信息
	 */
	private truncateJson(content: string): string {
		// 对于JSON，尝试只保留前N个顶级键
		try {
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				// 数组：保留前10个元素
				const truncated = parsed.slice(0, 10);
				return JSON.stringify(truncated, null, 2) +
					`\n\n... [数组已截断，共 ${parsed.length} 个元素，显示前10个] ...`;
			} else if (typeof parsed === 'object') {
				// 对象：保留所有键，但值截断
				const keys = Object.keys(parsed);
				if (keys.length > 20) {
					const truncated: Record<string, any> = {};
					for (let i = 0; i < 20; i++) {
						truncated[keys[i]] = parsed[keys[i]];
					}
					return JSON.stringify(truncated, null, 2) +
						`\n\n... [对象已截断，共 ${keys.length} 个键，显示前20个] ...`;
				}
			}
		} catch {
			// JSON解析失败，使用默认策略
		}
		return this.truncateDefault(content);
	}

	/**
	 * 默认截断策略：头尾保留
	 */
	private truncateDefault(content: string): string {
		const halfLength = Math.floor(MAX_TOOL_RESULT_LENGTH / 2);
		const head = content.substring(0, halfLength);
		const tail = content.substring(content.length - halfLength);

		const truncatedChars = content.length - MAX_TOOL_RESULT_LENGTH;
		return head + `\n\n... [内容已截断，省略了约 ${truncatedChars} 字符] ...\n\n` + tail;
	}

	override dispose(): void {
		this.abort = true;
		super.dispose();
	}
}
