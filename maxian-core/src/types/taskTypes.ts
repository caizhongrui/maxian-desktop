/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Task Types
 *
 *  Task 相关的类型定义 — 纯类型，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

import type { ToolName } from './toolTypes.js';

export type { ToolName };

/** Task 状态枚举 */
export enum TaskStatus {
	IDLE = 'idle',
	PROCESSING = 'processing',
	WAITING_FOR_USER = 'waiting_for_user',
	COMPLETED = 'completed',
	ERROR = 'error',
	ABORTED = 'aborted',
}

/** 所有需要用户响应的消息类型 */
export type ClineAsk =
	| 'followup'
	| 'command'
	| 'command_output'
	| 'completion_result'
	| 'tool'
	| 'api_req_failed'
	| 'resume_task'
	| 'resume_completed_task'
	| 'mistake_limit_reached'
	| 'browser_action_launch'
	| 'use_mcp_server'
	| 'auto_approval_max_req_reached';

/** 所有 AI 主动发送的消息类型 */
export type ClineSay =
	| 'error'
	| 'api_req_started'
	| 'api_req_finished'
	| 'api_req_retried'
	| 'api_req_retry_delayed'
	| 'api_req_deleted'
	| 'text'
	| 'task'
	| 'tool'
	| 'image'
	| 'reasoning'
	| 'completion_result'
	| 'user_feedback'
	| 'user_feedback_diff'
	| 'command_output'
	| 'shell_integration_warning'
	| 'browser_action'
	| 'browser_action_result'
	| 'mcp_server_request_started'
	| 'mcp_server_response'
	| 'subtask_result'
	| 'checkpoint_saved'
	| 'rooignore_error'
	| 'diff_error'
	| 'condense_context'
	| 'condense_context_error'
	| 'codebase_search_result'
	| 'user_edit_todos'
	| 'file_changes'
	| 'system_internal';

/** Ask 响应类型 */
export type ClineAskResponse = 'yesButtonClicked' | 'noButtonClicked' | 'messageResponse';

/** 工具进度状态 */
export interface ToolProgressStatus {
	icon?: string;
	text?: string;
}

/** Context 压缩信息 */
export interface ContextCondense {
	cost: number;
	prevContextTokens: number;
	newContextTokens: number;
	summary: string;
	autoContinue?: boolean;
}

/** Cline 消息 */
export interface ClineMessage {
	ts: number;
	type: 'ask' | 'say';
	ask?: ClineAsk;
	say?: ClineSay;
	text?: string;
	images?: string[];
	partial?: boolean;
	reasoning?: string;
	conversationHistoryIndex?: number;
	checkpoint?: Record<string, unknown>;
	progressStatus?: ToolProgressStatus;
	contextCondense?: ContextCondense;
	isProtected?: boolean;
	tool?: ToolName;
	isAnswered?: boolean;
	metadata?: {
		kiloCode?: Record<string, unknown>;
	};
}

/** Token 使用统计 */
export interface TokenUsage {
	totalTokensIn: number;
	totalTokensOut: number;
	totalCacheWrites?: number;
	totalCacheReads?: number;
	totalCost: number;
	contextTokens: number;
}

/** 工具使用统计 */
export interface ToolUsage {
	[toolName: string]: number;
}

/** API 请求取消原因 */
export enum ClineApiReqCancelReason {
	UserCancelled = 'user_cancelled',
	ReachedMistakeLimit = 'reached_mistake_limit',
	AutoRejected = 'auto_rejected',
}

/** 任务元数据 */
export interface TaskMetadata {
	taskId: string;
	createdAt: number;
	updatedAt: number;
	tokensUsed?: TokenUsage;
	toolsUsed?: ToolUsage;
	status: TaskStatus;
}

/** 历史记录项 */
export interface HistoryItem {
	id: string;
	taskId: string;
	timestamp: number;
	task: string;
	status: TaskStatus;
	tokensUsed?: TokenUsage;
}

/** 创建任务选项 */
export interface CreateTaskOptions {
	task?: string;
	images?: string[];
	historyItem?: HistoryItem;
}

/** 队列消息 */
export interface QueuedMessage {
	timestamp: number;
	id: string;
	text: string;
	images?: string[];
}

/** 任务事件 */
export interface TaskEvents {
	statusChanged: (status: TaskStatus) => void;
	messageAdded: (message: ClineMessage) => void;
	tokenUsageUpdated: (usage: TokenUsage) => void;
	userInputRequired: (data: {
		question: string;
		toolUseId: string;
		options?: Array<{ label: string; description?: string; value?: string }>;
	}) => void;
}

// ─── 类型判定辅助 ────────────────────────────────────────

export const idleAsks: readonly ClineAsk[] = [
	'completion_result',
	'api_req_failed',
	'resume_completed_task',
	'mistake_limit_reached',
	'auto_approval_max_req_reached',
];

export function isIdleAsk(ask: ClineAsk): boolean {
	return idleAsks.includes(ask);
}

export const resumableAsks: readonly ClineAsk[] = ['resume_task'];

export function isResumableAsk(ask: ClineAsk): boolean {
	return resumableAsks.includes(ask);
}

export const interactiveAsks: readonly ClineAsk[] = [
	'followup',
	'command',
	'tool',
	'browser_action_launch',
	'use_mcp_server',
];

export function isInteractiveAsk(ask: ClineAsk): boolean {
	return interactiveAsks.includes(ask);
}
