/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * StateMutex - 状态互斥锁
 * 防止并发修改状态导致的竞态条件
 * 参考 Cline 的 Task stateMutex 实现
 */

/**
 * 简单的互斥锁实现
 * 使用Promise队列确保同一时间只有一个操作在执行
 */
export class StateMutex {
	private locked: boolean = false;
	private queue: Array<() => void> = [];

	/**
	 * 在锁保护下执行函数
	 * 确保同一时间只有一个函数在执行
	 */
	async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		// 等待获取锁
		await this.acquire();

		try {
			// 执行函数
			return await fn();
		} finally {
			// 释放锁
			this.release();
		}
	}

	/**
	 * 获取锁
	 */
	private async acquire(): Promise<void> {
		// 如果锁已被占用，等待
		if (this.locked) {
			await new Promise<void>(resolve => {
				this.queue.push(resolve);
			});
		}

		// 占用锁
		this.locked = true;
	}

	/**
	 * 释放锁
	 */
	private release(): void {
		// 如果队列中有等待的操作，唤醒下一个
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			// 否则释放锁
			this.locked = false;
		}
	}

	/**
	 * 检查锁是否被占用
	 */
	isLocked(): boolean {
		return this.locked;
	}

	/**
	 * 获取等待队列长度
	 */
	getQueueLength(): number {
		return this.queue.length;
	}
}
