/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * List Files Tool - 增强版
 *
 * 性能优化（借鉴 Continue、Aider）：
 * - 目录列表缓存（30秒 TTL）
 * - .gitignore 规则缓存
 * - 并发遍历控制（p-limit 风格）
 * - 结果数量限制
 * - 智能过滤（隐藏文件、node_modules 等）
 */

import * as path from 'path';
import * as fs from 'fs';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

// ========== 配置常量 ==========
const LIST_FILES_CONFIG = {
	/** 目录缓存 TTL（30秒） */
	CACHE_TTL_MS: 30000,

	/** 最大缓存条目数 */
	MAX_CACHE_ENTRIES: 50,

	/** 最大并发目录读取数 */
	MAX_CONCURRENT_READS: 10,

	/** 最大返回文件数 */
	MAX_FILES_LIMIT: 1000,

	/** 递归最大深度 */
	MAX_DEPTH: 20,

	/** 默认忽略的目录 */
	DEFAULT_IGNORE_DIRS: new Set([
		'node_modules',
		'.git',
		'.svn',
		'.hg',
		'__pycache__',
		'.pytest_cache',
		'.mypy_cache',
		'.tox',
		'venv',
		'.venv',
		'env',
		'.env',
		'dist',
		'build',
		'out',
		'target',           // Maven/Gradle 编译输出
		'bin',              // 编译输出
		'.gradle',          // Gradle 缓存
		'.m2',              // Maven 本地仓库
		'.idea',
		'.vscode',
		'.next',
		'.nuxt',
		'.cache',
		'coverage',
		'.nyc_output',
		'logs',             // 日志目录
		'tmp',              // 临时目录
		'temp',             // 临时目录
	]),

	/** 默认忽略的文件模式 */
	DEFAULT_IGNORE_FILES: new Set([
		'.DS_Store',
		'Thumbs.db',
		'.gitkeep',
		'.npmrc',
		'.yarnrc',
		'package-lock.json',
		'yarn.lock',
		'pnpm-lock.yaml',
	]),
};

// ========== 目录缓存 ==========
interface DirCacheEntry {
	entries: DirEntry[];
	timestamp: number;
}

interface DirEntry {
	name: string;
	isDirectory: boolean;
	size?: number;
}

const dirCache = new Map<string, DirCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * 清理过期缓存
 */
function cleanExpiredCache(): void {
	const now = Date.now();
	const keysToDelete: string[] = [];

	dirCache.forEach((entry, key) => {
		if (now - entry.timestamp > LIST_FILES_CONFIG.CACHE_TTL_MS) {
			keysToDelete.push(key);
		}
	});

	keysToDelete.forEach(key => dirCache.delete(key));

	// 限制缓存大小
	if (dirCache.size > LIST_FILES_CONFIG.MAX_CACHE_ENTRIES) {
		const entries = Array.from(dirCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toDelete = entries.slice(0, Math.floor(LIST_FILES_CONFIG.MAX_CACHE_ENTRIES / 2));
		toDelete.forEach(([key]) => dirCache.delete(key));
	}
}

/**
 * 使目录缓存失效
 */
export function invalidateDirCache(dirPath: string): void {
	dirCache.delete(dirPath);
	// 同时失效父目录缓存
	const parentDir = path.dirname(dirPath);
	if (parentDir !== dirPath) {
		dirCache.delete(parentDir);
	}
}

/**
 * 获取缓存统计
 */
export function getDirCacheStats(): { size: number; hitRate: string; hits: number; misses: number } {
	const total = cacheHits + cacheMisses;
	const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : '0';
	return {
		size: dirCache.size,
		hitRate,
		hits: cacheHits,
		misses: cacheMisses,
	};
}

// ========== .gitignore 规则缓存 ==========
interface IgnoreRule {
	pattern: string;
	negated: boolean;
	dirOnly: boolean;
}

const ignoreRulesCache = new Map<string, IgnoreRule[]>();

/**
 * 解析 .gitignore 文件
 */
function parseGitignore(content: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];

	for (const line of content.split('\n')) {
		let pattern = line.trim();

		// 跳过空行和注释
		if (!pattern || pattern.startsWith('#')) {
			continue;
		}

		let negated = false;
		let dirOnly = false;

		// 检查是否为否定规则
		if (pattern.startsWith('!')) {
			negated = true;
			pattern = pattern.slice(1);
		}

		// 检查是否只匹配目录
		if (pattern.endsWith('/')) {
			dirOnly = true;
			pattern = pattern.slice(0, -1);
		}

		rules.push({ pattern, negated, dirOnly });
	}

	return rules;
}

/**
 * 获取目录的 ignore 规则
 */
function getIgnoreRules(dirPath: string): IgnoreRule[] {
	const gitignorePath = path.join(dirPath, '.gitignore');

	// 检查缓存
	const cached = ignoreRulesCache.get(dirPath);
	if (cached !== undefined) {
		return cached;
	}

	let rules: IgnoreRule[] = [];

	try {
		if (fs.existsSync(gitignorePath)) {
			const content = fs.readFileSync(gitignorePath, 'utf-8');
			rules = parseGitignore(content);
		}
	} catch {
		// 忽略读取错误
	}

	ignoreRulesCache.set(dirPath, rules);
	return rules;
}

/**
 * 检查路径是否被 ignore 规则匹配
 */
function isIgnored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
	let ignored = false;

	for (const rule of rules) {
		// 目录规则只匹配目录
		if (rule.dirOnly && !isDirectory) {
			continue;
		}

		// 简化的 glob 匹配
		if (matchesPattern(relativePath, rule.pattern)) {
			ignored = !rule.negated;
		}
	}

	return ignored;
}

/**
 * 简化的 glob 模式匹配
 */
function matchesPattern(path: string, pattern: string): boolean {
	// 简单实现：支持 * 和 ** 通配符
	const regexPattern = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
		.replace(/\*\*/g, '<<<DOUBLESTAR>>>') // 临时占位
		.replace(/\*/g, '[^/]*') // * 匹配非斜杠字符
		.replace(/<<<DOUBLESTAR>>>/g, '.*'); // ** 匹配任意字符

	const regex = new RegExp(`(^|/)${regexPattern}($|/)`);
	return regex.test(path);
}

// ========== 并发控制 ==========
class ConcurrencyLimiter {
	private running = 0;
	private queue: (() => void)[] = [];

	constructor(private limit: number) { }

	async run<T>(fn: () => Promise<T>): Promise<T> {
		while (this.running >= this.limit) {
			await new Promise<void>(resolve => this.queue.push(resolve));
		}

		this.running++;
		try {
			return await fn();
		} finally {
			this.running--;
			const next = this.queue.shift();
			if (next) next();
		}
	}
}

// ========== 主函数 ==========

interface FileEntry {
	path: string;
	isDirectory: boolean;
	size?: number;
}

export async function listFilesTool(
	ctx: IToolContext,
	params: any,
): Promise<ToolResponse> {
	const dirPath = params.path || '.';
	const recursive = params.recursive === 'true' || params.recursive === true;

	try {
		// 解析绝对路径
		const absolutePath = path.isAbsolute(dirPath)
			? dirPath
			: path.resolve(ctx.workspacePath, dirPath);

		// 检查目录是否存在
		if (!fs.existsSync(absolutePath)) {
			return `Error: Directory not found: ${dirPath}`;
		}

		const stat = fs.statSync(absolutePath);
		if (!stat.isDirectory()) {
			return `Error: Path is not a directory: ${dirPath}\n\n💡 Use read_file tool to read file contents.`;
		}

		// 清理过期缓存
		cleanExpiredCache();

		// 创建并发限制器
		const limiter = new ConcurrencyLimiter(LIST_FILES_CONFIG.MAX_CONCURRENT_READS);

		// 收集文件列表
		const files: FileEntry[] = [];
		const visited = new Set<string>();

		// 使用异步遍历
		await listDirAsync(
			absolutePath,
			'',
			files,
			visited,
			limiter,
			recursive,
			0,
			LIST_FILES_CONFIG.MAX_FILES_LIMIT
		);

		// 排序结果
		files.sort((a, b) => {
			// 目录优先
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.path.localeCompare(b.path);
		});

		// 格式化输出
		const cacheStats = getDirCacheStats();
		const truncated = files.length >= LIST_FILES_CONFIG.MAX_FILES_LIMIT;

		const header = [
			`Directory: ${dirPath}`,
			`Mode: ${recursive ? 'Recursive' : 'Non-recursive'}`,
			`Total items: ${files.length}${truncated ? ` (limited to ${LIST_FILES_CONFIG.MAX_FILES_LIMIT})` : ''}`,
			`Cache hit rate: ${cacheStats.hitRate}%`,
			'',
		];

		if (truncated) {
			header.push(`⚠️ Results truncated. Use more specific path or file patterns.`);
			header.push('');
		}

		// 格式化文件列表
		const fileList = files.map(f => {
			if (f.isDirectory) {
				return `📁 ${f.path}/`;
			} else if (f.size !== undefined && f.size > 100 * 1024) {
				// 显示大文件大小
				return `📄 ${f.path} (${formatBytes(f.size)})`;
			} else {
				return `📄 ${f.path}`;
			}
		});

		return [
			...header,
			'Files and directories:',
			...fileList,
		].join('\n');

	} catch (error) {
		return `Error listing directory: ${(error as Error).message}`;
	}
}

/**
 * 异步遍历目录
 */
async function listDirAsync(
	basePath: string,
	relativePath: string,
	results: FileEntry[],
	visited: Set<string>,
	limiter: ConcurrencyLimiter,
	recursive: boolean,
	depth: number,
	limit: number
): Promise<void> {
	// 检查限制
	if (results.length >= limit || depth > LIST_FILES_CONFIG.MAX_DEPTH) {
		return;
	}

	const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

	// 防止循环引用（符号链接）
	const realPath = fs.realpathSync(fullPath);
	if (visited.has(realPath)) {
		return;
	}
	visited.add(realPath);

	// 检查缓存
	let entries: DirEntry[];
	const cached = dirCache.get(fullPath);

	if (cached && Date.now() - cached.timestamp < LIST_FILES_CONFIG.CACHE_TTL_MS) {
		cacheHits++;
		entries = cached.entries;
	} else {
		cacheMisses++;

		// 使用并发限制读取目录
		entries = await limiter.run(async () => {
			const dirents = fs.readdirSync(fullPath, { withFileTypes: true });
			return dirents.map(dirent => ({
				name: dirent.name,
				isDirectory: dirent.isDirectory(),
				size: dirent.isFile() ? getFileSize(path.join(fullPath, dirent.name)) : undefined,
			}));
		});

		// 更新缓存
		dirCache.set(fullPath, {
			entries,
			timestamp: Date.now(),
		});
	}

	// 获取 ignore 规则
	const ignoreRules = getIgnoreRules(basePath);

	// 处理目录项
	const subDirs: string[] = [];

	for (const entry of entries) {
		if (results.length >= limit) break;

		// 跳过隐藏文件（以 . 开头）
		if (entry.name.startsWith('.')) {
			continue;
		}

		// 跳过默认忽略的目录
		if (entry.isDirectory && LIST_FILES_CONFIG.DEFAULT_IGNORE_DIRS.has(entry.name)) {
			continue;
		}

		// 跳过默认忽略的文件
		if (!entry.isDirectory && LIST_FILES_CONFIG.DEFAULT_IGNORE_FILES.has(entry.name)) {
			continue;
		}

		const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

		// 检查 .gitignore 规则
		if (isIgnored(entryRelativePath, entry.isDirectory, ignoreRules)) {
			continue;
		}

		results.push({
			path: entryRelativePath,
			isDirectory: entry.isDirectory,
			size: entry.size,
		});

		// 收集子目录用于递归
		if (entry.isDirectory && recursive) {
			subDirs.push(entryRelativePath);
		}
	}

	// 递归处理子目录（并发）
	if (recursive && subDirs.length > 0 && results.length < limit) {
		await Promise.all(
			subDirs.map(subDir =>
				listDirAsync(basePath, subDir, results, visited, limiter, recursive, depth + 1, limit)
			)
		);
	}
}

/**
 * 获取文件大小（带错误处理）
 */
function getFileSize(filePath: string): number | undefined {
	try {
		const stat = fs.statSync(filePath);
		return stat.size;
	} catch {
		return undefined;
	}
}

/**
 * 格式化字节大小
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
