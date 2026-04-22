/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelContextTracker - 模型上下文跟踪器
 * 跟踪token使用、估算剩余上下文、预测何时需要压缩
 * 参考 Cline 的 ModelContextTracker
 */

import { MessageParam } from '../api/types.js';
import { estimateTokensFromChars } from '../utils/tokenEstimate.js';

/**
 * Token使用记录
 */
export interface TokenUsageRecord {
	timestamp: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	messageCount: number;
}

/**
 * 上下文统计信息
 */
export interface ContextStats {
	currentTokens: number;
	maxTokens: number;
	remainingTokens: number;
	usagePercentage: number;
	messageCount: number;
	averageTokensPerMessage: number;
}

/**
 * ModelContextTracker - 模型上下文跟踪器
 */
export class ModelContextTracker {
	private usageHistory: TokenUsageRecord[] = [];
	private maxContextTokens: number;
	private estimatedCurrentTokens: number = 0;

	constructor(maxContextTokens: number = 100000) {
		this.maxContextTokens = maxContextTokens;
	}

	/**
	 * 跟踪token使用
	 */
	trackTokenUsage(inputTokens: number, outputTokens: number, messageCount: number): void {
		const record: TokenUsageRecord = {
			timestamp: Date.now(),
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			messageCount
		};

		this.usageHistory.push(record);
		this.estimatedCurrentTokens = inputTokens;

		// 只保留最近100条记录
		if (this.usageHistory.length > 100) {
			this.usageHistory.shift();
		}

		console.log(`[ModelContextTracker] Token使用: 输入=${inputTokens}, 输出=${outputTokens}, 当前估算=${this.estimatedCurrentTokens}`);
	}

	/**
	 * 估算消息历史的token使用
	 * 简化实现：基于字符数估算
	 */
	estimateUsage(messages: MessageParam[]): number {
		let totalChars = 0;

		for (const msg of messages) {
			if (typeof msg.content === 'string') {
				totalChars += msg.content.length;
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === 'text') {
						totalChars += block.text.length;
					} else if (block.type === 'tool_use') {
						totalChars += JSON.stringify(block.input).length;
					} else if (block.type === 'tool_result') {
						totalChars += block.content.length;
					}
				}
			}
		}

		const estimatedTokens = estimateTokensFromChars(totalChars);
		this.estimatedCurrentTokens = estimatedTokens;

		return estimatedTokens;
	}

	/**
	 * 估算剩余上下文空间
	 */
	estimateRemainingContext(messages: MessageParam[]): number {
		const currentUsage = this.estimateUsage(messages);
		return Math.max(0, this.maxContextTokens - currentUsage);
	}

	/**
	 * 判断是否需要压缩上下文
	 */
	shouldCompact(messages: MessageParam[], threshold: number = 0.8): boolean {
		const currentUsage = this.estimateUsage(messages);
		const usageRatio = currentUsage / this.maxContextTokens;

		if (usageRatio >= threshold) {
			console.log(`[ModelContextTracker] 需要压缩: ${currentUsage}/${this.maxContextTokens} (${(usageRatio * 100).toFixed(1)}%)`);
			return true;
		}

		return false;
	}

	/**
	 * 获取上下文统计信息
	 */
	getStats(messages: MessageParam[]): ContextStats {
		const currentTokens = this.estimateUsage(messages);
		const remaining = this.maxContextTokens - currentTokens;
		const percentage = (currentTokens / this.maxContextTokens) * 100;
		const avgPerMessage = messages.length > 0 ? currentTokens / messages.length : 0;

		return {
			currentTokens,
			maxTokens: this.maxContextTokens,
			remainingTokens: remaining,
			usagePercentage: percentage,
			messageCount: messages.length,
			averageTokensPerMessage: avgPerMessage
		};
	}

	/**
	 * 获取使用历史
	 */
	getUsageHistory(limit: number = 10): TokenUsageRecord[] {
		return this.usageHistory.slice(-limit);
	}

	/**
	 * 清除历史记录
	 */
	clearHistory(): void {
		this.usageHistory = [];
		this.estimatedCurrentTokens = 0;
	}

	/**
	 * 预测在添加N个新消息后的token使用
	 */
	predictUsageAfterMessages(messages: MessageParam[], additionalMessages: number): number {
		const currentUsage = this.estimateUsage(messages);
		const stats = this.getStats(messages);
		const avgPerMessage = stats.averageTokensPerMessage;

		return currentUsage + (avgPerMessage * additionalMessages);
	}

	/**
	 * 获取token使用趋势
	 * 返回：'increasing' | 'stable' | 'decreasing'
	 */
	getUsageTrend(): 'increasing' | 'stable' | 'decreasing' {
		if (this.usageHistory.length < 3) {
			return 'stable';
		}

		const recent = this.usageHistory.slice(-3);
		const first = recent[0].totalTokens;
		const last = recent[recent.length - 1].totalTokens;

		const change = last - first;
		const changePercent = Math.abs(change) / first;

		if (changePercent < 0.1) {
			return 'stable';
		}

		return change > 0 ? 'increasing' : 'decreasing';
	}
}
