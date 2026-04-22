/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Glob Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/glob.ts`
 *  按 glob 模式匹配文件，结果按 mtime 降序（最近修改优先）。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IToolContext } from './IToolContext.js';

export interface IGlobToolParams {
	/** glob 模式，例如 "**\/*.ts" */
	pattern:  string;
	/** 起始目录（默认工作区） */
	path?:    string;
	/** 最多返回数（默认 200） */
	limit?:   number;
}

export interface IGlobToolResult {
	files:     string[];
	total:     number;
	truncated: boolean;
}

/** 简单的 glob 转正则（支持 ** / * / ?） */
function globToRegex(pattern: string): RegExp {
	let src = '';
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === '*' && pattern[i + 1] === '*') {
			// ** 匹配任意路径段
			src += '.*';
			i += 2;
			if (pattern[i] === '/') i++;
		} else if (c === '*') {
			src += '[^/]*';
			i++;
		} else if (c === '?') {
			src += '[^/]';
			i++;
		} else if ('.+^$()|[]{}\\'.includes(c)) {
			src += '\\' + c;
			i++;
		} else {
			src += c;
			i++;
		}
	}
	return new RegExp('^' + src + '$');
}

const SKIP_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
	'.next', '.nuxt', '.cache', '.parcel-cache', 'target', '.venv', 'venv',
	'__pycache__', '.pytest_cache', '.idea', '.vscode',
]);

function walkFiles(root: string, rel: string, limit: number, out: Array<{ rel: string; mtime: number }>): void {
	if (out.length >= limit) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch { return; }

	for (const entry of entries) {
		if (out.length >= limit) return;
		if (entry.name.startsWith('.') && entry.name.length > 1 && !entry.isFile()) continue;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkFiles(root, path.join(rel, entry.name), limit, out);
		} else if (entry.isFile()) {
			const full = path.join(root, rel, entry.name);
			try {
				const stat = fs.statSync(full);
				out.push({ rel: path.join(rel, entry.name), mtime: stat.mtimeMs });
			} catch { /* ignore */ }
		}
	}
}

export async function globTool(
	ctx:    IToolContext,
	params: IGlobToolParams,
): Promise<IGlobToolResult> {
	if (!params.pattern) {
		return { files: [], total: 0, truncated: false };
	}
	const startDir = params.path
		? (path.isAbsolute(params.path) ? params.path : path.resolve(ctx.workspacePath, params.path))
		: ctx.workspacePath;

	if (!fs.existsSync(startDir)) {
		return { files: [], total: 0, truncated: false };
	}

	const limit = params.limit ?? 200;
	const regex = globToRegex(params.pattern);

	// 收集候选（略宽松，先收集所有文件再过滤）
	const candidates: Array<{ rel: string; mtime: number }> = [];
	walkFiles(startDir, '', 10000, candidates);

	const matched = candidates.filter(f => {
		const norm = f.rel.replace(/\\/g, '/');
		return regex.test(norm);
	});

	// 按 mtime 降序
	matched.sort((a, b) => b.mtime - a.mtime);

	const total     = matched.length;
	const truncated = total > limit;
	const files     = matched.slice(0, limit).map(f => path.join(startDir, f.rel));

	return { files, total, truncated };
}

export function formatGlobResult(r: IGlobToolResult, params: IGlobToolParams): string {
	const hdr = `# Glob: ${params.pattern}\n共找到 ${r.total} 个文件${r.truncated ? `（仅显示前 ${r.files.length} 个，按 mtime 降序）` : ''}\n\n`;
	return hdr + r.files.join('\n');
}
