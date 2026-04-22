/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Edit 工具
 * 参考 OpenCode tool/edit.ts 实现
 *
 * 功能：
 * - 基于 old_string/new_string 的字符串替换
 * - 精确匹配，找不到或多匹配直接失败
 * - 支持全局替换（replace_all）
 * - 自动创建不存在的文件
 * - 详细的执行结果反馈
 *
 * 优势：
 * - 比 apply_diff 更简单直观
 * - 失败更早暴露，减少在错误上下文上继续误改
 * - 支持单处/多处替换
 */

import { fuzzyReplace } from '../diff/fuzzyMatch.js';

/**
 * Edit 工具参数
 */
export interface EditParams {
	/** 文件路径（必需） */
	path: string;
	/** 要查找的旧字符串（必需，除非创建新文件） */
	old_string?: string;
	/** 替换为的新字符串（必需） */
	new_string: string;
	/** 是否替换所有匹配项（默认 false） */
	replace_all?: boolean;
	/** 是否创建新文件（当文件不存在时） */
	create_if_missing?: boolean;
}

/**
 * Edit 执行结果
 */
export interface EditResult {
	/** 是否成功 */
	success: boolean;
	/** 结果消息 */
	message: string;
	/** 修改后的文件内容（成功时） */
	newContent?: string;
	/** 使用的匹配策略 */
	strategy?: string;
	/** 替换的匹配数量 */
	matchCount?: number;
	/** 是否创建了新文件 */
	created?: boolean;
	/** 文件路径 */
	path: string;
}

/**
 * Edit 工具配置
 */
export const EDIT_TOOL_CONFIG = {
	/** 最大文件大小（字节） */
	MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB

	/** 是否自动创建目录 */
	AUTO_CREATE_DIRECTORY: true,
};

/**
 * 验证 Edit 参数
 */
export function validateEditParams(params: Partial<EditParams>): {
	valid: boolean;
	error?: string;
	params?: EditParams;
} {
	// 检查必需参数
	if (!params.path) {
		return {
			valid: false,
			error: '缺少必需参数: path (文件路径)',
		};
	}

	if (params.new_string === undefined) {
		return {
			valid: false,
			error: '缺少必需参数: new_string (新内容)',
		};
	}

	// 创建新文件时不需要 old_string
	const isCreatingFile = params.create_if_missing && !params.old_string;

	if (!isCreatingFile && !params.old_string) {
		return {
			valid: false,
			error: '缺少必需参数: old_string (要替换的内容)。如果要创建新文件，请设置 create_if_missing: true',
		};
	}

	return {
		valid: true,
		params: {
			path: params.path,
			old_string: params.old_string,
			new_string: params.new_string,
			replace_all: params.replace_all ?? false,
			create_if_missing: params.create_if_missing ?? false,
		},
	};
}

/**
 * 执行 Edit 操作
 * @param content 当前文件内容（null 表示文件不存在）
 * @param params Edit 参数
 */
export function executeEdit(
	content: string | null,
	params: EditParams
): EditResult {
	const { path, old_string, new_string, replace_all, create_if_missing } = params;

	// 文件不存在的情况
	if (content === null) {
		if (create_if_missing) {
			// 创建新文件
			return {
				success: true,
				message: `已创建新文件: ${path}`,
				newContent: new_string,
				created: true,
				path,
			};
		} else {
			return {
				success: false,
				message: `文件不存在: ${path}\n\n如需创建新文件，请设置 create_if_missing: true`,
				path,
			};
		}
	}

	// old_string 为空，表示追加内容或替换整个文件
	if (!old_string) {
		if (content === '') {
			// 空文件，直接写入
			return {
				success: true,
				message: `已向空文件写入内容: ${path}`,
				newContent: new_string,
				matchCount: 1,
				path,
			};
		}
		// 非空文件，要求提供 old_string
		return {
			success: false,
			message: `文件非空，需要提供 old_string 参数来指定要替换的内容。\n文件前100字符: ${content.substring(0, 100)}...`,
			path,
		};
	}

	// 明确阻断同内容替换，避免无效写入重试
	if (old_string === new_string) {
		return {
			success: false,
			message: 'edit 未产生任何修改：old_string 与 new_string 完全相同',
			path,
		};
	}

	const exactMatchCount = content.split(old_string).length - 1;
	if (exactMatchCount > 1 && !replace_all) {
		return {
			success: false,
			message: 'Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.',
			path,
		};
	}

	const fuzzy = fuzzyReplace(content, old_string, new_string, !!replace_all);
	if (!fuzzy.success) {
		if (fuzzy.error) {
			return {
				success: false,
				message: fuzzy.error,
				path,
			};
		}
		return {
			success: false,
			message: 'oldString not found in content',
			path,
		};
	}

	if (fuzzy.result === content) {
		return {
			success: false,
			message: 'edit 未产生任何修改：替换后内容与原文件一致',
			path,
		};
	}

	const successMessage = fuzzy.warning
		? `Edit applied successfully. ${fuzzy.warning}`
		: `Edit applied successfully.`;

	return {
		success: true,
		message: successMessage,
		newContent: fuzzy.result,
		strategy: fuzzy.strategy || (exactMatchCount > 0 ? 'exact' : 'fuzzy'),
		matchCount: fuzzy.matchCount,
		path,
	};
}


/**
 * 格式化 Edit 结果为响应文本
 * 成功时包含文件名和行数统计，帮助模型了解当前状态
 */
export function formatEditResponse(result: EditResult, newString?: string): string {
	if (!result.success || !result.newContent || !result.path) {
		return result.message;
	}

	const filename = result.path.split('/').pop() || result.path;
	const lines = result.newContent.split('\n');
	const totalLines = lines.length;
	const strategyHint = result.strategy === 'fuzzy' ? ' (fuzzy match)' : '';

	let contextSnippet = '';
	if (newString && result.newContent) {
		// 定位修改区域：找到 new_string 首行在新内容中的位置
		const newFirstLine = newString.split('\n')[0].trim();
		if (newFirstLine.length > 5) {
			const lineIdx = lines.findIndex(l => l.trim().includes(newFirstLine));
			if (lineIdx >= 0) {
				// 提取修改区域前后各 5 行（方便模型确认修改后状态，省去额外 read_file）
				const start = Math.max(0, lineIdx - 5);
				const end = Math.min(lines.length, lineIdx + newString.split('\n').length + 5);
				const snippet = lines.slice(start, end)
					.map((l, i) => `${start + i + 1} | ${l}`)
					.join('\n');
				contextSnippet = `\n\nContext (lines ${start + 1}-${end}):\n${snippet}`;
			}
		}
	}

	return `Edit applied successfully.${strategyHint} File: ${filename} (${totalLines} lines)${contextSnippet}`;
}

/**
 * Edit 工具描述（用于 System Prompt）
 * 参考 OpenCode 的详细描述格式
 */
export const EDIT_TOOL_DESCRIPTION = `## edit
Performs robust string replacements in files.

**关键约束（违反将被 preflight 拦截，工具根本不会执行）：**
- 编辑前**必须**通过 read_file 完整读取该文件。若上一次仅通过 start_line/end_line 做了局部读取，必须先重新进行一次不带范围参数的完整读取。
- 如果距上次 read_file 已经经过 edit/multiedit/apply_diff 或用户改动，必须重新 read_file 后再编辑。系统会通过 FileStateCache 自动检测并拒绝过期编辑。
- old_string 必须从最近一次 read_file 的输出中**逐字节精确复制**，包括所有空白、制表符、缩进与换行——**禁止凭记忆、猜测或改写重排**。
- 优先使用**最小的唯一上下文**（通常 2-4 行相邻代码）作为 old_string。不要为了保险堆叠 10+ 行，过长反而容易因为行尾空白或缩进细节失配。
- 如果 old_string 在文件中出现多处，要么扩展上下文使其唯一，要么显式设置 replace_all=true。默认 replace_all=false 时多处匹配会直接失败。
- old_string 不能等于 new_string，否则视为无效操作。
- 同一文件不要用 write_to_file 反复整文件重写，修改已有文件请使用 edit / multiedit。

Usage:
- 必须先使用 read_file 完整读取文件，然后再编辑
- 优先精确匹配；若精确匹配失败，会尝试安全容错（空白/缩进/引号归一）
- 如果 old_string 在文件中不存在，编辑会失败并返回 "oldString not found in content"
- 如果 old_string 命中多处且 replace_all=false，会失败并要求提供更多上下文
- 优先编辑已有文件，只有在明确需要时才创建新文件
- 工具失败后**不要**用完全相同的参数重试——先重新 read_file 确认当前内容，再调整 old_string 后再试

**参数：**
- path (必需): 要编辑的文件路径
- old_string (必需): 要被替换的原始内容。必须与文件中的内容精确匹配
- new_string (必需): 替换后的新内容
- replace_all (可选): 设为 true 则替换所有匹配项，默认只替换第一处
- create_if_missing (可选): 设为 true 则在文件不存在时创建新文件

**示例 1 - 修改函数实现：**
<edit>
<path>src/utils/math.ts</path>
<old_string>function add(a: number, b: number): number {
    return a + b;
}</old_string>
<new_string>function add(a: number, b: number): number {
    // 添加参数验证
    if (typeof a !== 'number' || typeof b !== 'number') {
        throw new Error('Parameters must be numbers');
    }
    return a + b;
}</new_string>
</edit>

**示例 2 - 全局替换：**
<edit>
<path>src/config.ts</path>
<old_string>DEBUG = false</old_string>
<new_string>DEBUG = true</new_string>
<replace_all>true</replace_all>
</edit>

**示例 3 - 创建新文件：**
<edit>
<path>src/newFile.ts</path>
<new_string>export const VERSION = '1.0.0';</new_string>
<create_if_missing>true</create_if_missing>
</edit>
`;

/**
 * Edit 工具 JSON Schema
 */
export const EDIT_TOOL_SCHEMA = {
	name: 'edit',
	description: '编辑文件内容，通过 old_string/new_string 进行字符串替换（优先精确匹配，失败时安全容错）',
	input_schema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: '要编辑的文件路径',
			},
			old_string: {
				type: 'string',
				description: '要被替换的原始内容',
			},
			new_string: {
				type: 'string',
				description: '替换后的新内容',
			},
			replace_all: {
				type: 'boolean',
				description: '是否替换所有匹配项',
				default: false,
			},
			create_if_missing: {
				type: 'boolean',
				description: '文件不存在时是否创建',
				default: false,
			},
		},
		required: ['path', 'new_string'],
	},
};
