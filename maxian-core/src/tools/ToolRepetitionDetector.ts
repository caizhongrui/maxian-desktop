/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode: src/core/tools/ToolRepetitionDetector.ts
// Adapted for tianhe-zhikai-ide: 使用本地i18n系统
// P2优化：增强Doom Loop检测（借鉴Cline）

import { ToolUse } from '../types/toolTypes.js';
import { t } from '../i18n/index.js';
import * as path from 'node:path';

/**
 * P2优化：工具调用历史条目
 */
interface ToolCallHistoryEntry {
	name: string;
	paramsHash: string;
	timestamp: number;
	/** 可选：工具目标文件路径（已规范化），仅对 lsp / 写入类工具记录，用于"中间写入清零 lsp 循环计数"逻辑 */
	path?: string;
}

interface TaskDelegationEntry {
	key: string;
	subagentType: string;
	timestamp: number;
}

/**
 * Class for detecting consecutive identical tool calls
 * to prevent the AI from getting stuck in a loop.
 * P2优化：增强Doom Loop检测，包括循环模式和API调用次数检测
 */
export class ToolRepetitionDetector {
	private previousToolCallJson: string | null = null;
	private consecutiveIdenticalToolCallCount: number = 0;
	private readonly consecutiveIdenticalToolCallLimit: number;
	/**
	 * 写入类工具（edit / multiedit / apply_diff / write_to_file / patch）专用的严格阈值。
	 * 对这类工具，连续相同调用 2 次就必须拦截——一次重试已经足够说明模型用了相同参数重试，
	 * 继续放行只会在同一个失败点反复撞墙。
	 */
	private readonly writeToolConsecutiveLimit: number = 2;
	private readonly workspaceRoot: string;

	// P2优化：Doom Loop检测
	private toolCallHistory: ToolCallHistoryEntry[] = [];
	private readonly HISTORY_WINDOW_SIZE = 20; // 保留最近20个工具调用
	private readonly LOOP_DETECTION_THRESHOLD = 3; // 🔥 优化：降低到3次（从5次），更快检测死循环
	private readonly TIME_WINDOW_MS = 60000; // 60秒时间窗口
	private doomLoopDetected = false;
	private doomLoopCount = 0;

	// 原始字节级写入签名（绕开规范化，专门用于捕捉"完全相同的 old_string 重试"）
	private lastRawWriteSignature: string | null = null;

	// 同一文件反复写入检测
	private fileWriteHistory: Array<{ file: string; tool: string; signature: string; timestamp: number }> = [];
	private readonly WRITE_TOOLS = new Set(['apply_diff', 'edit', 'write_to_file', 'multiedit', 'patch']);
	private taskDelegationHistory: TaskDelegationEntry[] = [];
	private readonly TASK_DELEGATION_LOOP_THRESHOLD = 2;

	/**
	 * 最近的错误签名队列（最多保留 10 个）。
	 * 同一签名出现 ≥3 次时，check() 会立即拒绝后续同类调用。
	 */
	private recentErrorSignatures: string[] = [];
	private readonly ERROR_SIGNATURE_HISTORY_SIZE = 10;
	private readonly SAME_ERROR_LOOP_THRESHOLD = 3;
	/**
	 * Creates a new ToolRepetitionDetector
	 * @param limit The maximum number of identical consecutive tool calls allowed (default: 3)
	 */
	constructor(limit: number = 3, workspaceRoot: string = '') {
		this.consecutiveIdenticalToolCallLimit = limit;
		this.workspaceRoot = this.normalizePathValue(workspaceRoot);
	}

	/**
	 * Checks if the current tool call is identical to the previous one
	 * and determines if execution should be allowed
	 * P2优化：增加Doom Loop检测
	 *
	 * @param currentToolCallBlock ToolUse object representing the current tool call
	 * @returns Object indicating if execution is allowed and a message to show if not
	 */
	public check(currentToolCallBlock: ToolUse): {
		allowExecution: boolean;
		askUser?: {
			messageKey: string;
			messageDetail: string;
		};
	} {
		// Serialize the block to a canonical JSON string for comparison
		const normalizedToolCall = this.normalizeToolUse(currentToolCallBlock);
		const currentToolCallJson = JSON.stringify(normalizedToolCall);
		const paramsHash = this.hashParams(normalizedToolCall.parameters);

		// P2优化：记录到历史（同时登记 path 以便 lsp 循环检测豁免）
		const entryPath = this.normalizePathValue((currentToolCallBlock.params as any)?.path as string | undefined) || undefined;
		this.addToHistory(currentToolCallBlock.name, paramsHash, entryPath);

		// Same-error-loop 检测：若历史中存在同一 error signature 出现 ≥3 次，
		// 立即拦截当前调用，要求模型换一种参数/策略。
		const sameErrorInfo = this.findDominantErrorSignature();
		if (sameErrorInfo) {
			return {
				allowExecution: false,
				askUser: {
					messageKey: 'doom_loop_detected',
					messageDetail: `🔴 same_error_loop: 最近同一错误签名出现了 ${sameErrorInfo.count} 次。签名：${sameErrorInfo.signature}\n\n请先分析失败原因，更换参数或策略后再重试；禁止继续用相同的调用方式撞墙。`,
				},
			};
		}

		// 同一文件反复写入检测（优先级最高，在连续相同检测之前）
		if (this.WRITE_TOOLS.has(currentToolCallBlock.name)) {
			// 对 edit 类工具额外做一次"原始字节级"签名检查，绕开规范化带来的宽松匹配：
			// 即使规范化后看起来不一样的两次 edit，只要原始 old_string/new_string 字节完全相同，
			// 就立即判定为重试并拦截。这能兜住"复制粘贴同一失败参数"这种最常见的死循环。
			const rawSignature = this.buildRawWriteSignature(currentToolCallBlock);
			if (rawSignature && this.lastRawWriteSignature === rawSignature) {
				return {
					allowExecution: false,
					askUser: {
						messageKey: 'doom_loop_detected',
						messageDetail: `🔴 检测到对写入工具 "${currentToolCallBlock.name}" 的字节级完全相同的重复调用。上一次调用刚刚失败或未产生效果，本次参数完全未变。请先 read_file 确认当前文件状态，再调整参数——禁止使用完全相同的 old_string / diff / content 重试。`,
					},
				};
			}
			if (rawSignature) {
				this.lastRawWriteSignature = rawSignature;
			}

			const fileWriteResult = this.detectSameFileWriteLoop(currentToolCallBlock, paramsHash);
			if (fileWriteResult.detected) {
				this.doomLoopDetected = true;
				this.doomLoopCount++;
				return {
					allowExecution: false,
					askUser: {
						messageKey: 'doom_loop_detected',
						messageDetail: fileWriteResult.message,
					},
				};
			}
		} else {
			// 非写入工具调用会"打断"字节级连续重试的判断
			this.lastRawWriteSignature = null;
		}

		if (currentToolCallBlock.name === 'task') {
			const repeatedTaskResult = this.detectRepeatedTaskDelegation(currentToolCallBlock);
			if (repeatedTaskResult.detected) {
				this.doomLoopDetected = true;
				this.doomLoopCount++;
				return {
					allowExecution: false,
					askUser: {
						messageKey: 'doom_loop_detected',
						messageDetail: repeatedTaskResult.message,
					},
				};
			}
		}

		const oscillationResult = this.detectFileReadWriteOscillation(currentToolCallBlock);
		if (oscillationResult.detected) {
			this.doomLoopDetected = true;
			this.doomLoopCount++;
			return {
				allowExecution: false,
				askUser: {
					messageKey: 'doom_loop_detected',
					messageDetail: oscillationResult.message,
				},
			};
		}

		// 连续相同检测
		if (this.previousToolCallJson === currentToolCallJson) {
			this.consecutiveIdenticalToolCallCount++;
		} else {
			this.consecutiveIdenticalToolCallCount = 0;
			this.previousToolCallJson = currentToolCallJson;
		}

		// 写入类工具走更严的阈值：同参数同工具连续调用 2 次就拦截
		// 这里 consecutiveIdenticalToolCallCount 是"重复次数"（0 代表第一次出现），
		// 所以 >=1 即表示"第二次连续相同"
		const isWriteTool = this.WRITE_TOOLS.has(currentToolCallBlock.name);
		const effectiveLimit = isWriteTool
			? Math.min(this.writeToolConsecutiveLimit, this.consecutiveIdenticalToolCallLimit)
			: this.consecutiveIdenticalToolCallLimit;

		// 检查连续相同限制
		if (
			effectiveLimit > 0 &&
			this.consecutiveIdenticalToolCallCount >= effectiveLimit
		) {
			this.consecutiveIdenticalToolCallCount = 0;
			this.previousToolCallJson = null;

			return {
				allowExecution: false,
				askUser: {
					messageKey: 'mistake_limit_reached',
					messageDetail: t('tools:toolRepetitionLimitReached', {
						toolName: currentToolCallBlock.name,
						limit: effectiveLimit
					}),
				},
			};
		}

		// P2优化：Doom Loop检测（时间窗口内的循环模式）
		const doomLoopResult = this.detectDoomLoop(currentToolCallBlock.name, paramsHash);
		if (doomLoopResult.detected) {
			this.doomLoopDetected = true;
			this.doomLoopCount++;

			return {
				allowExecution: false,
				askUser: {
					messageKey: 'doom_loop_detected',
					messageDetail: doomLoopResult.message,
				},
			};
		}

		return { allowExecution: true };
	}

	/**
	 * P2优化：添加工具调用到历史
	 */
	private addToHistory(name: string, paramsHash: string, path?: string): void {
		const entry: ToolCallHistoryEntry = {
			name,
			paramsHash,
			timestamp: Date.now(),
			path
		};

		this.toolCallHistory.push(entry);

		// 限制历史大小
		if (this.toolCallHistory.length > this.HISTORY_WINDOW_SIZE) {
			this.toolCallHistory.shift();
		}
	}

	/**
	 * P2优化：检测Doom Loop
	 * 在时间窗口内，如果同一工具调用超过阈值次数，触发检测
	 */
	private detectDoomLoop(name: string, paramsHash: string): { detected: boolean; message: string } {
		// read_file 已有专用重复读取治理（缓存 + guidance），避免双重拦截导致误伤。
		if (name === 'read_file') {
			return { detected: false, message: '' };
		}

		const now = Date.now();
		const windowStart = now - this.TIME_WINDOW_MS;

		// lsp 是纯只读验证工具：每次对同一文件的 edit/multiedit/write_to_file/apply_diff/patch
		// 都代表"文件状态已改变，前面的 lsp 结果已失效"，应作为循环计数的清零点。
		// 于是 lsp 的有效起点 = max(windowStart, 最近一次对同路径的写入时间 + 1)。
		// 同时 lsp 的阈值放宽到 5，避免"改一版看诊断再改"这种正常修复闭环被误杀。
		let effectiveWindowStart = windowStart;
		let threshold = this.LOOP_DETECTION_THRESHOLD;
		if (name === 'lsp') {
			threshold = 5;
			// 从当前 entry 反向找 path
			const currentEntry = this.toolCallHistory[this.toolCallHistory.length - 1];
			const currentPath = currentEntry?.path;
			if (currentPath) {
				for (let i = this.toolCallHistory.length - 1; i >= 0; i--) {
					const e = this.toolCallHistory[i];
					if (this.WRITE_TOOLS.has(e.name) && e.path === currentPath && e.timestamp > effectiveWindowStart) {
						effectiveWindowStart = e.timestamp + 1;
						break;
					}
				}
			}
		}

		// 统计时间窗口内相同工具调用的次数
		const recentCalls = this.toolCallHistory.filter(entry =>
			entry.timestamp >= effectiveWindowStart &&
			entry.name === name &&
			entry.paramsHash === paramsHash
		);

		if (recentCalls.length >= threshold) {
			return {
				detected: true,
				message: `🔴 检测到死循环！工具 "${name}" 在 ${Math.round(this.TIME_WINDOW_MS / 1000)} 秒内被调用了 ${recentCalls.length} 次（阈值 ${threshold}），参数相同。\n\n⚠️ 这表示你陷入了重复操作，请立即停止并尝试完全不同的策略！\n\n💡 建议：\n1. 如果搜索不到文件，不要继续搜索，应该创建文件\n2. 如果某个工具一直失败，换用其他工具\n3. 如果不确定如何继续，使用 ask_followup_question 询问用户`
			};
		}

		// 检测工具循环模式（如A->B->A->B->A->B）
		const patternResult = this.detectLoopPattern();
		if (patternResult.detected) {
			return patternResult;
		}

		return { detected: false, message: '' };
	}

	/**
	 * 检测同一文件被反复写入（apply_diff/edit/write_to_file 在同一文件上多次调用）
	 * 这是 AI 陷入"改了又改"死循环的核心检测
	 */
	private detectSameFileWriteLoop(toolUse: ToolUse, paramsHash: string): { detected: boolean; message: string } {
		// 提取目标文件路径
		const filePath = this.normalizePathValue((toolUse.params as any).path as string | undefined);
		if (!filePath) {
			return { detected: false, message: '' };
		}

		const now = Date.now();
		const windowStart = now - this.TIME_WINDOW_MS;

		// 记录本次写入
		this.fileWriteHistory.push({ file: filePath, tool: toolUse.name, signature: paramsHash, timestamp: now });
		// 清理过期记录
		this.fileWriteHistory = this.fileWriteHistory.filter(e => e.timestamp >= windowStart);

		// 统计同一文件在时间窗口内的写入次数（不包含本次）
		const previousWrites = this.fileWriteHistory.filter(
			e => e.file === filePath && e.timestamp < now
		);

		const sameSignatureWrites = previousWrites.filter(e => e.signature === paramsHash);
		const sameSignatureWritesIncludingCurrent = sameSignatureWrites.length + 1;
		// 完全相同的写入参数重复提交 >= 3 次（同签名说明模型在无效重试同一个补丁）
		if (sameSignatureWritesIncludingCurrent >= 3) {
			return {
				detected: true,
				message: `🔴 检测到对同一文件提交了重复写入参数！文件 “${filePath}” 已 ${sameSignatureWritesIncludingCurrent} 次收到完全相同的写入请求。\n\n请立即切换策略：\n1. 先 read_file 确认当前文件是否已包含目标改动\n2. 若改动已存在，直接 attempt_completion\n3. 若未生效，重新定位并生成新的最小补丁`
			};
		}

		// 只要签名有变化就放行——模型在有效推进
		return { detected: false, message: '' };
	}

	private detectFileReadWriteOscillation(_toolUse: ToolUse): { detected: boolean; message: string } {
		// 已禁用：read→write→read→write 是合法的多步编辑模式（如 CSS 样式修改），
		// 不应被检测为振荡。Claude Code 也没有此类检测。
		// 真正的无效循环由 detectSameFileWriteLoop 的签名重复检测来捕获。
		return { detected: false, message: '' };
	}

	private detectRepeatedTaskDelegation(toolUse: ToolUse): { detected: boolean; message: string } {
		const subagentType = this.normalizeTextValue((toolUse.params as any).subagent_type ?? '');
		const prompt = this.normalizeTextValue((toolUse.params as any).prompt ?? (toolUse.params as any).task ?? '');
		const taskId = this.normalizeTextValue((toolUse.params as any).task_id ?? '');

		if (!subagentType && !prompt && !taskId) {
			return { detected: false, message: '' };
		}

		// 显式 task_id 表示继续同一个子任务上下文，不应被视为“重复新建子任务”。
		if (taskId) {
			return { detected: false, message: '' };
		}

		const now = Date.now();
		const windowStart = now - this.TIME_WINDOW_MS;
		const key = `prompt:${subagentType}:${prompt}`;

		this.taskDelegationHistory.push({ key, subagentType, timestamp: now });
		this.taskDelegationHistory = this.taskDelegationHistory.filter(entry => entry.timestamp >= windowStart);

		const previousDelegations = this.taskDelegationHistory.filter(
			entry => entry.key === key && entry.timestamp < now
		);

		if (previousDelegations.length < this.TASK_DELEGATION_LOOP_THRESHOLD - 1) {
			return { detected: false, message: '' };
		}

		return {
			detected: true,
			message: `🔴 检测到重复派发同一个子任务！你在短时间内重复启动了 ${subagentType || 'unknown'} 子 Agent（${taskId ? `task_id=${taskId}` : `prompt=${prompt.substring(0, 80)}` }）。\n\n这不会带来新的信息，只会继续消耗时间和上下文。\n\n立即停止再次派发相同子任务，并改用以下策略：\n1. 直接使用上一个子任务的结果做判断\n2. 只读取已经明确的具体文件，不要再开新的 explore 子任务\n3. 如果目标文件已明确，直接修改或调用 attempt_completion`
		};
	}

	/**
	 * P2优化：检测工具调用循环模式
	 * 如：A->B->A->B->A->B 或 A->B->C->A->B->C
	 */
	private detectLoopPattern(): { detected: boolean; message: string } {
		if (this.toolCallHistory.length < 6) {
			return { detected: false, message: '' };
		}

		// 检测最近的调用中是否有重复的模式
		const recentCalls = this.toolCallHistory.slice(-10).map(e => `${e.name}:${e.paramsHash.substring(0, 8)}`);

		// 检测长度为2-4的循环模式
		for (let patternLen = 2; patternLen <= 4; patternLen++) {
			if (recentCalls.length < patternLen * 3) continue;

			const pattern = recentCalls.slice(-patternLen);
			let matchCount = 0;

			for (let i = recentCalls.length - patternLen; i >= patternLen; i -= patternLen) {
				const segment = recentCalls.slice(i - patternLen, i);
				if (segment.join(',') === pattern.join(',')) {
					matchCount++;
				} else {
					break;
				}
			}

			if (matchCount >= 2) {
				const patternNames = pattern.map(p => p.split(':')[0]).join(' → ');
				return {
					detected: true,
					message: `🔴 检测到循环模式！工具调用顺序：${patternNames}（重复了${matchCount + 1}次）\n\n⚠️ 这表示你陷入了无意义的循环，当前策略无法解决问题！\n\n💡 必须立即换新策略：\n1. 如果在搜索和查看文件之间循环，应该直接创建文件\n2. 如果在多个工具间循环，说明信息不足，应该 ask_followup_question\n3. 重新思考任务目标，尝试完全不同的方法`
				};
			}
		}

		return { detected: false, message: '' };
	}

	/**
	 * P2优化：计算参数哈希（用于快速比较）
	 */
	private hashParams(params: Record<string, any>): string {
		const json = this.stableStringify(params);
		// 简单哈希
		let hash = 0;
		for (let i = 0; i < json.length; i++) {
			const char = json.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return hash.toString(16);
	}

	/**
	 * Checks if a tool use is a browser scroll action
	 * Note: Currently disabled as browser_action tool is not supported
	 */
	/*
	private isBrowserScrollAction(toolUse: ToolUse): boolean {
		if (toolUse.name !== 'browser_action') {
			return false;
		}

		const action = toolUse.params.action as string;
		return action === 'scroll_down' || action === 'scroll_up';
	}
	*/

	private normalizeToolUse(toolUse: ToolUse): { name: string; parameters: Record<string, unknown> } {
		return {
			name: toolUse.name,
			parameters: this.normalizeToolParams(toolUse),
		};
	}

	private normalizeToolParams(toolUse: ToolUse): Record<string, unknown> {
		switch (toolUse.name) {
			case 'edit':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					edits: [
						this.normalizeEditSignature({
							old_string: (toolUse.params as any).old_string,
							new_string: (toolUse.params as any).new_string,
							replace_all: (toolUse.params as any).replace_all,
						}),
					],
				};
			case 'multiedit': {
				const rawEdits = this.parseJsonArray(toolUse.params.edits);
				return {
					path: this.normalizePathValue(toolUse.params.path),
					edits: rawEdits.map((edit: any) => this.normalizeEditSignature({
						old_string: edit.old_string ?? edit.oldString,
						new_string: edit.new_string ?? edit.newString,
						replace_all: edit.replace_all ?? edit.replaceAll,
					})),
				};
			}
			case 'patch': {
				const rawPatches = this.parseJsonArray(toolUse.params.patches);
				return {
					patches: rawPatches.map((patch: any) => ({
						path: this.normalizePathValue(patch.path),
						operations: Array.isArray(patch.operations)
							? patch.operations.map((operation: any) => this.normalizeEditSignature(operation))
							: [],
					})),
				};
			}
			case 'write_to_file':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					content: this.normalizeTextValue((toolUse.params as any).content ?? ''),
				};
			case 'apply_diff':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					diff: this.normalizeTextValue((toolUse.params as any).diff ?? ''),
				};
			case 'read_file':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					start_line: toolUse.params.start_line ?? '',
					end_line: toolUse.params.end_line ?? '',
				};
			case 'search_files':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					regex: this.normalizeTextValue((toolUse.params as any).regex ?? ''),
					file_pattern: this.normalizeTextValue((toolUse.params as any).file_pattern ?? ''),
					output_mode: this.normalizeTextValue((toolUse.params as any).output_mode ?? ''),
					head_limit: this.normalizeTextValue((toolUse.params as any).head_limit ?? ''),
					offset: this.normalizeTextValue((toolUse.params as any).offset ?? ''),
				};
			case 'glob':
				return {
					path: this.normalizePathValue(toolUse.params.path),
					file_pattern: this.normalizeTextValue((toolUse.params as any).file_pattern ?? ''),
				};
			case 'task':
				return {
					subagent_type: this.normalizeTextValue((toolUse.params as any).subagent_type ?? ''),
					prompt: this.normalizeTextValue((toolUse.params as any).prompt ?? (toolUse.params as any).task ?? ''),
					has_task_id: Boolean((toolUse.params as any).task_id),
				};
			default: {
				const sortedParams: Record<string, unknown> = {};
				for (const key of Object.keys(toolUse.params).sort()) {
					if (Object.prototype.hasOwnProperty.call(toolUse.params, key)) {
						sortedParams[key] = toolUse.params[key as keyof typeof toolUse.params];
					}
				}
				return sortedParams;
			}
		}
	}

	/**
	 * 构建"原始字节级"写入签名：不经过 normalizeTextValue 的 trim/折叠，
	 * 确保只要 old_string / new_string / diff / content 一个字节都没变，就能被识别为
	 * 完全等价的重试。
	 */
	private buildRawWriteSignature(toolUse: ToolUse): string | null {
		const params = (toolUse.params || {}) as any;
		const path = typeof params.path === 'string' ? params.path : '';
		switch (toolUse.name) {
			case 'edit':
				return `edit|${path}|${params.old_string ?? ''}|${params.new_string ?? ''}|${params.replace_all ?? ''}`;
			case 'multiedit':
				return `multiedit|${path}|${typeof params.edits === 'string' ? params.edits : JSON.stringify(params.edits ?? [])}`;
			case 'apply_diff':
				return `apply_diff|${path}|${params.diff ?? ''}`;
			case 'write_to_file':
				return `write_to_file|${path}|${params.content ?? ''}`;
			case 'patch':
				return `patch|${typeof params.patches === 'string' ? params.patches : JSON.stringify(params.patches ?? [])}`;
			default:
				return null;
		}
	}

	private normalizeEditSignature(edit: { old_string?: string; new_string?: string; replace_all?: unknown }): Record<string, unknown> {
		return {
			old_string: this.normalizeTextValue(edit.old_string ?? ''),
			new_string: this.normalizeTextValue(edit.new_string ?? ''),
			replace_all: edit.replace_all === true || edit.replace_all === 'true',
		};
	}

	private normalizePathValue(value: unknown): string {
		if (typeof value !== 'string' || value.length === 0) {
			return '';
		}
		const rawPath = value.replace(/^file:\/\//, '');
		const withWorkspaceRoot = rawPath.startsWith('/') || !this.workspaceRoot
			? rawPath
			: `${this.workspaceRoot.replace(/\/$/, '')}/${rawPath.replace(/^\.\//, '')}`;
		return path.normalize(withWorkspaceRoot).replace(/\\/g, '/');
	}

	private normalizeTextValue(value: unknown): string {
		if (typeof value !== 'string') {
			return '';
		}
		return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
	}

	private parseJsonArray(value: unknown): any[] {
		if (Array.isArray(value)) {
			return value;
		}
		if (typeof value !== 'string') {
			return [];
		}
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private stableStringify(value: unknown): string {
		if (Array.isArray(value)) {
			return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
		}
		if (value && typeof value === 'object') {
			const objectValue = value as Record<string, unknown>;
			const keys = Object.keys(objectValue).sort();
			return `{${keys.map(key => `${JSON.stringify(key)}:${this.stableStringify(objectValue[key])}`).join(',')}}`;
		}
		return JSON.stringify(value);
	}

	/**
	 * 从工具执行结果中提取错误签名。
	 * 只在返回文本中含明显错误关键字时生成签名，否则返回 null。
	 * 签名 = 错误消息前 100 字符 + 工具名 + 目标文件路径。
	 */
	public extractErrorSignature(toolName: string, toolInput: any, toolResult: string): string | null {
		if (!toolResult || typeof toolResult !== 'string') {
			return null;
		}
		const lower = toolResult.toLowerCase();
		const hasError =
			lower.includes('<error>') ||
			lower.includes('is_error') ||
			lower.includes('error:') ||
			lower.includes('not found') ||
			lower.includes('cannot find') ||
			lower.includes('failed');
		if (!hasError) {
			return null;
		}
		const head = toolResult.substring(0, 100);
		const targetPath = (toolInput && (toolInput.path || toolInput.target_file || toolInput.file_path)) || '';
		return `${toolName}|${targetPath}|${head}`;
	}

	/**
	 * 记录一条工具执行结果。调用方在每次 tool_result 回流时调用；
	 * 如果返回是 error，则推入 recentErrorSignatures（保持最多 10 条）。
	 */
	public recordToolResult(toolName: string, toolInput: any, toolResult: string): void {
		const sig = this.extractErrorSignature(toolName, toolInput, toolResult);
		if (!sig) {
			return;
		}
		this.recentErrorSignatures.push(sig);
		if (this.recentErrorSignatures.length > this.ERROR_SIGNATURE_HISTORY_SIZE) {
			this.recentErrorSignatures.shift();
		}
	}

	/**
	 * 返回已达阈值的 dominant 错误签名（若存在）。
	 */
	private findDominantErrorSignature(): { signature: string; count: number } | null {
		if (this.recentErrorSignatures.length < this.SAME_ERROR_LOOP_THRESHOLD) {
			return null;
		}
		const counts = new Map<string, number>();
		for (const s of this.recentErrorSignatures) {
			counts.set(s, (counts.get(s) || 0) + 1);
		}
		for (const [signature, count] of counts) {
			if (count >= this.SAME_ERROR_LOOP_THRESHOLD) {
				return { signature: signature.substring(0, 160), count };
			}
		}
		return null;
	}

	/**
	 * Reset the detector state
	 * Useful when starting a new task or conversation
	 * P2优化：同时重置Doom Loop检测状态
	 */
	public reset(): void {
		this.previousToolCallJson = null;
		this.consecutiveIdenticalToolCallCount = 0;
		this.lastRawWriteSignature = null;
		this.toolCallHistory = [];
		this.fileWriteHistory = [];
		this.taskDelegationHistory = [];
		this.recentErrorSignatures = [];
		this.doomLoopDetected = false;
		// 不重置doomLoopCount，保留统计
	}

	/**
	 * P2优化：获取Doom Loop统计
	 */
	public getDoomLoopStats(): {
		detected: boolean;
		count: number;
		historySize: number;
	} {
		return {
			detected: this.doomLoopDetected,
			count: this.doomLoopCount,
			historySize: this.toolCallHistory.length
		};
	}
}
