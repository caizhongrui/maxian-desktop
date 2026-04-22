/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Message Bus (Event Stream) Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 消息总线抽象接口。
 *
 * 核心职责：把 Agent 执行过程中的事件流推送给 UI 层。
 *
 * 实现方：
 * - IDE：基于 VSCode Emitter（同进程，同步回调）
 * - Desktop：基于 Tauri IPC（跨进程，异步 JSON Lines 传输）
 */
export interface IMessageBus {
	/**
	 * 发送事件到 UI 层。
	 * Core 内部调用此方法广播各种事件（工具调用、流式响应等）。
	 */
	emit(event: MaxianEvent): void;

	/**
	 * 监听来自 UI 的命令。
	 * 如用户主动取消任务、切换模式等。
	 */
	onCommand(handler: (command: MaxianCommand) => void): IDisposable;
}

/** 可销毁对象 */
export interface IDisposable {
	dispose(): void;
}

/** Core → UI 的事件类型（联合类型，按 type 字段区分） */
export type MaxianEvent =
	| AssistantMessageEvent
	| ReasoningEvent
	| ToolCallStartEvent
	| ToolCallArgsStreamingEvent
	| ToolCallResultEvent
	| TodoListUpdateEvent
	| TokenUsageEvent
	| TaskStatusEvent
	| ErrorEvent
	| FileChangeEvent
	| CompletionEvent;

/** AI 助手消息（流式文本） */
export interface AssistantMessageEvent {
	type: 'assistant_message';
	sessionId: string;
	content: string;
	/** 是否为流式中间结果（true = 正在流式输出，false = 已完成） */
	isPartial: boolean;
}

/** 思考过程（reasoning） */
export interface ReasoningEvent {
	type: 'reasoning';
	sessionId: string;
	content: string;
	isPartial: boolean;
}

/** 工具调用开始 */
export interface ToolCallStartEvent {
	type: 'tool_call_start';
	sessionId: string;
	toolUseId: string;
	toolName: string;
}

/** 工具参数流式构建（展示给用户看的进度） */
export interface ToolCallArgsStreamingEvent {
	type: 'tool_call_args_streaming';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	partialArgs: string;
}

/** 工具调用结果 */
export interface ToolCallResultEvent {
	type: 'tool_call_result';
	sessionId: string;
	toolUseId: string;
	toolName: string;
	success: boolean;
	result: string;
	errorMessage?: string;
}

/** TODO 列表更新 */
export interface TodoListUpdateEvent {
	type: 'todo_list_update';
	sessionId: string;
	todos: TodoItem[];
}

export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** Token 使用量更新 */
export interface TokenUsageEvent {
	type: 'token_usage';
	sessionId: string;
	inputTokens: number;
	outputTokens: number;
	contextTokens: number;
	totalCost?: number;
}

/** 任务状态变化 */
export interface TaskStatusEvent {
	type: 'task_status';
	sessionId: string;
	status: 'pending' | 'processing' | 'completed' | 'error' | 'aborted';
}

/** 错误事件 */
export interface ErrorEvent {
	type: 'error';
	sessionId: string;
	message: string;
	code?: string;
}

/** 文件变更通知 */
export interface FileChangeEvent {
	type: 'file_change';
	sessionId: string;
	changes: FileChangeSummary[];
}

export interface FileChangeSummary {
	path: string;
	action: 'created' | 'modified' | 'deleted';
	linesAdded?: number;
	linesRemoved?: number;
}

/** 任务完成事件 */
export interface CompletionEvent {
	type: 'completion';
	sessionId: string;
	resultSummary?: string;
}

/** UI → Core 的命令类型 */
export type MaxianCommand =
	| { type: 'send_message'; sessionId: string; text: string; images?: string[] }
	| { type: 'cancel_task'; sessionId: string }
	| { type: 'approve_tool'; sessionId: string; toolUseId: string; approved: boolean; feedback?: string }
	| { type: 'switch_mode'; sessionId: string; mode: 'code' | 'ask' | 'debug' | 'architect' | 'solo' }
	| { type: 'resume_task'; sessionId: string };
