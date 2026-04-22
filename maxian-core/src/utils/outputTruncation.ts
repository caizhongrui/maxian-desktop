/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 统一输出截断系统
 * 参考 OpenCode truncation.ts 实现
 *
 * 限制：
 * - MAX_LINES = 2000 行
 * - MAX_BYTES = 50KB
 * - 每行最多 2000 字符
 *
 * 截断后内容保存到 ~/.maxian/tool-outputs/{id}（供后续 read_file 使用）
 * 保留策略：7天自动清理
 */

// 环境检测：Node.js 环境才有 fs 模块（主进程）；渲染进程只做内存截断不保存
const IS_NODE_ENV = typeof process !== 'undefined' && process.versions && !!process.versions.node;

/** 最大行数 */
export const MAX_LINES = 2000;

/** 最大字节数（50KB） */
export const MAX_BYTES = 50 * 1024;

/** 每行最多字符数 */
export const MAX_LINE_LENGTH = 2000;

/** 保留天数 */
const RETENTION_DAYS = 7;

/** 输出目录（仅 Node.js 环境有效） */
let outputDir: string | null = null;

/**
 * 获取输出目录路径（懒初始化）
 */
async function getOutputDir(): Promise<string | null> {
	if (!IS_NODE_ENV) { return null; }
	if (outputDir) { return outputDir; }

	try {
		// 动态导入 fs/os（仅在 Node 环境执行）
		const os = await import('os');
		const fsPath = await import('path');
		const fs = await import('fs');

		const dir = fsPath.join(os.homedir(), '.maxian', 'tool-outputs');
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		outputDir = dir;
		return dir;
	} catch {
		return null;
	}
}

/**
 * 截断结果
 */
export interface TruncateResult {
	/** 截断后的内容 */
	content: string;
	/** 是否被截断 */
	truncated: boolean;
	/** 截断方式 */
	truncatedBy?: 'lines' | 'bytes';
	/** 原始行数 */
	totalLines?: number;
	/** 完整内容保存路径（仅 Node.js 环境） */
	outputPath?: string;
	/** 截断提示消息（添加到内容末尾） */
	notice?: string;
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
	return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 保存完整内容到磁盘（仅 Node.js 环境）
 */
async function saveFullOutput(content: string, id: string): Promise<string | undefined> {
	const dir = await getOutputDir();
	if (!dir) { return undefined; }

	try {
		const fsPath = await import('path');
		const fs = await import('fs');
		const filePath = fsPath.join(dir, `${id}.txt`);
		fs.writeFileSync(filePath, content, 'utf-8');
		return filePath;
	} catch {
		return undefined;
	}
}

/**
 * 截断文本内容（行 + 字节 + 每行字符双重限制）
 *
 * @param text 原始文本
 * @param options 截断选项
 * @returns 截断结果
 */
export async function truncateOutput(
	text: string,
	options?: {
		maxLines?: number;
		maxBytes?: number;
		maxLineLength?: number;
		direction?: 'head' | 'tail';
		saveToFile?: boolean;
	}
): Promise<TruncateResult> {
	const maxLines = options?.maxLines ?? MAX_LINES;
	const maxBytes = options?.maxBytes ?? MAX_BYTES;
	const maxLineLength = options?.maxLineLength ?? MAX_LINE_LENGTH;
	const direction = options?.direction ?? 'head';
	const saveToFile = options?.saveToFile ?? true;

	if (!text) {
		return { content: text, truncated: false };
	}

	// 先做每行字符截断
	const rawLines = text.split(/\r?\n/);
	const processedLines = rawLines.map(line => {
		if (line.length > maxLineLength) {
			return line.substring(0, maxLineLength) + `... (行截断，共 ${line.length} 字符)`;
		}
		return line;
	});

	const totalLines = processedLines.length;

	// 行数截断
	let selectedLines: string[];
	let truncatedByLines = false;

	if (totalLines > maxLines) {
		truncatedByLines = true;
		if (direction === 'tail') {
			selectedLines = processedLines.slice(totalLines - maxLines);
		} else {
			selectedLines = processedLines.slice(0, maxLines);
		}
	} else {
		selectedLines = processedLines;
	}

	// 字节截断
	let truncatedByBytes = false;
	const finalLines: string[] = [];
	let byteCount = 0;

	for (const line of selectedLines) {
		// 估算字节数：UTF-8 中中文字符约 3 字节，ASCII 字符 1 字节
		const lineBytes = estimateByteLength(line) + 1; // +1 for newline
		if (byteCount + lineBytes > maxBytes) {
			truncatedByBytes = true;
			break;
		}
		finalLines.push(line);
		byteCount += lineBytes;
	}

	const truncated = truncatedByLines || truncatedByBytes;

	if (!truncated) {
		return { content: text, truncated: false };
	}

	const truncatedContent = finalLines.join('\n');
	const truncatedBy = truncatedByBytes ? 'bytes' : 'lines';
	const displayedLines = finalLines.length;

	// 构建截断提示
	let notice: string;
	let outputPath: string | undefined;

	if (saveToFile) {
		const id = generateId();
		outputPath = await saveFullOutput(text, id);

		if (outputPath) {
			notice = [
				``,
				`<truncation_notice>`,
				`输出已截断：显示前 ${displayedLines} 行（共 ${totalLines} 行）。`,
				`完整输出已保存至: ${outputPath}`,
				`使用 read_file 工具并指定 start_line 参数读取后续内容。`,
				`</truncation_notice>`
			].join('\n');
		} else {
			notice = [
				``,
				`<truncation_notice>`,
				`输出已截断：显示前 ${displayedLines} 行（共 ${totalLines} 行）。`,
				`使用 start_line 参数或重新运行命令并加 | head -N 来控制输出量。`,
				`</truncation_notice>`
			].join('\n');
		}
	} else {
		notice = [
			``,
			`<truncation_notice>`,
			`输出已截断：显示前 ${displayedLines} 行（共 ${totalLines} 行，${truncatedBy === 'bytes' ? '字节限制' : '行数限制'}）。`,
			`</truncation_notice>`
		].join('\n');
	}

	return {
		content: truncatedContent + notice,
		truncated: true,
		truncatedBy,
		totalLines,
		outputPath,
		notice
	};
}

/**
 * 估算字符串字节长度（UTF-8）
 * 中文/日文/韩文字符约 3 字节，其他 ASCII 字符 1 字节
 */
function estimateByteLength(str: string): number {
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code > 0x7f) {
			bytes += 3; // 非 ASCII 字符估算为 3 字节
		} else {
			bytes += 1;
		}
	}
	return bytes;
}

/**
 * 清理超过保留期的旧输出文件（定期调用）
 */
export async function cleanupOldOutputFiles(): Promise<void> {
	if (!IS_NODE_ENV) { return; }

	const dir = await getOutputDir();
	if (!dir) { return; }

	try {
		const fs = await import('fs');
		const fsPath = await import('path');

		const files = fs.readdirSync(dir);
		const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

		for (const file of files) {
			if (!file.endsWith('.txt')) { continue; }
			const filePath = fsPath.join(dir, file);
			try {
				const stat = fs.statSync(filePath);
				if (stat.mtimeMs < cutoffTime) {
					fs.unlinkSync(filePath);
				}
			} catch {
				// 忽略单个文件清理失败
			}
		}
	} catch {
		// 忽略清理失败
	}
}

/**
 * 初始化：启动定期清理任务（每小时）
 */
export function initOutputTruncation(): void {
	if (!IS_NODE_ENV) { return; }
	// 延迟 5 秒后开始第一次清理，之后每小时清理一次
	setTimeout(() => {
		cleanupOldOutputFiles().catch(() => { /* ignore */ });
		setInterval(() => {
			cleanupOldOutputFiles().catch(() => { /* ignore */ });
		}, 60 * 60 * 1000);
	}, 5000);
}
