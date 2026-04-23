/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Read File Tool - 增强版
 *
 * 性能优化（借鉴 Cline、Continue、Aider）：
 * - 自动编码检测（支持 UTF-8、GBK、GB2312、Shift_JIS 等）
 * - 二进制文件检测（避免读取二进制垃圾）
 * - 文件内容缓存（基于 mtime，30秒 TTL）
 * - 大文件分块读取
 * - 特殊格式文件提示（PDF、DOCX、图片等）
 */

import * as path from 'path';
import * as fs from 'fs';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

// ========== 配置常量 ==========
const READ_FILE_CONFIG = {
	/** 最大文件大小（10MB） */
	MAX_FILE_SIZE: 10 * 1024 * 1024,

	/** 大文件警告阈值（500KB） */
	LARGE_FILE_WARNING: 500 * 1024,

	/** 缓存 TTL（30秒） */
	CACHE_TTL_MS: 30000,

	/** 最大缓存条目数 */
	MAX_CACHE_ENTRIES: 100,

	/** 二进制检测采样大小 */
	BINARY_CHECK_SIZE: 8192,

	/** 编码检测采样大小 */
	ENCODING_CHECK_SIZE: 65536,

	/** 行号显示宽度 */
	LINE_NUMBER_WIDTH: 4,

	/** 每行最大字符数（超出截断，参考 OpenCode read.ts MAX_LINE_LENGTH = 2000） */
	MAX_LINE_LENGTH: 2000,

	/** 默认分块读取的最大行数 */
	DEFAULT_CHUNK_LINES: 2000,
};

// ========== 文件缓存 ==========
interface FileCacheEntry {
	content: string;
	mtime: number;
	timestamp: number;
	encoding: string;
	lineCount: number;
}

const fileCache = new Map<string, FileCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * 清理过期缓存
 */
function cleanExpiredCache(): void {
	const now = Date.now();
	const keysToDelete: string[] = [];

	fileCache.forEach((entry, key) => {
		if (now - entry.timestamp > READ_FILE_CONFIG.CACHE_TTL_MS) {
			keysToDelete.push(key);
		}
	});

	keysToDelete.forEach(key => fileCache.delete(key));

	// 如果仍超过限制，删除最旧的
	if (fileCache.size > READ_FILE_CONFIG.MAX_CACHE_ENTRIES) {
		const entries = Array.from(fileCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const toDelete = entries.slice(0, Math.floor(READ_FILE_CONFIG.MAX_CACHE_ENTRIES / 2));
		toDelete.forEach(([key]) => fileCache.delete(key));
	}
}

/**
 * 使缓存失效（文件被修改时调用）
 */
export function invalidateFileCache(filePath: string): void {
	fileCache.delete(filePath);
}

/**
 * 获取缓存统计
 */
export function getFileCacheStats(): { size: number; hitRate: string; hits: number; misses: number } {
	const total = cacheHits + cacheMisses;
	const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : '0';
	return {
		size: fileCache.size,
		hitRate,
		hits: cacheHits,
		misses: cacheMisses,
	};
}

// ========== 二进制文件检测 ==========

/** 二进制文件的魔数签名 */
const BINARY_SIGNATURES: { [key: string]: number[] } = {
	// 图片格式
	'PNG': [0x89, 0x50, 0x4E, 0x47],
	'JPEG': [0xFF, 0xD8, 0xFF],
	'GIF': [0x47, 0x49, 0x46, 0x38],
	'WEBP': [0x52, 0x49, 0x46, 0x46],
	'BMP': [0x42, 0x4D],
	'ICO': [0x00, 0x00, 0x01, 0x00],

	// 压缩格式
	'ZIP': [0x50, 0x4B, 0x03, 0x04],
	'GZIP': [0x1F, 0x8B],
	'RAR': [0x52, 0x61, 0x72, 0x21],
	'7Z': [0x37, 0x7A, 0xBC, 0xAF],
	'TAR': [0x75, 0x73, 0x74, 0x61, 0x72],

	// 可执行文件
	'ELF': [0x7F, 0x45, 0x4C, 0x46],
	'PE/COFF': [0x4D, 0x5A],
	'Mach-O': [0xFE, 0xED, 0xFA, 0xCE],
	'Mach-O64': [0xFE, 0xED, 0xFA, 0xCF],

	// 文档格式
	'PDF': [0x25, 0x50, 0x44, 0x46],
	'DOCX/XLSX': [0x50, 0x4B, 0x03, 0x04], // 和 ZIP 相同

	// 数据库
	'SQLite': [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65],

	// 音视频
	'MP3': [0xFF, 0xFB],
	'MP4': [0x00, 0x00, 0x00],
	'AVI': [0x52, 0x49, 0x46, 0x46],
};

/** 二进制文件扩展名 */
const BINARY_EXTENSIONS = new Set([
	// 图片
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.tiff', '.psd',
	// 压缩
	'.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz',
	// 可执行
	'.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
	// 文档（二进制格式）
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	// 音视频
	'.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.mkv', '.webm',
	// 字体
	'.ttf', '.otf', '.woff', '.woff2', '.eot',
	// 数据
	'.db', '.sqlite', '.sqlite3',
	// 其他
	'.class', '.jar', '.pyc', '.pyo', '.node', '.wasm',
]);

/** 二进制文件名模式（用于复合扩展名如 .jar.original） */
const BINARY_FILE_PATTERNS = [
	/\.jar($|\.)/i,      // .jar 或 .jar.xxx
	/\.war($|\.)/i,      // .war 或 .war.xxx
	/\.ear($|\.)/i,      // .ear 或 .ear.xxx
	/\.class$/i,
	/\.pyc$/i,
	/\.pyo$/i,
	/\.so(\.\d+)*$/i,    // .so, .so.1, .so.1.2.3
	/\.dll$/i,
	/\.exe$/i,
	/\.bin$/i,
];

/** 应该跳过的目录（编译输出、依赖等） */
const SKIP_DIRECTORIES = new Set([
	'target',
	'build',
	'out',
	'dist',
	'node_modules',
	'.git',
	'.svn',
	'.hg',
	'__pycache__',
	'.pytest_cache',
	'venv',
	'.venv',
	'.next',
	'.nuxt',
	'coverage',
]);

/**
 * 检查文件路径是否在应该跳过的目录中
 */
function isInSkipDirectory(filePath: string): boolean {
	const parts = filePath.split(path.sep);
	return parts.some(part => SKIP_DIRECTORIES.has(part));
}

/**
 * 检测文件是否为二进制
 */
function isBinaryFile(filePath: string, buffer: Buffer): { isBinary: boolean; format?: string; reason?: string } {
	const ext = path.extname(filePath).toLowerCase();
	const fileName = path.basename(filePath);

	// 0. 检查是否在跳过目录中（如 target/）
	if (isInSkipDirectory(filePath)) {
		return { isBinary: true, format: 'Build Output', reason: '文件位于编译输出目录中' };
	}

	// 1. 扩展名快速判断
	if (BINARY_EXTENSIONS.has(ext)) {
		return { isBinary: true, format: ext.slice(1).toUpperCase() };
	}

	// 2. 文件名模式匹配（处理复合扩展名如 .jar.original）
	for (const pattern of BINARY_FILE_PATTERNS) {
		if (pattern.test(fileName)) {
			const match = fileName.match(pattern);
			return { isBinary: true, format: match ? match[0].replace(/\./g, '').toUpperCase() : 'Binary' };
		}
	}

	// 3. 魔数签名检测
	for (const [format, signature] of Object.entries(BINARY_SIGNATURES)) {
		if (signature.every((byte, i) => buffer[i] === byte)) {
			return { isBinary: true, format };
		}
	}

	// 3. 空字节检测（二进制文件通常包含 NULL 字节）
	const checkSize = Math.min(buffer.length, READ_FILE_CONFIG.BINARY_CHECK_SIZE);
	let nullCount = 0;
	let nonPrintableCount = 0;

	for (let i = 0; i < checkSize; i++) {
		const byte = buffer[i];
		if (byte === 0) {
			nullCount++;
		}
		// 非打印字符（排除常见控制字符：\t \n \r）
		if (byte < 0x09 || (byte > 0x0D && byte < 0x20) || byte === 0x7F) {
			if (byte !== 0) {
				nonPrintableCount++;
			}
		}
	}

	// 如果 NULL 字节超过 1% 或非打印字符超过 10%，认为是二进制
	const nullRatio = nullCount / checkSize;
	const nonPrintableRatio = nonPrintableCount / checkSize;

	if (nullRatio > 0.01 || nonPrintableRatio > 0.1) {
		return { isBinary: true, format: 'Unknown Binary' };
	}

	return { isBinary: false };
}

// ========== 编码检测 ==========

/** 常见编码的 BOM 标记 */
const BOM_MARKERS: { [encoding: string]: number[] } = {
	'UTF-8': [0xEF, 0xBB, 0xBF],
	'UTF-16BE': [0xFE, 0xFF],
	'UTF-16LE': [0xFF, 0xFE],
	'UTF-32BE': [0x00, 0x00, 0xFE, 0xFF],
	'UTF-32LE': [0xFF, 0xFE, 0x00, 0x00],
};

/**
 * 检测文件编码
 * 简化版实现，支持 BOM 检测和常见编码启发式检测
 */
function detectEncoding(buffer: Buffer): string {
	// 1. BOM 检测
	for (const [encoding, bom] of Object.entries(BOM_MARKERS)) {
		if (bom.every((byte, i) => buffer[i] === byte)) {
			return encoding;
		}
	}

	// 2. UTF-8 验证
	if (isValidUTF8(buffer)) {
		return 'UTF-8';
	}

	// 3. 中文编码启发式检测（GBK/GB2312）
	if (looksLikeGBK(buffer)) {
		return 'GBK';
	}

	// 4. 日文编码启发式检测（Shift_JIS）
	if (looksLikeShiftJIS(buffer)) {
		return 'Shift_JIS';
	}

	// 5. 默认使用 UTF-8（Node.js 会尝试解码）
	return 'UTF-8';
}

/**
 * 验证是否为有效的 UTF-8
 */
function isValidUTF8(buffer: Buffer): boolean {
	const checkSize = Math.min(buffer.length, READ_FILE_CONFIG.ENCODING_CHECK_SIZE);
	let i = 0;

	while (i < checkSize) {
		const byte = buffer[i];

		if (byte < 0x80) {
			// ASCII
			i++;
		} else if ((byte & 0xE0) === 0xC0) {
			// 2字节序列
			if (i + 1 >= checkSize || (buffer[i + 1] & 0xC0) !== 0x80) {
				return false;
			}
			i += 2;
		} else if ((byte & 0xF0) === 0xE0) {
			// 3字节序列
			if (i + 2 >= checkSize ||
				(buffer[i + 1] & 0xC0) !== 0x80 ||
				(buffer[i + 2] & 0xC0) !== 0x80) {
				return false;
			}
			i += 3;
		} else if ((byte & 0xF8) === 0xF0) {
			// 4字节序列
			if (i + 3 >= checkSize ||
				(buffer[i + 1] & 0xC0) !== 0x80 ||
				(buffer[i + 2] & 0xC0) !== 0x80 ||
				(buffer[i + 3] & 0xC0) !== 0x80) {
				return false;
			}
			i += 4;
		} else {
			return false;
		}
	}

	return true;
}

/**
 * 启发式检测 GBK 编码
 */
function looksLikeGBK(buffer: Buffer): boolean {
	const checkSize = Math.min(buffer.length, READ_FILE_CONFIG.ENCODING_CHECK_SIZE);
	let gbkSequences = 0;
	let i = 0;

	while (i < checkSize - 1) {
		const byte1 = buffer[i];
		const byte2 = buffer[i + 1];

		// GBK 双字节范围：0x81-0xFE, 0x40-0xFE
		if (byte1 >= 0x81 && byte1 <= 0xFE &&
			byte2 >= 0x40 && byte2 <= 0xFE) {
			gbkSequences++;
			i += 2;
		} else {
			i++;
		}
	}

	// 如果发现足够多的 GBK 序列，认为是 GBK
	return gbkSequences > 10;
}

/**
 * 启发式检测 Shift_JIS 编码
 */
function looksLikeShiftJIS(buffer: Buffer): boolean {
	const checkSize = Math.min(buffer.length, READ_FILE_CONFIG.ENCODING_CHECK_SIZE);
	let sjisSequences = 0;
	let i = 0;

	while (i < checkSize - 1) {
		const byte1 = buffer[i];
		const byte2 = buffer[i + 1];

		// Shift_JIS 双字节范围
		if (((byte1 >= 0x81 && byte1 <= 0x9F) || (byte1 >= 0xE0 && byte1 <= 0xFC)) &&
			((byte2 >= 0x40 && byte2 <= 0x7E) || (byte2 >= 0x80 && byte2 <= 0xFC))) {
			sjisSequences++;
			i += 2;
		} else {
			i++;
		}
	}

	return sjisSequences > 10;
}

/**
 * 使用检测到的编码读取文件内容
 */
function readFileWithEncoding(filePath: string, encoding: string): string {
	const buffer = fs.readFileSync(filePath);

	// Node.js 内置支持的编码
	const supportedEncodings: { [key: string]: BufferEncoding } = {
		'UTF-8': 'utf-8',
		'UTF-16LE': 'utf16le',
		'UTF-16BE': 'utf16le', // Node 不直接支持 BE，需要特殊处理
		'ASCII': 'ascii',
		'Latin1': 'latin1',
	};

	if (supportedEncodings[encoding]) {
		// 跳过 BOM
		let startIndex = 0;
		const bom = BOM_MARKERS[encoding];
		if (bom && bom.every((byte, i) => buffer[i] === byte)) {
			startIndex = bom.length;
		}
		return buffer.slice(startIndex).toString(supportedEncodings[encoding]);
	}

	// 对于 GBK/Shift_JIS 等，尝试使用 UTF-8 解码
	// 如果失败，返回原始内容（可能有乱码）
	try {
		return buffer.toString('utf-8');
	} catch {
		return buffer.toString('latin1');
	}
}

// ========== 特殊文件处理 ==========

interface SpecialFileInfo {
	type: string;
	description: string;
	canExtractText: boolean;
}

/**
 * 获取特殊文件信息
 */
function getSpecialFileInfo(filePath: string): SpecialFileInfo | null {
	const ext = path.extname(filePath).toLowerCase();

	const specialFiles: { [ext: string]: SpecialFileInfo } = {
		'.pdf': {
			type: 'PDF',
			description: 'PDF 文档',
			canExtractText: false, // 需要额外库支持
		},
		'.docx': {
			type: 'DOCX',
			description: 'Microsoft Word 文档',
			canExtractText: false,
		},
		'.xlsx': {
			type: 'XLSX',
			description: 'Microsoft Excel 表格',
			canExtractText: false,
		},
		'.pptx': {
			type: 'PPTX',
			description: 'Microsoft PowerPoint 演示文稿',
			canExtractText: false,
		},
		'.png': {
			type: 'PNG',
			description: 'PNG 图片',
			canExtractText: false,
		},
		'.jpg': {
			type: 'JPEG',
			description: 'JPEG 图片',
			canExtractText: false,
		},
		'.jpeg': {
			type: 'JPEG',
			description: 'JPEG 图片',
			canExtractText: false,
		},
		'.gif': {
			type: 'GIF',
			description: 'GIF 图片',
			canExtractText: false,
		},
		'.svg': {
			type: 'SVG',
			description: 'SVG 矢量图（XML 格式，可读取）',
			canExtractText: true, // SVG 是文本格式
		},
		'.mp3': {
			type: 'MP3',
			description: 'MP3 音频文件',
			canExtractText: false,
		},
		'.mp4': {
			type: 'MP4',
			description: 'MP4 视频文件',
			canExtractText: false,
		},
		'.zip': {
			type: 'ZIP',
			description: 'ZIP 压缩包',
			canExtractText: false,
		},
	};

	return specialFiles[ext] || null;
}

// ========== 主函数 ==========

export async function readFileTool(
	ctx: IToolContext,
	params: any,
): Promise<ToolResponse> {
	const filePath = params.path || params.args || '';
	const startLine = params.start_line ? parseInt(params.start_line, 10) : undefined;
	const endLine = params.end_line ? parseInt(params.end_line, 10) : undefined;

	if (!filePath) {
		return 'Error: No file path provided';
	}

	try {
		// 解析绝对路径
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(ctx.workspacePath, filePath);

		// 检查文件是否存在
		if (!fs.existsSync(absolutePath)) {
			const basename = path.basename(absolutePath);
			// "Did you mean?" 模糊匹配（参考 OpenCode read.ts）
			const parentDir = path.dirname(absolutePath);
			const parentExists = fs.existsSync(parentDir);
			const targetName = basename.toLowerCase();
			if (parentExists) {
				try {
					const dirContents = fs.readdirSync(parentDir);
					const minMatchLen = Math.max(3, Math.floor(targetName.length * 0.6));
					const suggestions = dirContents
						.filter(f => {
							const lf = f.toLowerCase();
							return lf.includes(targetName.substring(0, minMatchLen)) ||
								targetName.includes(lf.substring(0, Math.max(3, Math.floor(lf.length * 0.6))));
						})
						.slice(0, 5);
					if (suggestions.length > 0) {
						const parentDir2 = path.dirname(filePath);
						const suggestionPaths = suggestions.map(f => path.join(parentDir2, f));
						return `Error: File not found: ${filePath}\n\nDid you mean one of these?\n${suggestionPaths.map(p => `  - ${p}`).join('\n')}\n\n💡 如果上面都不对，用 glob "**/${basename}" 在整个 workspace 里搜索正确位置，再用准确路径 read_file。不要重试相同路径。`;
					}
				} catch { /* ignore */ }
			}
			// D. 根据"父目录是否存在"给出不同的定位指引
			const guidance = parentExists
				? `💡 父目录 ${path.dirname(filePath)} 存在但里面没有 ${basename}。
建议用 \`list_files\` 看这个目录实际有什么文件；或者用 \`glob\` 搜 "**/${basename}" 在整个 workspace 里定位。
**不要重试相同路径**。`
				: `💡 父目录 ${path.dirname(filePath)} 也不存在。整个路径可能是错的。
建议先用 \`list_files\` 看 workspace 根目录结构，或者用 \`glob\` 搜 "**/${basename}" 定位真实文件。
**不要重试相同路径**。`;
			return `Error: File not found: ${filePath}\n\n${guidance}`;
		}

		// 获取文件状态
		const stat = fs.statSync(absolutePath);

		if (stat.isDirectory()) {
			return `Error: Path is a directory, not a file: ${filePath}\n\n💡 Use list_files tool to list directory contents.`;
		}

		// 检查文件大小
		if (stat.size > READ_FILE_CONFIG.MAX_FILE_SIZE) {
			return `Error: File too large (${formatBytes(stat.size)}). Maximum supported size is ${formatBytes(READ_FILE_CONFIG.MAX_FILE_SIZE)}.\n\n💡 Use start_line and end_line parameters to read specific portions.`;
		}

		// 图片特殊处理：以 Markdown data URL 形式返回，让前端直接渲染（走 DOMPurify 白名单）
		const ext = path.extname(absolutePath).toLowerCase();
		const IMAGE_EXTS: Record<string, string> = {
			'.png':  'image/png',
			'.jpg':  'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.gif':  'image/gif',
			'.webp': 'image/webp',
			'.svg':  'image/svg+xml',
			'.bmp':  'image/bmp',
		};
		if (IMAGE_EXTS[ext]) {
			// 10MB 上限避免吃爆上下文
			if (stat.size > 10 * 1024 * 1024) {
				return `⚠️ 图片过大\n\nFile: ${filePath}\nSize: ${formatBytes(stat.size)}\n超过 10MB 上限，无法嵌入上下文。`;
			}
			try {
				const data = fs.readFileSync(absolutePath);
				const b64 = data.toString('base64');
				return `# 图片文件: ${path.basename(absolutePath)}\n\n- 路径: \`${filePath}\`\n- 尺寸: ${formatBytes(stat.size)}\n- 类型: ${IMAGE_EXTS[ext]}\n\n![${path.basename(absolutePath)}](data:${IMAGE_EXTS[ext]};base64,${b64})`;
			} catch (e) {
				return `Error: 读取图片失败: ${(e as Error).message}`;
			}
		}

		// PDF：暂不支持提取，给出明确提示
		if (ext === '.pdf') {
			return `⚠️ PDF File Detected\n\nFile: ${filePath}\nSize: ${formatBytes(stat.size)}\n\n当前不支持 PDF 文本提取。建议：\n- 先用外部工具（如 pdftotext）转成 .txt 再读\n- 或使用支持 PDF 的 MCP 工具`;
		}

		// 检查其他特殊文件类型
		const specialInfo = getSpecialFileInfo(absolutePath);
		if (specialInfo && !specialInfo.canExtractText) {
			return `⚠️ Binary File Detected\n\nFile: ${filePath}\nType: ${specialInfo.type}\nDescription: ${specialInfo.description}\n\nThis is a ${specialInfo.type} file that cannot be read as text.`;
		}

		// 读取文件头部进行二进制检测
		const headerBuffer = Buffer.alloc(READ_FILE_CONFIG.BINARY_CHECK_SIZE);
		const fd = fs.openSync(absolutePath, 'r');
		fs.readSync(fd, headerBuffer, 0, READ_FILE_CONFIG.BINARY_CHECK_SIZE, 0);
		fs.closeSync(fd);

		// 二进制文件检测
		const binaryCheck = isBinaryFile(absolutePath, headerBuffer);
		if (binaryCheck.isBinary) {
			const reasonText = binaryCheck.reason ? `\nReason: ${binaryCheck.reason}` : '';
			return `⚠️ Binary File Detected\n\nFile: ${filePath}\nFormat: ${binaryCheck.format}\nSize: ${formatBytes(stat.size)}${reasonText}\n\nThis appears to be a binary file that cannot be displayed as text.\n\n💡 If you expected a text file, please check the file path.`;
		}

		// 检查缓存
		cleanExpiredCache();
		const cachedEntry = fileCache.get(absolutePath);

		if (cachedEntry && cachedEntry.mtime === stat.mtimeMs) {
			cacheHits++;
			console.log(`[ReadFileTool] 缓存命中: ${filePath} (命中率: ${getFileCacheStats().hitRate}%)`);
			return formatFileContent(filePath, cachedEntry.content, cachedEntry.lineCount,
				cachedEntry.encoding, startLine, endLine, true);
		}

		cacheMisses++;

		// 检测编码
		const encoding = detectEncoding(headerBuffer);
		console.log(`[ReadFileTool] 检测到编码: ${encoding} for ${filePath}`);

		// 读取文件内容
		const content = readFileWithEncoding(absolutePath, encoding);
		const lines = content.split('\n');

		// 更新缓存
		fileCache.set(absolutePath, {
			content,
			mtime: stat.mtimeMs,
			timestamp: Date.now(),
			encoding,
			lineCount: lines.length,
		});

		// 大文件警告
		const isLargeFile = stat.size > READ_FILE_CONFIG.LARGE_FILE_WARNING;

		// 追踪文件访问
		ctx.fileContextTracker.trackFileRead(absolutePath, 'read_tool');
		ctx.didEditFile = true;

		// FileTime：记录 mtime/size 作为后续 edit/write/multiedit 的陈旧检测基线
		if (ctx.sessionId) {
			try {
				const { FileTime } = await import('../file/FileTime.js');
				FileTime.read(ctx.sessionId, absolutePath);
			} catch { /* FileTime 可选，不阻塞读 */ }
		}

		return formatFileContent(filePath, content, lines.length, encoding, startLine, endLine, false, isLargeFile, stat.size);
	} catch (error) {
		const msg = (error as Error).message;
		const code = (error as NodeJS.ErrnoException).code;
		// D. 根据 Node 系统错误码给出针对性指引
		let hint = '';
		if (code === 'EACCES' || msg.includes('EACCES')) {
			hint = '\n\n💡 权限不足。直接向用户汇报文件无法访问，不要重试。';
		} else if (code === 'EISDIR' || msg.includes('EISDIR')) {
			hint = '\n\n💡 路径是目录不是文件，用 `list_files` 查看目录内容。';
		} else if (code === 'ENOENT' || msg.includes('ENOENT')) {
			hint = '\n\n💡 文件不存在。用 `glob` 搜 "**/<basename>" 定位真实路径，不要重试相同路径。';
		} else if (msg.toLowerCase().includes('encoding') || msg.toLowerCase().includes('binary')) {
			hint = '\n\n💡 文件可能是二进制或编码异常。如果是代码文件，检查 BOM 或非 UTF-8 编码；二进制文件不要用 read_file。';
		}
		return `Error reading file: ${msg}${hint}`;
	}
}

/**
 * 格式化文件内容输出
 */
function formatFileContent(
	filePath: string,
	content: string,
	totalLines: number,
	encoding: string,
	startLine?: number,
	endLine?: number,
	fromCache = false,
	isLargeFile = false,
	fileSize?: number
): string {
	const lines = content.split('\n');

	// 应用行范围
	let resultLines: string[];
	let actualStart = 1;
	let actualEnd = totalLines;
	let isPartialView = false;
	let chunkTruncated = false;

	const MAX_CHUNK = READ_FILE_CONFIG.DEFAULT_CHUNK_LINES;

	if (startLine !== undefined && endLine !== undefined) {
		actualStart = Math.max(1, startLine);
		actualEnd = Math.min(totalLines, endLine);
		// 区间超过 MAX_CHUNK 时截断
		if (actualEnd - actualStart + 1 > MAX_CHUNK) {
			actualEnd = actualStart + MAX_CHUNK - 1;
			chunkTruncated = true;
		}
		resultLines = lines.slice(actualStart - 1, actualEnd);
		isPartialView = !(actualStart === 1 && actualEnd === totalLines);
	} else if (startLine !== undefined) {
		actualStart = Math.max(1, startLine);
		actualEnd = Math.min(totalLines, actualStart + MAX_CHUNK - 1);
		if (actualEnd < totalLines) {
			chunkTruncated = true;
		}
		resultLines = lines.slice(actualStart - 1, actualEnd);
		isPartialView = !(actualStart === 1 && actualEnd === totalLines);
	} else if (endLine !== undefined) {
		actualEnd = Math.min(totalLines, endLine);
		actualStart = Math.max(1, actualEnd - MAX_CHUNK + 1);
		if (actualEnd - actualStart + 1 >= MAX_CHUNK && actualStart > 1) {
			chunkTruncated = true;
		}
		resultLines = lines.slice(actualStart - 1, actualEnd);
		isPartialView = !(actualStart === 1 && actualEnd === totalLines);
	} else {
		// 用户未指定任何范围：文件 > MAX_CHUNK 行时默认只读前 MAX_CHUNK 行
		if (totalLines > MAX_CHUNK) {
			actualStart = 1;
			actualEnd = MAX_CHUNK;
			resultLines = lines.slice(0, MAX_CHUNK);
			chunkTruncated = true;
			isPartialView = true;
		} else {
			resultLines = lines;
		}
	}

	// 添加行号（超长行截断，参考 OpenCode read.ts MAX_LINE_LENGTH）
	const numberedLines = resultLines.map((line, idx) => {
		const lineNum = actualStart + idx;
		const truncatedLine = line.length > READ_FILE_CONFIG.MAX_LINE_LENGTH
			? line.substring(0, READ_FILE_CONFIG.MAX_LINE_LENGTH) + ` ... [line truncated, ${line.length - READ_FILE_CONFIG.MAX_LINE_LENGTH} chars omitted]`
			: line;
		return `${lineNum.toString().padStart(READ_FILE_CONFIG.LINE_NUMBER_WIDTH, ' ')} | ${truncatedLine}`;
	});

	// 构建输出
	const header: string[] = [
		`File: ${filePath}`,
		`Total Lines: ${totalLines}`,
	];

	if (startLine || endLine || isPartialView) {
		header.push(`Range: ${actualStart}-${actualEnd} (${resultLines.length} lines)`);
	}

	if (chunkTruncated) {
		const nextStart = actualEnd + 1;
		header.push(`[文件共 ${totalLines} 行，本次显示 ${actualStart}-${actualEnd} 行。如需继续请带 start_line=${nextStart}]`);
	}

	if (encoding !== 'UTF-8') {
		header.push(`Encoding: ${encoding}`);
	}

	if (fromCache) {
		header.push(`(cached)`);
	}

	if (isLargeFile && fileSize) {
		header.push(`⚠️ Large file: ${formatBytes(fileSize)}`);
	}

	return [
		...header,
		'',
		'Content:',
		'```',
		numberedLines.join('\n'),
		'```',
	].filter(Boolean).join('\n');
}

/**
 * 格式化字节大小
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
