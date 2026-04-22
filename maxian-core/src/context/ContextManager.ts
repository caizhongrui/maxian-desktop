/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ContextManager - 上下文管理器
 * 跟踪对话历史中的所有上下文修改，支持持久化和回滚
 * 参考 Cline 的 ContextManager 完整实现
 */

// import * as fs from 'fs/promises';  // TODO: 移到node层实现持久化
// import * as path from 'path';
import { MessageParam } from '../api/types.js';

/**
 * 上下文更新记录
 */
export interface ContextUpdate {
	timestamp: number;
	updateType: string;
	content: any;
	metadata?: any;
}

/**
 * 编辑类型枚举
 */
export enum EditType {
	UNDEFINED = 0,
	NO_FILE_READ = 1,
	READ_FILE_TOOL = 2,
	ALTER_FILE_TOOL = 3,
	FILE_MENTION = 4
}

/**
 * ContextManager - 完整的上下文管理器
 */
export class ContextManager {
	// 上下文历史：messageIndex -> [EditType, blockIndex -> ContextUpdate[]]
	private contextHistoryUpdates: Map<number, [EditType, Map<number, ContextUpdate[]>]> = new Map();

	constructor(_taskDirectory?: string) {
		// taskDirectory暂时不使用（持久化待实现）
	}

	/**
	 * 初始化（从磁盘加载历史）
	 */
	async initialize(_taskDirectory: string): Promise<void> {
		this.contextHistoryUpdates = await this.loadContextHistory();
		console.log('[ContextManager] 初始化完成，历史记录数:', this.contextHistoryUpdates.size);
	}

	/**
	 * 添加上下文更新
	 */
	addContextUpdate(
		messageIndex: number,
		editType: EditType,
		blockIndex: number,
		updateType: string,
		content: any,
		metadata?: any
	): void {
		const update: ContextUpdate = {
			timestamp: Date.now(),
			updateType,
			content,
			metadata
		};

		if (!this.contextHistoryUpdates.has(messageIndex)) {
			this.contextHistoryUpdates.set(messageIndex, [editType, new Map()]);
		}

		const [, blockUpdates] = this.contextHistoryUpdates.get(messageIndex)!;

		if (!blockUpdates.has(blockIndex)) {
			blockUpdates.set(blockIndex, []);
		}

		blockUpdates.get(blockIndex)!.push(update);
	}

	/**
	 * 获取消息的所有更新
	 */
	getMessageUpdates(messageIndex: number): ContextUpdate[] | null {
		const entry = this.contextHistoryUpdates.get(messageIndex);
		if (!entry) {
			return null;
		}

		const [, blockUpdates] = entry;
		const allUpdates: ContextUpdate[] = [];

		for (const updates of blockUpdates.values()) {
			allUpdates.push(...updates);
		}

		return allUpdates.sort((a, b) => a.timestamp - b.timestamp);
	}

	/**
	 * 应用上下文更新到消息
	 * 根据历史更新记录修改消息内容
	 */
	applyUpdatesToMessages(messages: MessageParam[]): MessageParam[] {
		const updatedMessages = [...messages];

		for (const [messageIndex, [_editType, blockUpdates]] of this.contextHistoryUpdates) {
			if (messageIndex >= updatedMessages.length) {
				continue;
			}

			const message = updatedMessages[messageIndex];

			// 按时间顺序应用所有更新
			for (const [blockIndex, updates] of blockUpdates) {
				// 按时间戳排序
				const sortedUpdates = updates.sort((a, b) => a.timestamp - b.timestamp);

				for (const update of sortedUpdates) {
					switch (update.updateType) {
						case 'truncate_text':
							// 截断文本内容
							this.applyTruncateUpdate(message, blockIndex, update);
							break;

						case 'add_note':
							// 添加注释（如"部分历史已移除"）
							this.applyNoteUpdate(message, blockIndex, update);
							break;

						case 'compress_tool_result':
							// 压缩工具结果
							this.applyCompressToolResult(message, blockIndex, update);
							break;

						case 'replace_content':
							// 替换内容
							this.applyReplaceContent(message, blockIndex, update);
							break;

						default:
							console.warn(`[ContextManager] 未知的更新类型: ${update.updateType}`);
					}
				}
			}
		}

		return updatedMessages;
	}

	/**
	 * 应用截断更新
	 */
	private applyTruncateUpdate(message: MessageParam, blockIndex: number, update: ContextUpdate): void {
		if (typeof message.content === 'string') {
			const maxLength = update.metadata?.maxLength || 1000;
			if (message.content.length > maxLength) {
				message.content = message.content.substring(0, maxLength) + '\n\n[...内容已截断]';
			}
		} else if (Array.isArray(message.content) && blockIndex < message.content.length) {
			const block = message.content[blockIndex];
			if (block.type === 'text') {
				const maxLength = update.metadata?.maxLength || 1000;
				if (block.text.length > maxLength) {
					block.text = block.text.substring(0, maxLength) + '\n\n[...内容已截断]';
				}
			}
		}
	}

	/**
	 * 应用注释更新
	 */
	private applyNoteUpdate(message: MessageParam, blockIndex: number, update: ContextUpdate): void {
		const noteText = update.content || '[注释] 部分对话历史已被压缩';

		if (typeof message.content === 'string') {
			message.content = `${noteText}\n\n${message.content}`;
		} else if (Array.isArray(message.content) && blockIndex === 0) {
			// 在第一个block前插入注释
			message.content.unshift({
				type: 'text',
				text: noteText
			});
		}
	}

	/**
	 * 压缩工具结果
	 */
	private applyCompressToolResult(message: MessageParam, blockIndex: number, update: ContextUpdate): void {
		if (Array.isArray(message.content) && blockIndex < message.content.length) {
			const block = message.content[blockIndex];
			if (block.type === 'tool_result') {
				const maxLength = 500;
				if (block.content.length > maxLength) {
					block.content = block.content.substring(0, maxLength) + '\n\n[...工具结果已压缩]';
				}
			}
		}
	}

	/**
	 * 替换内容
	 */
	private applyReplaceContent(message: MessageParam, blockIndex: number, update: ContextUpdate): void {
		if (typeof message.content === 'string') {
			message.content = update.content;
		} else if (Array.isArray(message.content) && blockIndex < message.content.length) {
			const block = message.content[blockIndex];
			if (block.type === 'text') {
				block.text = update.content;
			} else if (block.type === 'tool_result') {
				block.content = update.content;
			}
		}
	}

	/**
	 * 判断是否应该压缩上下文
	 */
	shouldCompactContextWindow(
		messages: MessageParam[],
		currentTokens: number,
		maxTokens: number,
		tokenBuffer: number = 20000
	): boolean {
		const threshold = maxTokens - tokenBuffer;
		return currentTokens > threshold;
	}

	/**
	 * 保存上下文历史到磁盘
	 */
	async save(): Promise<void> {
		// TODO: 持久化功能需要移到node层实现
		// 使用service接口或移到electron-main
		console.log('[ContextManager] 保存跳过（持久化待实现）');
	}

	/**
	 * 从磁盘加载上下文历史
	 */
	private async loadContextHistory(): Promise<Map<number, [EditType, Map<number, ContextUpdate[]>]>> {
		// TODO: 加载功能需要移到node层实现
		return new Map();
	}

	/**
	 * 清除历史记录
	 */
	clear(): void {
		this.contextHistoryUpdates.clear();
	}

	/**
	 * 获取统计信息
	 */
	getStats() {
		return {
			messageCount: this.contextHistoryUpdates.size,
			totalUpdates: Array.from(this.contextHistoryUpdates.values())
				.reduce((sum, [, blocks]) => sum + blocks.size, 0)
		};
	}
}
