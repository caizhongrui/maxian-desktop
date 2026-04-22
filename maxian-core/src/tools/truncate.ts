/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Output Truncation Service
 *
 *  对标 OpenCode `packages/opencode/src/tool/truncate.ts`
 *  工具输出超过阈值（2000 行 / 50KB）时，保留头/尾预览 + 全文写入临时目录，
 *  返回带有"引用路径"的提示，避免将大输出塞入 AI 上下文。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export namespace Truncate {
	export const MAX_LINES = 2000;
	export const MAX_BYTES = 50 * 1024;
	export const DIR = path.join(os.homedir(), '.maxian', 'truncations');

	/** 保留策略：head = 保留开头；tail = 保留结尾 */
	export type Direction = 'head' | 'tail';

	export interface Options {
		maxLines?:  number;
		maxBytes?:  number;
		direction?: Direction;
	}

	export type Result =
		| { content: string; truncated: false }
		| { content: string; truncated: true; outputPath: string };

	/** 按天清理老截断文件（7 天保留期） */
	export function cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
		try {
			if (!fs.existsSync(DIR)) return;
			const now = Date.now();
			for (const entry of fs.readdirSync(DIR)) {
				if (!entry.startsWith('tool_')) continue;
				const p = path.join(DIR, entry);
				try {
					const stat = fs.statSync(p);
					if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(p);
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}

	function generateId(): string {
		const ts = Date.now().toString(36);
		const rand = Math.random().toString(36).slice(2, 8);
		return `tool_${ts}_${rand}.txt`;
	}

	/** 确保目录存在 */
	function ensureDir(): void {
		if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
	}

	/**
	 * 处理输出：如果在阈值内返回原文；超出则保留预览 + 写盘返回提示。
	 * @param text 原始工具输出
	 * @param options 阈值与方向
	 * @param hasTaskTool 是否有 task 子 Agent 工具，决定 hint 措辞
	 */
	export function output(
		text:         string,
		options:      Options = {},
		hasTaskTool:  boolean = false,
	): Result {
		const maxLines  = options.maxLines  ?? MAX_LINES;
		const maxBytes  = options.maxBytes  ?? MAX_BYTES;
		const direction = options.direction ?? 'head';

		const lines      = text.split('\n');
		const totalBytes = Buffer.byteLength(text, 'utf8');

		// 在阈值内：直接返回
		if (lines.length <= maxLines && totalBytes <= maxBytes) {
			return { content: text, truncated: false };
		}

		// 收集预览片段（贪婪地填到第一个触达阈值）
		const previewLines: string[] = [];
		let accBytes = 0;
		let hitBytes = false;

		if (direction === 'head') {
			for (let i = 0; i < lines.length && previewLines.length < maxLines; i++) {
				const sz = Buffer.byteLength(lines[i], 'utf8') + (previewLines.length > 0 ? 1 : 0);
				if (accBytes + sz > maxBytes) { hitBytes = true; break; }
				previewLines.push(lines[i]);
				accBytes += sz;
			}
		} else {
			for (let i = lines.length - 1; i >= 0 && previewLines.length < maxLines; i--) {
				const sz = Buffer.byteLength(lines[i], 'utf8') + (previewLines.length > 0 ? 1 : 0);
				if (accBytes + sz > maxBytes) { hitBytes = true; break; }
				previewLines.unshift(lines[i]);
				accBytes += sz;
			}
		}

		const removed = hitBytes ? totalBytes - accBytes : lines.length - previewLines.length;
		const unit    = hitBytes ? 'bytes' : 'lines';
		const preview = previewLines.join('\n');

		// 写盘
		try {
			ensureDir();
		} catch (e) {
			// 写盘失败降级：返回截断后的预览，不带引用
			return {
				content:   direction === 'head'
					? `${preview}\n\n… 截断 ${removed} ${unit}（写盘失败，全文不可恢复）`
					: `… 截断 ${removed} ${unit}（写盘失败，全文不可恢复）\n\n${preview}`,
				truncated: false,
			};
		}

		const file = path.join(DIR, generateId());
		try {
			fs.writeFileSync(file, text, 'utf8');
		} catch {
			return {
				content:   direction === 'head'
					? `${preview}\n\n… 截断 ${removed} ${unit}（写盘失败，全文不可恢复）`
					: `… 截断 ${removed} ${unit}（写盘失败，全文不可恢复）\n\n${preview}`,
				truncated: false,
			};
		}

		const hint = hasTaskTool
			? `\n\n[输出过大：${removed} ${unit} 已截断]\n全文已保存到：${file}\n建议：用 task 工具让 explore 子 Agent 以 grep/read_file (offset/limit) 方式分析该文件，不要自己整个读。`
			: `\n\n[输出过大：${removed} ${unit} 已截断]\n全文已保存到：${file}\n建议：用 grep 或 read_file (offset/limit) 按需查询。`;

		return {
			content:    direction === 'head' ? preview + hint : hint + '\n\n' + preview,
			truncated:  true,
			outputPath: file,
		};
	}
}
