/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search Files Tool - 增强版
 *
 * 性能优化（借鉴 Cline、Continue）：
 * - 结果字节限制（0.25MB，类似 Cline）
 * - 搜索结果缓存（30秒 TTL）
 * - 二进制文件跳过
 * - 大文件跳过（超过 1MB）
 * - 并发搜索控制
 * - 结果智能截断
 * - 上下文行显示
 */

import * as path from 'path';
import * as fs from 'fs';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

// ========== 配置常量 ==========
const SEARCH_CONFIG = {
	/** 结果字节限制（256KB，类似 Cline） */
	MAX_RESULT_BYTES: 256 * 1024,

	/** 最大结果数 */
	MAX_RESULTS: 200,

	/** 最大搜索文件数 */
	MAX_FILES_TO_SEARCH: 5000,

	/** 最大文件大小（1MB） */
	MAX_FILE_SIZE: 1024 * 1024,

	/** 缓存 TTL（30秒） */
	CACHE_TTL_MS: 30000,

	/** 最大缓存条目数 */
	MAX_CACHE_ENTRIES: 50,

	/** 上下文行数（匹配行前后显示的行数） */
	CONTEXT_LINES: 1,

	/** 单行最大长度 */
	MAX_LINE_LENGTH: 500,

	/** 默认忽略的目录 */
	IGNORE_DIRS: new Set([
		'node_modules',
		'.git',
		'.svn',
		'.hg',
		'__pycache__',
		'.pytest_cache',
		'.mypy_cache',
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

	/** 二进制文件扩展名 */
	BINARY_EXTENSIONS: new Set([
		'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
		'.zip', '.gz', '.tar', '.rar', '.7z',
		'.exe', '.dll', '.so', '.dylib',
		'.pdf', '.doc', '.docx', '.xls', '.xlsx',
		'.mp3', '.mp4', '.avi', '.mov', '.wav',
		'.ttf', '.otf', '.woff', '.woff2',
		'.db', '.sqlite', '.sqlite3',
		'.class', '.jar', '.pyc', '.pyo', '.wasm',
	]),
};

// ========== 搜索缓存 ==========
interface SearchCacheEntry {
	results: SearchMatch[];
	timestamp: number;
	totalMatches: number;
}

interface SearchMatch {
	file: string;
	line: number;
	content: string;
	contextBefore?: string[];
	contextAfter?: string[];
}

const searchCache = new Map<string, SearchCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * 生成缓存键
 */
function getCacheKey(searchPath: string, regex: string, filePattern?: string): string {
	return `${searchPath}:${regex}:${filePattern || ''}`;
}

/**
 * 清理过期缓存
 */
function cleanExpiredCache(): void {
	const now = Date.now();
	const keysToDelete: string[] = [];

	searchCache.forEach((entry, key) => {
		if (now - entry.timestamp > SEARCH_CONFIG.CACHE_TTL_MS) {
			keysToDelete.push(key);
		}
	});

	keysToDelete.forEach(key => searchCache.delete(key));

	if (searchCache.size > SEARCH_CONFIG.MAX_CACHE_ENTRIES) {
		const entries = Array.from(searchCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toDelete = entries.slice(0, Math.floor(SEARCH_CONFIG.MAX_CACHE_ENTRIES / 2));
		toDelete.forEach(([key]) => searchCache.delete(key));
	}
}

/**
 * 使搜索缓存失效
 */
export function invalidateSearchCache(): void {
	searchCache.clear();
}

/**
 * 获取缓存统计
 */
export function getSearchCacheStats(): { size: number; hitRate: string; hits: number; misses: number } {
	const total = cacheHits + cacheMisses;
	const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : '0';
	return {
		size: searchCache.size,
		hitRate,
		hits: cacheHits,
		misses: cacheMisses,
	};
}

// ========== 主函数 ==========

export async function searchFilesTool(
	ctx: IToolContext,
	params: any,
): Promise<ToolResponse> {
	const searchPath = params.path || '.';
	const regex = params.regex;
	const filePattern = params.file_pattern;

	if (!regex) {
		return 'Error: No search regex provided';
	}

	try {
		// 解析绝对路径
		const absolutePath = path.isAbsolute(searchPath)
			? searchPath
			: path.resolve(ctx.workspacePath, searchPath);

		// 检查路径是否存在
		if (!fs.existsSync(absolutePath)) {
			return `Error: Path not found: ${searchPath}`;
		}

		// 清理过期缓存
		cleanExpiredCache();

		// 检查缓存
		const cacheKey = getCacheKey(absolutePath, regex, filePattern);
		const cached = searchCache.get(cacheKey);

		if (cached && Date.now() - cached.timestamp < SEARCH_CONFIG.CACHE_TTL_MS) {
			cacheHits++;
			console.log(`[SearchFiles] 缓存命中: ${regex} (命中率: ${getSearchCacheStats().hitRate}%)`);
			return formatSearchResults(regex, filePattern, searchPath, cached.results, cached.totalMatches, true);
		}

		cacheMisses++;

		// 创建正则表达式
		let searchRegex: RegExp;
		try {
			searchRegex = new RegExp(regex, 'gi');
		} catch (e) {
			return `Error: Invalid regex pattern: ${regex}\n${(e as Error).message}`;
		}

		const fileRegex = filePattern ? createFilePattern(filePattern) : null;

		// 收集结果
		const results: SearchMatch[] = [];
		let totalMatches = 0;
		let totalBytes = 0;
		let filesSearched = 0;
		let filesSkipped = 0;

		const startTime = Date.now();

		// 搜索目录
		const searchDir = (dir: string) => {
			// 检查限制
			if (results.length >= SEARCH_CONFIG.MAX_RESULTS ||
				totalBytes >= SEARCH_CONFIG.MAX_RESULT_BYTES ||
				filesSearched >= SEARCH_CONFIG.MAX_FILES_TO_SEARCH) {
				return;
			}

			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // 跳过无法读取的目录
			}

			for (const entry of entries) {
				// 检查限制
				if (results.length >= SEARCH_CONFIG.MAX_RESULTS ||
					totalBytes >= SEARCH_CONFIG.MAX_RESULT_BYTES) {
					return;
				}

				const fullPath = path.join(dir, entry.name);

				// 跳过隐藏文件和目录
				if (entry.name.startsWith('.')) {
					continue;
				}

				if (entry.isDirectory()) {
					// 跳过忽略的目录
					if (SEARCH_CONFIG.IGNORE_DIRS.has(entry.name)) {
						continue;
					}
					searchDir(fullPath);
				} else if (entry.isFile()) {
					// 跳过二进制文件
					const ext = path.extname(entry.name).toLowerCase();
					if (SEARCH_CONFIG.BINARY_EXTENSIONS.has(ext)) {
						filesSkipped++;
						continue;
					}

					// 检查文件模式
					if (fileRegex && !fileRegex.test(entry.name)) {
						continue;
					}

					// 检查文件大小
					try {
						const stat = fs.statSync(fullPath);
						if (stat.size > SEARCH_CONFIG.MAX_FILE_SIZE) {
							filesSkipped++;
							continue;
						}
					} catch {
						continue;
					}

					// 搜索文件
					const fileResults = searchFile(fullPath, searchRegex, ctx.workspacePath);
					filesSearched++;

					for (const match of fileResults) {
						if (results.length >= SEARCH_CONFIG.MAX_RESULTS ||
							totalBytes >= SEARCH_CONFIG.MAX_RESULT_BYTES) {
							break;
						}

						totalMatches++;
						const matchBytes = estimateMatchBytes(match);

						if (totalBytes + matchBytes <= SEARCH_CONFIG.MAX_RESULT_BYTES) {
							results.push(match);
							totalBytes += matchBytes;
						}
					}
				}
			}
		};

		// 开始搜索
		const stat = fs.statSync(absolutePath);
		if (stat.isDirectory()) {
			searchDir(absolutePath);
		} else {
			// 单文件搜索
			const fileResults = searchFile(absolutePath, searchRegex, ctx.workspacePath);
			results.push(...fileResults.slice(0, SEARCH_CONFIG.MAX_RESULTS));
			totalMatches = fileResults.length;
		}

		const elapsed = Date.now() - startTime;
		console.log(`[SearchFiles] 搜索完成: ${filesSearched} 文件, ${totalMatches} 匹配, ${elapsed}ms`);

		// 更新缓存
		searchCache.set(cacheKey, {
			results,
			timestamp: Date.now(),
			totalMatches,
		});

		return formatSearchResults(regex, filePattern, searchPath, results, totalMatches, false,
			filesSearched, filesSkipped, elapsed);

	} catch (error) {
		return `Error searching files: ${(error as Error).message}`;
	}
}

/**
 * 搜索单个文件
 */
function searchFile(filePath: string, regex: RegExp, workspacePath: string): SearchMatch[] {
	const results: SearchMatch[] = [];

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n');
		const relativePath = path.relative(workspacePath, filePath);

		// 重置正则表达式状态
		regex.lastIndex = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (regex.test(line)) {
				// 获取上下文行
				const contextBefore: string[] = [];
				const contextAfter: string[] = [];

				if (SEARCH_CONFIG.CONTEXT_LINES > 0) {
					for (let j = Math.max(0, i - SEARCH_CONFIG.CONTEXT_LINES); j < i; j++) {
						contextBefore.push(truncateLine(lines[j], SEARCH_CONFIG.MAX_LINE_LENGTH));
					}
					for (let j = i + 1; j <= Math.min(lines.length - 1, i + SEARCH_CONFIG.CONTEXT_LINES); j++) {
						contextAfter.push(truncateLine(lines[j], SEARCH_CONFIG.MAX_LINE_LENGTH));
					}
				}

				results.push({
					file: relativePath,
					line: i + 1,
					content: truncateLine(line, SEARCH_CONFIG.MAX_LINE_LENGTH),
					contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
					contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
				});

				// 重置正则表达式状态
				regex.lastIndex = 0;
			}
		}
	} catch {
		// 跳过无法读取的文件（可能是二进制或编码问题）
	}

	return results;
}

/**
 * 创建文件模式正则表达式
 */
function createFilePattern(pattern: string): RegExp {
	// 将 glob 模式转换为正则表达式
	const regexPattern = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');

	return new RegExp(`^${regexPattern}$`, 'i');
}

/**
 * 截断行
 */
function truncateLine(line: string, maxLength: number): string {
	const trimmed = line.trim();
	if (trimmed.length <= maxLength) {
		return trimmed;
	}
	return trimmed.substring(0, maxLength - 3) + '...';
}

/**
 * 估算匹配结果字节数
 */
function estimateMatchBytes(match: SearchMatch): number {
	let bytes = match.file.length + match.content.length + 20; // 基础开销

	if (match.contextBefore) {
		bytes += match.contextBefore.reduce((sum, line) => sum + line.length, 0);
	}
	if (match.contextAfter) {
		bytes += match.contextAfter.reduce((sum, line) => sum + line.length, 0);
	}

	return bytes;
}

/**
 * 格式化搜索结果
 */
function formatSearchResults(
	regex: string,
	filePattern: string | undefined,
	searchPath: string,
	results: SearchMatch[],
	totalMatches: number,
	fromCache: boolean,
	filesSearched?: number,
	filesSkipped?: number,
	elapsed?: number
): string {
	const header: string[] = [
		`🔍 Search: ${regex}`,
	];

	if (filePattern) {
		header.push(`File pattern: ${filePattern}`);
	}

	header.push(`Path: ${searchPath}`);

	// 统计信息
	const statsLine: string[] = [`Matches: ${totalMatches}`];

	if (results.length < totalMatches) {
		statsLine.push(`(showing ${results.length})`);
	}

	if (filesSearched !== undefined) {
		statsLine.push(`Files: ${filesSearched}`);
	}

	if (filesSkipped !== undefined && filesSkipped > 0) {
		statsLine.push(`Skipped: ${filesSkipped}`);
	}

	if (elapsed !== undefined) {
		statsLine.push(`Time: ${elapsed}ms`);
	}

	if (fromCache) {
		statsLine.push('(cached)');
	}

	header.push(statsLine.join(' | '));

	// 检查是否达到限制
	const warnings: string[] = [];

	if (results.length >= SEARCH_CONFIG.MAX_RESULTS) {
		warnings.push(`⚠️ 结果数已达上限 (${SEARCH_CONFIG.MAX_RESULTS})，可能还有更多匹配`);
	}

	if (results.length < totalMatches) {
		warnings.push(`💡 提示: 使用更精确的搜索模式或文件过滤来缩小范围`);
	}

	// 格式化结果
	const output: string[] = [...header];

	if (warnings.length > 0) {
		output.push('');
		output.push(...warnings);
	}

	output.push('');

	if (results.length === 0) {
		output.push('No matches found.');
		output.push('');
		output.push('💡 Suggestions:');
		output.push('  - Check the regex pattern for errors');
		output.push('  - Try a less specific pattern');
		output.push('  - Use file_pattern to narrow down the search');
	} else {
		output.push('Results:');
		output.push('');

		// 按文件分组显示
		const groupedResults = groupByFile(results);

		groupedResults.forEach((matches, file) => {
			output.push(`📁 ${file}`);

			for (const match of matches) {
				// 显示上下文
				if (match.contextBefore && match.contextBefore.length > 0) {
					for (let i = 0; i < match.contextBefore.length; i++) {
						const lineNum = match.line - match.contextBefore.length + i;
						output.push(`   ${lineNum}: ${match.contextBefore[i]}`);
					}
				}

				// 显示匹配行（高亮）
				output.push(`-> ${match.line}: ${match.content}`);

				// 显示下文
				if (match.contextAfter && match.contextAfter.length > 0) {
					for (let i = 0; i < match.contextAfter.length; i++) {
						const lineNum = match.line + 1 + i;
						output.push(`   ${lineNum}: ${match.contextAfter[i]}`);
					}
				}

				output.push('');
			}
		});
	}

	return output.join('\n');
}

/**
 * 按文件分组结果
 */
function groupByFile(results: SearchMatch[]): Map<string, SearchMatch[]> {
	const grouped = new Map<string, SearchMatch[]>();

	for (const result of results) {
		const existing = grouped.get(result.file);
		if (existing) {
			existing.push(result);
		} else {
			grouped.set(result.file, [result]);
		}
	}

	return grouped;
}
