/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TodoStore - 基于 Session 的待办事项存储
 * 参考 OpenCode todo.ts 实现
 * 每个 Session 独立维护一份待办列表
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TodoPriority = 'high' | 'medium' | 'low';

/**
 * 待办事项接口
 */
export interface ITodoItem {
	/** 唯一标识符 */
	id: string;
	/** 任务内容 */
	content: string;
	/** 状态 */
	status: TodoStatus;
	/** 优先级 */
	priority: TodoPriority;
}

/**
 * 原始待办事项输入（AI 可能传入不同格式）
 */
export interface IRawTodoInput {
	id?: string;
	content?: string;
	status?: string;
	priority?: string;
	// 兼容旧版 activeForm 字段
	activeForm?: string;
}

/**
 * 全局 Session->TodoList 映射
 */
const todoMap = new Map<string, ITodoItem[]>();

/**
 * 解析并验证待办事项列表
 * 兼容多种输入格式
 */
export function parseTodos(raw: IRawTodoInput[]): ITodoItem[] {
	if (!Array.isArray(raw)) {
		throw new Error('todos 必须是数组');
	}

	return raw.map((item, index) => {
		if (typeof item !== 'object' || item === null) {
			throw new Error(`第 ${index + 1} 项不是有效的对象`);
		}

		const content = item.content || item.activeForm || '';
		if (!content.trim()) {
			throw new Error(`第 ${index + 1} 项缺少 content 字段`);
		}

		const status = validateStatus(item.status) || 'pending';
		const priority = validatePriority(item.priority) || 'medium';
		const id = item.id || `todo_${index + 1}_${Date.now()}`;

		return { id, content: content.trim(), status, priority };
	});
}

function validateStatus(value?: string): TodoStatus | null {
	if (!value) { return null; }
	const normalized = value.toLowerCase().trim();
	if (normalized === 'pending' || normalized === 'todo') { return 'pending'; }
	if (normalized === 'in_progress' || normalized === 'in-progress' || normalized === 'active') { return 'in_progress'; }
	if (normalized === 'completed' || normalized === 'done' || normalized === 'complete') { return 'completed'; }
	if (normalized === 'failed' || normalized === 'error' || normalized === 'fail') { return 'failed'; }
	return null;
}

function validatePriority(value?: string): TodoPriority | null {
	if (!value) { return null; }
	const normalized = value.toLowerCase().trim();
	if (normalized === 'high') { return 'high'; }
	if (normalized === 'medium' || normalized === 'normal') { return 'medium'; }
	if (normalized === 'low') { return 'low'; }
	return null;
}

/**
 * 格式化待办事项列表为可读文本
 */
export function formatTodoList(todos: ITodoItem[]): string {
	if (todos.length === 0) {
		return '（待办列表为空）';
	}

	const statusIcon = (s: TodoStatus) => {
		switch (s) {
			case 'completed': return '✅';
			case 'in_progress': return '🔄';
			case 'pending': return '⏳';
			case 'failed': return '❌';
		}
	};

	const priorityLabel = (p: TodoPriority) => {
		switch (p) {
			case 'high': return '[高]';
			case 'medium': return '[中]';
			case 'low': return '[低]';
		}
	};

	return todos
		.map(t => `${statusIcon(t.status)} ${priorityLabel(t.priority)} ${t.content}`)
		.join('\n');
}

/**
 * A8优化: 检查是否所有 todo 都已完成（触发自动清空）
 * 对齐 Claude Code: 全部 completed 时发送 [] 清空列表
 */
export function shouldAutoClean(todos: ITodoItem[]): boolean {
	return todos.length > 0 && todos.every(t => t.status === 'completed' || t.status === 'failed');
}

/**
 * A8优化: 超过 3 个 completed 时注入验证 nudge
 * 对齐 Claude Code: 提醒 AI 检查已完成的 todo 是否真正完成
 */
export function getVerificationNudge(todos: ITodoItem[]): string | null {
	const completedCount = todos.filter(t => t.status === 'completed').length;
	if (completedCount >= 3) {
		return `\n\n[验证提示] 你已标记了 ${completedCount} 个任务为 completed。请确认这些任务确实已完成（运行测试、检查输出），而不仅仅是执行了修改。`;
	}
	return null;
}

/**
 * TodoStore 操作集合
 */
export const TodoStore = {
	/**
	 * 更新 Session 的待办列表
	 */
	update(sessionId: string, todos: ITodoItem[]): void {
		todoMap.set(sessionId, todos);
	},

	/**
	 * 获取 Session 的待办列表
	 */
	get(sessionId: string): ITodoItem[] {
		return todoMap.get(sessionId) || [];
	},

	/**
	 * 清除 Session 的待办列表
	 */
	clear(sessionId: string): void {
		todoMap.delete(sessionId);
	},

	/**
	 * 获取所有 Session ID
	 */
	getAllSessionIds(): string[] {
		return Array.from(todoMap.keys());
	}
};
