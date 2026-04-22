/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolUse, ToolResponse, ToolName } from '../types/toolTypes.js';
import { ITodoItem } from './todoStore.js';
import { IBehaviorReporter } from '../interfaces/IBehaviorReporter.js';
import { ToolInteractionRequest } from './toolExecutionProtocol.js';

/**
 * 工具执行器接口
 * 负责执行各种工具调用
 */
export interface IToolExecutor {
	/**
	 * 执行工具调用
	 * @param toolUse 工具使用信息
	 * @returns 工具执行结果
	 */
	executeTool(toolUse: ToolUse): Promise<ToolResponse>;

	/**
	 * 执行工具调用并返回结构化结果。
	 * TaskService 使用此接口判断工具是否真正成功，避免把错误字符串当作成功结果继续推进。
	 */
	executeToolWithResult?(toolUse: ToolUse): Promise<ToolExecutionResult>;

	/**
	 * 在文件真正提交后同步内部缓存状态。
	 */
	clearCommittedStateForPaths?(paths: string[]): void;

	/**
	 * 在进入用户审批前做轻量预检。
	 * 主要用于 edit/multiedit 这类需要基于当前文件精确定位的工具。
	 * 返回 null 表示预检通过；返回失败结果表示应直接阻断并把错误回给模型。
	 */
	preflightToolUse?(toolUse: ToolUse): Promise<ToolExecutionResult | null>;

	/**
	 * 检查工具是否可用
	 * @param toolName 工具名称
	 * @returns 是否可用
	 */
	isToolAvailable(toolName: ToolName): boolean;

	/**
	 * 获取可用工具列表
	 * @returns 可用工具名称数组
	 */
	getAvailableTools(): ToolName[];
}

/**
 * 工具执行上下文
 * 包含执行工具所需的环境信息
 */
export interface ToolExecutionContext {
	cwd: string; // 当前工作目录
	workspaceRoot?: string; // 工作区根目录
	sessionId?: string; // P1-7: 会话ID，用于 Doom Loop 检测
	agentName?: string; // P2-9: Agent名称，用于工具过滤
	/** P2优化：待办列表更新回调（由 maxianService 注入，用于触发 UI 更新） */
	onTodoListUpdate?: (todos: ITodoItem[]) => void;
	/** 行为埋点上报器（由 maxianService 注入） */
	behaviorReporter?: IBehaviorReporter;
}

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
	success: boolean;
	status: 'success' | 'error' | 'fatal_error' | 'blocked_loop' | 'approval_required' | 'input_required';
	code?: string;
	retryable?: boolean;
	nextAction?: 'retry' | 'read_before_write' | 'refocus' | 'ask_user' | 'none';
	result?: ToolResponse;
	error?: string;
	interaction?: ToolInteractionRequest;
	metadata?: {
		toolName?: ToolName;
		affectedPaths?: string[];
		didWrite?: boolean;
		unknownWrite?: boolean;
		mutationEvidence?: 'none' | 'filesystem' | 'heuristic' | 'command-unknown';
		shouldInvalidateSearchCache?: boolean;
		shouldResetReadTracking?: boolean;
		shouldCacheResult?: boolean;
		[key: string]: any;
	};
}
