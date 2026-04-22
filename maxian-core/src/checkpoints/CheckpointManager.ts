/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CheckpointManager - 检查点管理器
 * 支持任务状态的保存和回滚
 * 参考 Cline 的 ICheckpointManager 接口
 */

// import * as fs from 'fs/promises';  // TODO: 移到node层
// import * as path from 'path';

/**
 * 检查点数据
 */
export interface Checkpoint {
	id: string;
	timestamp: number;
	messageCount: number;
	description: string;
	data: any;  // 完整的状态数据
}

/**
 * CheckpointManager - 检查点管理器
 */
export class CheckpointManager {
	private checkpoints: Map<string, Checkpoint> = new Map();
	private maxCheckpoints: number = 20;  // 最多保留20个检查点
	private readonly verboseLogs = false;

	private debugLog(...args: any[]): void {
		if (!this.verboseLogs) {
			return;
		}
		console.log(...args);
	}

	constructor(_taskDirectory?: string, maxCheckpoints: number = 20) {
		this.maxCheckpoints = maxCheckpoints;
		// taskDirectory暂时不使用（持久化待实现）
	}

	/**
	 * 初始化
	 */
	async initialize(_taskDirectory: string): Promise<void> {
		await this.loadCheckpoints();
		this.debugLog('[CheckpointManager] 初始化完成，检查点数:', this.checkpoints.size);
	}

	/**
	 * 创建检查点
	 */
	async createCheckpoint(description: string, data: any): Promise<string> {
		const checkpoint: Checkpoint = {
			id: `checkpoint_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
			timestamp: Date.now(),
			messageCount: data.messageCount || 0,
			description,
			data
		};

		this.checkpoints.set(checkpoint.id, checkpoint);

		// 如果超过最大数量，删除最旧的
		if (this.checkpoints.size > this.maxCheckpoints) {
			const oldest = Array.from(this.checkpoints.values())
				.sort((a, b) => a.timestamp - b.timestamp)[0];
			this.checkpoints.delete(oldest.id);
			this.debugLog('[CheckpointManager] 删除最旧检查点:', oldest.id);
		}

		await this.saveCheckpoints();
		this.debugLog('[CheckpointManager] 创建检查点:', checkpoint.id, description);

		return checkpoint.id;
	}

	/**
	 * 恢复到检查点
	 */
	async restoreCheckpoint(checkpointId: string): Promise<any | null> {
		const checkpoint = this.checkpoints.get(checkpointId);

		if (!checkpoint) {
			console.error('[CheckpointManager] 检查点不存在:', checkpointId);
			return null;
		}

		this.debugLog('[CheckpointManager] 恢复检查点:', checkpointId, checkpoint.description);
		return checkpoint.data;
	}

	/**
	 * 获取所有检查点
	 */
	getAllCheckpoints(): Checkpoint[] {
		return Array.from(this.checkpoints.values())
			.sort((a, b) => b.timestamp - a.timestamp);  // 按时间倒序
	}

	/**
	 * 获取最新检查点
	 */
	getLatestCheckpoint(): Checkpoint | null {
		const all = this.getAllCheckpoints();
		return all.length > 0 ? all[0] : null;
	}

	/**
	 * 删除检查点
	 */
	async deleteCheckpoint(checkpointId: string): Promise<boolean> {
		const deleted = this.checkpoints.delete(checkpointId);

		if (deleted) {
			await this.saveCheckpoints();
			this.debugLog('[CheckpointManager] 删除检查点:', checkpointId);
		}

		return deleted;
	}

	/**
	 * 清除所有检查点
	 */
	async clearAll(): Promise<void> {
		this.checkpoints.clear();
		await this.saveCheckpoints();
		this.debugLog('[CheckpointManager] 所有检查点已清除');
	}

	/**
	 * 保存检查点到磁盘
	 */
	private async saveCheckpoints(): Promise<void> {
		// TODO: 持久化需要移到node层或通过service
		this.debugLog('[CheckpointManager] 保存跳过（持久化待实现）');
	}

	/**
	 * 从磁盘加载检查点
	 */
	private async loadCheckpoints(): Promise<void> {
		// TODO: 加载需要移到node层
	}

	/**
	 * 获取统计信息
	 */
	getStats() {
		const all = this.getAllCheckpoints();
		return {
			totalCheckpoints: this.checkpoints.size,
			oldestTimestamp: all.length > 0 ? all[all.length - 1].timestamp : null,
			newestTimestamp: all.length > 0 ? all[0].timestamp : null
		};
	}
}
