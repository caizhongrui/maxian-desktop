/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolExecutor, ToolExecutionResult } from './toolExecutor.js';
import { ToolUse, ToolResponse, ToolName } from '../types/toolTypes.js';

/**
 * FilteredToolExecutor - 带工具集过滤的工具执行器
 * 用于子 Agent 系统，限制子 Agent 可使用的工具集
 *
 * 特性：
 * - 包装内部 IToolExecutor
 * - 仅允许 allowedTools 集合中的工具
 * - attempt_completion / ask_followup_question 始终透传（由 TaskService 直接处理）
 * - 禁止 task 工具（防止递归子 Agent）
 */
export class FilteredToolExecutor implements IToolExecutor {
	constructor(
		private readonly inner: IToolExecutor,
		private readonly allowedTools: Set<string>
	) {}

	/**
	 * 检查工具是否可用（对子 Agent 可见）
	 */
	isToolAvailable(toolName: ToolName): boolean {
		// task 工具永远禁止，防止无限递归
		if (toolName === 'task') {
			return false;
		}
		// attempt_completion 和 ask_followup_question 始终可用
		if (toolName === 'attempt_completion' || toolName === 'ask_followup_question') {
			return true;
		}
		return this.allowedTools.has(toolName) && this.inner.isToolAvailable(toolName);
	}

	/**
	 * 获取子 Agent 可用的工具列表
	 */
	getAvailableTools(): ToolName[] {
		return this.inner.getAvailableTools().filter(t => this.isToolAvailable(t));
	}

	/**
	 * 执行工具调用（带过滤拦截）
	 */
	async executeTool(toolUse: ToolUse): Promise<ToolResponse> {
		// task 工具永远禁止（防递归）
		if (toolUse.name === 'task') {
			return `<error>
子 Agent 不允许调用 task 工具，以防止无限递归。
请直接完成分配给您的任务，而不是派发更多子 Agent。
</error>`;
		}

		// attempt_completion 和 ask_followup_question 始终透传
		if (toolUse.name === 'attempt_completion' || toolUse.name === 'ask_followup_question') {
			return this.inner.executeTool(toolUse);
		}

		// 检查工具是否在允许集合中
		if (!this.allowedTools.has(toolUse.name)) {
			const allowedList = Array.from(this.allowedTools).sort().join(', ');
			return `<error>
子 Agent 无权使用工具 "${toolUse.name}"。
此 Agent 类型仅允许以下工具: ${allowedList}
</error>`;
		}

		return this.inner.executeTool(toolUse);
	}

	async executeToolWithResult(toolUse: ToolUse): Promise<ToolExecutionResult> {
		const detailedExecutor = this.inner as IToolExecutor & {
			executeToolWithResult?: (toolUse: ToolUse) => Promise<ToolExecutionResult>;
		};

		if (toolUse.name === 'task') {
			return {
				success: false,
				status: 'error',
				result: `<error>
子 Agent 不允许调用 task 工具，以防止无限递归。
请直接完成分配给您的任务，而不是派发更多子 Agent。
</error>`,
				error: '子 Agent 不允许调用 task 工具',
				metadata: { toolName: toolUse.name, shouldCacheResult: false }
			};
		}

		if (toolUse.name === 'attempt_completion' || toolUse.name === 'ask_followup_question') {
			if (typeof detailedExecutor.executeToolWithResult === 'function') {
				return detailedExecutor.executeToolWithResult(toolUse);
			}
			return {
				success: true,
				status: 'success',
				result: await this.inner.executeTool(toolUse),
				metadata: { toolName: toolUse.name, shouldCacheResult: false }
			};
		}

		if (!this.allowedTools.has(toolUse.name)) {
			const allowedList = Array.from(this.allowedTools).sort().join(', ');
			return {
				success: false,
				status: 'error',
				result: `<error>
子 Agent 无权使用工具 "${toolUse.name}"。
此 Agent 类型仅允许以下工具: ${allowedList}
</error>`,
				error: `子 Agent 无权使用工具 "${toolUse.name}"`,
				metadata: { toolName: toolUse.name, shouldCacheResult: false }
			};
		}

		if (typeof detailedExecutor.executeToolWithResult === 'function') {
			return detailedExecutor.executeToolWithResult(toolUse);
		}

		return {
			success: true,
			status: 'success',
			result: await this.inner.executeTool(toolUse),
			metadata: { toolName: toolUse.name }
		};
	}

	/**
	 * 获取允许的工具集（用于调试）
	 */
	getAllowedTools(): string[] {
		return Array.from(this.allowedTools);
	}

	clearCommittedStateForPaths(paths: string[]): void {
		this.inner.clearCommittedStateForPaths?.(paths);
	}

	async preflightToolUse(toolUse: ToolUse): Promise<ToolExecutionResult | null> {
		return this.inner.preflightToolUse?.(toolUse) ?? null;
	}
}
