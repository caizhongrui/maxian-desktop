/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Ls Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/ls.ts`
 *  目录列表（含文件类型/大小/修改时间），比 list_files 更细。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IToolContext } from './IToolContext.js';

export interface ILsToolParams {
	/** 目标目录（相对或绝对，默认 "."） */
	path?:    string;
	/** 是否显示隐藏文件（. 开头） */
	showHidden?: boolean;
	/** 递归列出（最多 5 层）*/
	recursive?: boolean;
}

export interface ILsEntry {
	name:  string;
	type:  'file' | 'directory' | 'symlink' | 'other';
	size:  number;
	mtime: number;
	path:  string;  // 相对 params.path 的路径
}

export interface ILsToolResult {
	dir:     string;
	entries: ILsEntry[];
	error?:  string;
}

function toType(stat: fs.Stats): ILsEntry['type'] {
	if (stat.isSymbolicLink()) return 'symlink';
	if (stat.isDirectory()) return 'directory';
	if (stat.isFile()) return 'file';
	return 'other';
}

function listDir(root: string, rel: string, showHidden: boolean, recursive: boolean, depth: number, out: ILsEntry[]): void {
	if (depth > 5 || out.length > 1000) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch { return; }

	for (const entry of entries) {
		if (!showHidden && entry.name.startsWith('.')) continue;
		const full = path.join(root, rel, entry.name);
		let stat: fs.Stats;
		try { stat = fs.lstatSync(full); } catch { continue; }

		const item: ILsEntry = {
			name:  entry.name,
			type:  toType(stat),
			size:  stat.size,
			mtime: stat.mtimeMs,
			path:  path.join(rel, entry.name),
		};
		out.push(item);

		if (recursive && entry.isDirectory() && !entry.name.startsWith('.')) {
			listDir(root, path.join(rel, entry.name), showHidden, recursive, depth + 1, out);
		}
	}
}

export async function lsTool(
	ctx:    IToolContext,
	params: ILsToolParams,
): Promise<ILsToolResult> {
	const relPath = params.path ?? '.';
	const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(ctx.workspacePath, relPath);

	if (!fs.existsSync(absPath)) {
		return { dir: absPath, entries: [], error: `路径不存在: ${absPath}` };
	}

	let stat: fs.Stats;
	try { stat = fs.statSync(absPath); } catch (e) {
		return { dir: absPath, entries: [], error: (e as Error).message };
	}
	if (!stat.isDirectory()) {
		return { dir: absPath, entries: [], error: '不是目录' };
	}

	const entries: ILsEntry[] = [];
	listDir(absPath, '', params.showHidden ?? false, params.recursive ?? false, 0, entries);

	// 目录优先 + 字母序
	entries.sort((a, b) => {
		if (a.type !== b.type) {
			if (a.type === 'directory') return -1;
			if (b.type === 'directory') return 1;
		}
		return a.name.localeCompare(b.name);
	});

	return { dir: absPath, entries };
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

export function formatLsResult(r: ILsToolResult): string {
	if (r.error) return `Error: ${r.error}`;
	const lines: string[] = [`# ${r.dir}`, `共 ${r.entries.length} 项`, ''];
	for (const e of r.entries) {
		const typeIcon = e.type === 'directory' ? '📁'
			: e.type === 'symlink' ? '🔗'
			: '📄';
		const size = e.type === 'file' ? formatSize(e.size).padStart(8) : '        ';
		const mtime = new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ');
		lines.push(`${typeIcon} ${size} ${mtime}  ${e.path}`);
	}
	return lines.join('\n');
}
