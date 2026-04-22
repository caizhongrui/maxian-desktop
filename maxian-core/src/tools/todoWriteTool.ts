/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * todo_write 工具
 *
 * 规划和跟踪多步任务的 TODO 列表。每次调用全量覆盖当前 Session 的 todo 列表。
 *
 * 参数结构（对齐 Claude Code 规范）：
 *   todos: Array<{
 *     id: string;
 *     content: string;           // 祈使句形式：例如 "Run tests"
 *     status: 'pending' | 'in_progress' | 'completed';
 *     activeForm: string;        // 现在进行时：例如 "Running tests"
 *   }>
 *
 * 约束：
 * - 同时只能有 1 个 in_progress
 * - 多步任务开始前必须先 todo_write 规划
 * - 每次写入是全量替换（非增量）
 */

export type TodoWriteStatus = 'pending' | 'in_progress' | 'completed';

export interface ITodoWriteItem {
	id: string;
	content: string;
	status: TodoWriteStatus;
	activeForm: string;
}

export interface TodoWriteParams {
	todos: ITodoWriteItem[];
}

export interface TodoWriteResult {
	success: boolean;
	message: string;
	todos: ITodoWriteItem[];
}

/**
 * 解析并验证 todo_write 输入
 */
export function parseTodoWriteInput(raw: unknown): { valid: boolean; todos?: ITodoWriteItem[]; error?: string } {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch (e) {
			return { valid: false, error: `todos JSON 解析失败: ${(e as Error).message}` };
		}
	}

	if (!Array.isArray(value)) {
		return { valid: false, error: 'todos 必须是数组' };
	}

	const todos: ITodoWriteItem[] = [];
	let inProgressCount = 0;

	for (let i = 0; i < value.length; i++) {
		const item = value[i] as Partial<ITodoWriteItem> | null;
		if (!item || typeof item !== 'object') {
			return { valid: false, error: `第 ${i + 1} 项不是有效对象` };
		}
		const id = typeof item.id === 'string' ? item.id : '';
		const content = typeof item.content === 'string' ? item.content : '';
		const activeForm = typeof item.activeForm === 'string' ? item.activeForm : '';
		const statusRaw = typeof item.status === 'string' ? item.status : '';

		if (!id) {
			return { valid: false, error: `第 ${i + 1} 项缺少 id 字段` };
		}
		if (!content) {
			return { valid: false, error: `第 ${i + 1} 项缺少 content 字段` };
		}
		if (!activeForm) {
			return { valid: false, error: `第 ${i + 1} 项缺少 activeForm 字段` };
		}
		if (statusRaw !== 'pending' && statusRaw !== 'in_progress' && statusRaw !== 'completed') {
			return { valid: false, error: `第 ${i + 1} 项 status 必须是 pending / in_progress / completed 之一，实际: ${statusRaw}` };
		}
		if (statusRaw === 'in_progress') {
			inProgressCount++;
		}
		todos.push({ id, content, status: statusRaw, activeForm });
	}

	if (inProgressCount > 1) {
		return { valid: false, error: `同时只能有 1 个 in_progress，当前有 ${inProgressCount} 个。请调整后重试。` };
	}

	return { valid: true, todos };
}

/**
 * 格式化 todo 列表为 markdown 文本（带状态 emoji）
 */
export function formatTodoWriteList(todos: ITodoWriteItem[]): string {
	if (todos.length === 0) {
		return '当前没有待办事项。';
	}
	const lines: string[] = ['当前 TODO 列表：', ''];
	for (const t of todos) {
		let icon: string;
		let label: string;
		switch (t.status) {
			case 'pending':
				icon = '⏳';
				label = t.content;
				break;
			case 'in_progress':
				icon = '🔄';
				label = t.activeForm;
				break;
			case 'completed':
				icon = '✅';
				label = t.content;
				break;
		}
		lines.push(`- ${icon} [${t.id}] ${label}`);
	}
	return lines.join('\n');
}

/**
 * 存储当前 Session/Task 的 todo 列表
 */
const todoWriteStore = new Map<string, ITodoWriteItem[]>();

export function setTodoWriteList(sessionId: string, todos: ITodoWriteItem[]): void {
	todoWriteStore.set(sessionId, todos);
}

export function getTodoWriteList(sessionId: string): ITodoWriteItem[] {
	return todoWriteStore.get(sessionId) || [];
}

export function clearTodoWriteList(sessionId: string): void {
	todoWriteStore.delete(sessionId);
}

/**
 * 执行 todo_write 工具：全量替换并返回 markdown 格式结果
 */
export function executeTodoWrite(sessionId: string, rawTodos: unknown): TodoWriteResult {
	const parsed = parseTodoWriteInput(rawTodos);
	if (!parsed.valid || !parsed.todos) {
		return {
			success: false,
			message: `todo_write 参数无效: ${parsed.error}`,
			todos: [],
		};
	}

	setTodoWriteList(sessionId, parsed.todos);

	return {
		success: true,
		message: formatTodoWriteList(parsed.todos),
		todos: parsed.todos,
	};
}

/**
 * todo_write 工具描述（用于 System Prompt / tool schema description）
 */
export const TODO_WRITE_TOOL_DESCRIPTION = `## todo_write
规划和跟踪多步任务的 TODO 列表。

**使用场景**：
- 收到包含 3 步及以上的复杂任务时，必须先调用 todo_write 规划
- 开始某个子任务前把它的 status 改为 in_progress
- 完成子任务后把它的 status 改为 completed

**约束**：
- 每次调用是**全量替换**（不是增量），必须发送完整列表
- **同时只能有 1 个任务处于 in_progress 状态**
- 每项必须包含 id、content（祈使句）、status、activeForm（现在进行时）

**字段说明**：
- id: 唯一标识（字符串，如 "1"、"setup"）
- content: 任务描述，祈使句，例如 "Run tests"
- status: pending | in_progress | completed
- activeForm: 现在进行时描述，例如 "Running tests"（当前 in_progress 时展示此字段）
`;

/**
 * todo_write 工具 JSON Schema（用于 tools 注册列表）
 */
export const TODO_WRITE_TOOL_SCHEMA = {
	name: 'todo_write',
	description: '规划和跟踪多步任务的 TODO 列表',
	parameters: {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						content: { type: 'string' },
						status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
						activeForm: { type: 'string' },
					},
					required: ['id', 'content', 'status', 'activeForm'],
				},
			},
		},
		required: ['todos'],
	},
};
