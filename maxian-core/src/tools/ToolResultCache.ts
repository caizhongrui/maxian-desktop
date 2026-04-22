/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具结果缓存
 * 用于缓存只读工具的执行结果，避免重复执行相同的操作
 */

/**
 * 缓存条目
 */
interface CacheEntry {
	result: string;
	timestamp: number;
	hitCount: number;
}

/**
 * 缓存配置
 */
interface CacheConfig {
	maxSize: number;           // 最大缓存条目数
	ttlMs: number;             // 缓存过期时间（毫秒）
	maxResultSize: number;     // 单个结果最大大小
}

/**
 * 默认缓存配置
 */
const DEFAULT_CACHE_CONFIG: CacheConfig = {
	maxSize: 100,              // 最多缓存 100 个结果
	ttlMs: 5 * 60 * 1000,      // 5 分钟过期
	maxResultSize: 100000      // 单个结果最大 100KB
};

/**
 * 可缓存的工具列表
 */
const CACHEABLE_TOOLS = new Set([
	'read_file',
	'list_files',
	'list_code_definition_names',
	'glob',
	'search_files',
	'codebase_search',
	'lsp',
	'lsp_hover',
	'lsp_diagnostics',
	'lsp_definition',
	'lsp_references',
	'lsp_type_definition',
]);

/**
 * 工具结果缓存类
 */
export class ToolResultCache {
	private cache: Map<string, CacheEntry> = new Map();
	private config: CacheConfig;
	private stats = {
		hits: 0,
		misses: 0,
		evictions: 0
	};

	constructor(config: Partial<CacheConfig> = {}) {
		this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
	}

	/**
	 * 生成缓存键
	 */
	private generateKey(toolName: string, params: any): string {
		const paramStr = this.serializeCanonical(params);
		return `${toolName}:${paramStr}`;
	}

	private serializeCanonical(value: any): string {
		if (Array.isArray(value)) {
			return `[${value.map(item => this.serializeCanonical(item)).join(',')}]`;
		}

		if (value && typeof value === 'object') {
			const entries = Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nestedValue]) => `${JSON.stringify(key)}:${this.serializeCanonical(nestedValue)}`);
			return `{${entries.join(',')}}`;
		}

		return JSON.stringify(value);
	}

	/**
	 * 检查工具是否可缓存
	 */
	isCacheable(toolName: string): boolean {
		return CACHEABLE_TOOLS.has(toolName);
	}

	/**
	 * 获取缓存结果
	 */
	get(toolName: string, params: any): string | null {
		if (!this.isCacheable(toolName)) {
			return null;
		}

		const key = this.generateKey(toolName, params);
		const entry = this.cache.get(key);

		if (!entry) {
			this.stats.misses++;
			return null;
		}

		// 检查是否过期
		if (Date.now() - entry.timestamp > this.config.ttlMs) {
			this.cache.delete(key);
			this.stats.misses++;
			return null;
		}

		// 更新命中计数
		entry.hitCount++;
		this.stats.hits++;
		return entry.result;
	}

	/**
	 * 设置缓存结果
	 */
	set(toolName: string, params: any, result: string): void {
		if (!this.isCacheable(toolName)) {
			return;
		}

		// 检查结果大小
		if (result.length > this.config.maxResultSize) {
			return;
		}

		const key = this.generateKey(toolName, params);

		// 如果缓存已满，清理最少使用的条目
		if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
			this.evictLeastUsed();
		}

		this.cache.set(key, {
			result,
			timestamp: Date.now(),
			hitCount: 0
		});
	}

	/**
	 * 清理最少使用的缓存条目
	 */
	private evictLeastUsed(): void {
		let minHitCount = Infinity;
		let minKey: string | null = null;

		for (const [key, entry] of this.cache.entries()) {
			if (entry.hitCount < minHitCount) {
				minHitCount = entry.hitCount;
				minKey = key;
			}
		}

		if (minKey) {
			this.cache.delete(minKey);
			this.stats.evictions++;
		}
	}

	/**
	 * 使特定文件的缓存失效
	 * 当文件被修改时调用
	 */
	invalidateFile(filePath: string): void {
		const keysToDelete: string[] = [];

		for (const key of this.cache.keys()) {
			if (key.includes(filePath)) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.cache.delete(key);
		}
	}

	/**
	 * 使特定目录的缓存失效
	 */
	invalidateDirectory(dirPath: string): void {
		const keysToDelete: string[] = [];
		const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';

		for (const key of this.cache.keys()) {
			if (key.includes(normalizedDir) || key.includes(`"path":"${dirPath}"`)) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.cache.delete(key);
		}
	}

	/**
	 * 清空所有缓存
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * 获取缓存统计信息
	 */
	getStats(): {
		size: number;
		hits: number;
		misses: number;
		hitRate: number;
		evictions: number;
	} {
		const total = this.stats.hits + this.stats.misses;
		return {
			size: this.cache.size,
			hits: this.stats.hits,
			misses: this.stats.misses,
			hitRate: total > 0 ? this.stats.hits / total : 0,
			evictions: this.stats.evictions
		};
	}

	/**
	 * 清理过期条目
	 */
	cleanup(): void {
		const now = Date.now();
		const keysToDelete: string[] = [];

		for (const [key, entry] of this.cache.entries()) {
			if (now - entry.timestamp > this.config.ttlMs) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.cache.delete(key);
		}
	}
}

/**
 * 全局缓存实例
 */
export const toolResultCache = new ToolResultCache();
