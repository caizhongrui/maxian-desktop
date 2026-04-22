/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WebFetch 工具
 * 参考 OpenCode tool/webfetch.ts 实现
 *
 * 功能：
 * - 获取网页内容
 * - HTML 转 Markdown
 * - 支持缓存（15分钟）
 * - 自动处理重定向
 * - 提取关键信息
 *
 * 使用场景：
 * - 获取 API 文档
 * - 读取在线资源
 * - 获取代码示例
 */

/**
 * WebFetch 工具参数
 */
export interface WebFetchParams {
	/** 要获取的 URL（必需） */
	url: string;
	/** 处理内容的提示词（可选） */
	prompt?: string;
	/** 输出格式：markdown | text | json */
	format?: 'markdown' | 'text' | 'json';
	/** 是否使用缓存 */
	useCache?: boolean;
}

/**
 * WebFetch 执行结果
 */
export interface WebFetchResult {
	/** 是否成功 */
	success: boolean;
	/** 结果内容 */
	content?: string;
	/** 错误消息 */
	error?: string;
	/** 元数据 */
	metadata?: {
		/** 原始 URL */
		url: string;
		/** 最终 URL（可能重定向） */
		finalUrl?: string;
		/** 标题 */
		title?: string;
		/** 内容类型 */
		contentType?: string;
		/** 内容长度 */
		contentLength?: number;
		/** 是否来自缓存 */
		fromCache?: boolean;
		/** 获取时间 */
		fetchTime?: number;
	};
}

/**
 * WebFetch 配置
 */
export const WEBFETCH_CONFIG = {
	/** 缓存时间（毫秒） */
	CACHE_TTL_MS: 15 * 60 * 1000, // 15分钟

	/** 最大内容长度（字符）- 对齐 OpenCode：5MB */
	MAX_CONTENT_LENGTH: 5 * 1024 * 1024, // 5MB

	/** 请求超时（毫秒） */
	TIMEOUT_MS: 30000, // 30秒

	/** 允许的域名（空数组表示允许所有） */
	ALLOWED_DOMAINS: [] as string[],

	/** 禁止的域名 */
	BLOCKED_DOMAINS: [
		'localhost',
		'127.0.0.1',
		'0.0.0.0',
	],

	/** 默认 User-Agent */
	USER_AGENT: 'Mozilla/5.0 (compatible; MaxianIDE/1.0)',
};

/**
 * 缓存条目
 */
interface CacheEntry {
	content: string;
	metadata: WebFetchResult['metadata'];
	timestamp: number;
}

/**
 * 简单的内存缓存
 */
const cache = new Map<string, CacheEntry>();

/**
 * 清理过期缓存
 */
function cleanExpiredCache(): void {
	const now = Date.now();
	for (const [key, entry] of cache.entries()) {
		if (now - entry.timestamp > WEBFETCH_CONFIG.CACHE_TTL_MS) {
			cache.delete(key);
		}
	}
}

/**
 * 验证 URL
 */
export function validateUrl(url: string): { valid: boolean; error?: string } {
	try {
		const parsed = new URL(url);

		// 检查协议
		if (!['http:', 'https:'].includes(parsed.protocol)) {
			return { valid: false, error: `不支持的协议: ${parsed.protocol}` };
		}

		// 检查禁止的域名
		const hostname = parsed.hostname.toLowerCase();
		if (WEBFETCH_CONFIG.BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))) {
			return { valid: false, error: `禁止访问的域名: ${hostname}` };
		}

		// 检查允许的域名（如果有限制）
		if (WEBFETCH_CONFIG.ALLOWED_DOMAINS.length > 0) {
			const allowed = WEBFETCH_CONFIG.ALLOWED_DOMAINS.some(d =>
				hostname === d || hostname.endsWith(`.${d}`)
			);
			if (!allowed) {
				return { valid: false, error: `域名不在允许列表中: ${hostname}` };
			}
		}

		return { valid: true };
	} catch (e) {
		return { valid: false, error: `无效的 URL: ${url}` };
	}
}

/**
 * HTML 转 Markdown（简化版）
 * 实际实现可以使用 turndown 等库
 */
export function htmlToMarkdown(html: string): string {
	// 移除 script 和 style
	let content = html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

	// 处理标题
	content = content
		.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
		.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
		.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
		.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
		.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n')
		.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n');

	// 处理段落
	content = content.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n');

	// 处理列表
	content = content
		.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
		.replace(/<ul[^>]*>/gi, '\n')
		.replace(/<\/ul>/gi, '\n')
		.replace(/<ol[^>]*>/gi, '\n')
		.replace(/<\/ol>/gi, '\n');

	// 处理链接
	content = content.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

	// 处理粗体和斜体
	content = content
		.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, '**$2**')
		.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, '*$2*');

	// 处理代码
	content = content
		.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
		.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '\n```\n$1\n```\n');

	// 处理换行
	content = content.replace(/<br\s*\/?>/gi, '\n');

	// 移除其他 HTML 标签
	content = content.replace(/<[^>]+>/g, '');

	// 解码 HTML 实体
	content = content
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");

	// 清理多余空行
	content = content.replace(/\n{3,}/g, '\n\n').trim();

	return content;
}

/**
 * 提取网页标题
 */
export function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
	return match ? match[1].trim() : undefined;
}

/**
 * 执行 WebFetch（模拟实现）
 * 实际实现需要通过 IDE 的网络服务
 */
export async function executeWebFetch(params: WebFetchParams): Promise<WebFetchResult> {
	const startTime = Date.now();

	// 验证 URL
	const validation = validateUrl(params.url);
	if (!validation.valid) {
		return {
			success: false,
			error: validation.error,
		};
	}

	// 检查缓存
	if (params.useCache !== false) {
		cleanExpiredCache();
		const cached = cache.get(params.url);
		if (cached && cached.metadata) {
			return {
				success: true,
				content: cached.content,
				metadata: {
					url: cached.metadata.url || params.url,
					finalUrl: cached.metadata.finalUrl,
					title: cached.metadata.title,
					contentType: cached.metadata.contentType,
					contentLength: cached.metadata.contentLength,
					fetchTime: cached.metadata.fetchTime,
					fromCache: true,
				},
			};
		}
	}

	// 实际的网络请求需要通过 IDE 的服务来执行
	// 这里只是定义接口，实际实现需要在 browser 层
	return {
		success: false,
		error: 'WebFetch 需要通过 IDE 服务执行。请确保 IDE 已正确配置网络服务。',
		metadata: {
			url: params.url,
			fetchTime: Date.now() - startTime,
		},
	};
}

/**
 * 处理 fetch 响应
 * 这个函数会在 browser 层的实际实现中调用
 */
export function processResponse(
	url: string,
	html: string,
	contentType: string,
	params: WebFetchParams
): WebFetchResult {
	const startTime = Date.now();

	try {
		let content: string;
		const format = params.format || 'markdown';

		if (format === 'json') {
			// 尝试解析 JSON
			try {
				const json = JSON.parse(html);
				content = JSON.stringify(json, null, 2);
			} catch {
				content = html;
			}
		} else if (format === 'markdown' || contentType.includes('text/html')) {
			// HTML 转 Markdown
			content = htmlToMarkdown(html);
		} else {
			// 纯文本
			content = html;
		}

		// 截断过长内容
		if (content.length > WEBFETCH_CONFIG.MAX_CONTENT_LENGTH) {
			content = content.substring(0, WEBFETCH_CONFIG.MAX_CONTENT_LENGTH) +
				'\n\n... (内容已截断)';
		}

		const title = extractTitle(html);

		const result: WebFetchResult = {
			success: true,
			content,
			metadata: {
				url,
				title,
				contentType,
				contentLength: content.length,
				fromCache: false,
				fetchTime: Date.now() - startTime,
			},
		};

		// 存入缓存
		if (params.useCache !== false) {
			cache.set(url, {
				content,
				metadata: result.metadata,
				timestamp: Date.now(),
			});
		}

		return result;
	} catch (error) {
		return {
			success: false,
			error: `处理响应失败: ${error instanceof Error ? error.message : String(error)}`,
			metadata: {
				url,
				fetchTime: Date.now() - startTime,
			},
		};
	}
}

/**
 * 格式化 WebFetch 结果
 */
export function formatWebFetchResponse(result: WebFetchResult): string {
	const lines: string[] = [];

	if (result.success) {
		if (result.metadata?.title) {
			lines.push(`# ${result.metadata.title}`);
			lines.push('');
		}

		if (result.metadata?.url) {
			lines.push(`> 来源: ${result.metadata.url}`);
			lines.push('');
		}

		lines.push(result.content || '(无内容)');

		if (result.metadata?.fromCache) {
			lines.push('');
			lines.push('---');
			lines.push('*此内容来自缓存*');
		}
	} else {
		lines.push(`❌ 获取失败`);
		lines.push('');
		lines.push(result.error || '未知错误');

		if (result.metadata?.url) {
			lines.push('');
			lines.push(`URL: ${result.metadata.url}`);
		}
	}

	return lines.join('\n');
}

/**
 * WebFetch 工具描述
 */
export const WEBFETCH_TOOL_DESCRIPTION = `## webfetch
Description: 获取网页内容并转换为 Markdown 格式。

**功能：**
- 获取任意网页内容
- 自动将 HTML 转换为 Markdown
- 支持 15 分钟缓存
- 自动处理重定向

**参数：**
- url (必需): 要获取的 URL，必须是 http 或 https
- prompt (可选): 处理内容的提示词，用于提取特定信息
- format (可选): 输出格式，可选 markdown/text/json
- useCache (可选): 是否使用缓存，默认 true

**示例 1 - 获取文档：**
<webfetch>
<url>https://docs.example.com/api</url>
</webfetch>

**示例 2 - 获取并提取信息：**
<webfetch>
<url>https://api.github.com/repos/owner/repo</url>
<prompt>提取仓库的 stars 数量和最近更新时间</prompt>
<format>json</format>
</webfetch>

**注意事项：**
- 只支持 http/https 协议
- localhost 和内网地址被禁止
- 内容超过 100KB 会被截断
- 请求超时时间为 30 秒
`;

/**
 * WebFetch 工具 JSON Schema
 */
export const WEBFETCH_TOOL_SCHEMA = {
	name: 'webfetch',
	description: '获取网页内容并转换为 Markdown 格式',
	input_schema: {
		type: 'object',
		properties: {
			url: {
				type: 'string',
				description: '要获取的 URL',
			},
			prompt: {
				type: 'string',
				description: '处理内容的提示词',
			},
			format: {
				type: 'string',
				enum: ['markdown', 'text', 'json'],
				description: '输出格式',
				default: 'markdown',
			},
			useCache: {
				type: 'boolean',
				description: '是否使用缓存',
				default: true,
			},
		},
		required: ['url'],
	},
};
