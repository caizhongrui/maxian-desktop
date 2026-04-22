/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Apply Patch Tool
 *
 *  对标 OpenCode `packages/opencode/src/tool/apply_patch.ts`
 *  应用 unified diff 格式补丁。支持：
 *   - 多文件补丁（一次调用修改多个文件）
 *   - --- / +++ / @@ 标准头部
 *   - 新建文件（原路径 = /dev/null）
 *   - 删除文件（新路径 = /dev/null）
 *  回退策略：任一 hunk 失败则整体回滚。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IToolContext } from './IToolContext.js';

export interface IApplyPatchParams {
	/** 标准 unified diff 文本 */
	patch: string;
}

export interface IApplyPatchResult {
	success:        boolean;
	filesChanged:   string[];
	filesCreated:   string[];
	filesDeleted:   string[];
	hunkApplied:    number;
	hunkFailed:     number;
	error?:         string;
	/** 被修改文件的 before/after 内容，供快照/回滚 */
	changes?: Array<{ path: string; before: string | null; after: string | null }>;
}

interface Hunk {
	origStart: number;
	origCount: number;
	newStart:  number;
	newCount:  number;
	lines:     string[];  // 带前缀 '+' / '-' / ' '
}

interface FilePatch {
	origPath: string;
	newPath:  string;
	hunks:    Hunk[];
}

function parseHeaders(lines: string[]): { patches: FilePatch[]; error?: string } {
	const patches: FilePatch[] = [];
	let i = 0;
	while (i < lines.length) {
		// 跳过非头部行
		while (i < lines.length && !lines[i].startsWith('--- ')) i++;
		if (i >= lines.length) break;

		const origMatch = lines[i].match(/^---\s+(?:a\/)?(.+?)(?:\s+.*)?$/);
		if (!origMatch) { i++; continue; }
		const origPath = origMatch[1].trim();

		i++;
		if (i >= lines.length || !lines[i].startsWith('+++ ')) {
			return { patches, error: `在 --- 后缺少 +++ 头部 (第 ${i + 1} 行)` };
		}
		const newMatch = lines[i].match(/^\+\+\+\s+(?:b\/)?(.+?)(?:\s+.*)?$/);
		if (!newMatch) { i++; continue; }
		const newPath = newMatch[1].trim();
		i++;

		// 收集 hunks
		const hunks: Hunk[] = [];
		while (i < lines.length && lines[i].startsWith('@@')) {
			const hm = lines[i].match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
			if (!hm) return { patches, error: `无效的 hunk 头部: ${lines[i]}` };
			const hunk: Hunk = {
				origStart: parseInt(hm[1], 10),
				origCount: hm[2] ? parseInt(hm[2], 10) : 1,
				newStart:  parseInt(hm[3], 10),
				newCount:  hm[4] ? parseInt(hm[4], 10) : 1,
				lines:     [],
			};
			i++;
			while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
				const l = lines[i];
				if (l === '' || l.startsWith(' ') || l.startsWith('+') || l.startsWith('-') || l.startsWith('\\')) {
					hunk.lines.push(l);
					i++;
				} else {
					break;
				}
			}
			hunks.push(hunk);
		}

		patches.push({ origPath, newPath, hunks });
	}
	return { patches };
}

function applyHunk(origLines: string[], hunk: Hunk): { lines: string[] } | { error: string } {
	const result: string[] = [];
	// 复制 hunk 之前的行
	const hunkOrigStart = hunk.origStart - 1;  // diff 是 1-based
	if (hunkOrigStart > origLines.length) {
		return { error: `hunk 起始行 ${hunk.origStart} 超过文件长度 ${origLines.length}` };
	}
	for (let i = 0; i < hunkOrigStart; i++) result.push(origLines[i]);

	let origIdx = hunkOrigStart;
	for (const line of hunk.lines) {
		if (line.startsWith('\\')) continue;  // "\ No newline at end of file"
		if (line.startsWith(' ')) {
			const expected = line.slice(1);
			if (origLines[origIdx] !== expected) {
				return { error: `上下文行不匹配（第 ${origIdx + 1} 行期望 "${expected}" 实际 "${origLines[origIdx] ?? '<EOF>'}"）` };
			}
			result.push(expected);
			origIdx++;
		} else if (line.startsWith('-')) {
			const expected = line.slice(1);
			if (origLines[origIdx] !== expected) {
				return { error: `删除行不匹配（第 ${origIdx + 1} 行期望 "${expected}" 实际 "${origLines[origIdx] ?? '<EOF>'}"）` };
			}
			origIdx++;
		} else if (line.startsWith('+')) {
			result.push(line.slice(1));
		}
	}
	// 复制 hunk 之后的行
	for (let i = origIdx; i < origLines.length; i++) result.push(origLines[i]);

	return { lines: result };
}

export async function applyPatchTool(
	ctx:    IToolContext,
	params: IApplyPatchParams,
): Promise<IApplyPatchResult> {
	const lines = (params.patch ?? '').split('\n');
	const { patches, error: parseErr } = parseHeaders(lines);
	if (parseErr) {
		return {
			success: false, filesChanged: [], filesCreated: [], filesDeleted: [],
			hunkApplied: 0, hunkFailed: 0, error: parseErr,
		};
	}

	const result: IApplyPatchResult = {
		success: true, filesChanged: [], filesCreated: [], filesDeleted: [],
		hunkApplied: 0, hunkFailed: 0, changes: [],
	};

	// 预处理所有变更（dry run）
	interface Plan { abs: string; before: string | null; after: string | null; isCreate: boolean; isDelete: boolean }
	const plans: Plan[] = [];

	for (const patch of patches) {
		const { origPath, newPath, hunks } = patch;

		// 新建文件
		if (origPath === '/dev/null') {
			const abs = path.isAbsolute(newPath) ? newPath : path.resolve(ctx.workspacePath, newPath);
			const content = hunks.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))).join('\n');
			plans.push({ abs, before: null, after: content, isCreate: true, isDelete: false });
			result.hunkApplied += hunks.length;
			continue;
		}

		// 删除文件
		if (newPath === '/dev/null') {
			const abs = path.isAbsolute(origPath) ? origPath : path.resolve(ctx.workspacePath, origPath);
			let before: string | null = null;
			try { before = fs.readFileSync(abs, 'utf8'); } catch { /* 可能已不存在 */ }
			plans.push({ abs, before, after: null, isCreate: false, isDelete: true });
			result.hunkApplied += hunks.length;
			continue;
		}

		// 修改文件
		const absOrig = path.isAbsolute(origPath) ? origPath : path.resolve(ctx.workspacePath, origPath);
		let origContent: string;
		try { origContent = fs.readFileSync(absOrig, 'utf8'); }
		catch (e) {
			result.success = false;
			result.hunkFailed += hunks.length;
			result.error = `无法读取 ${origPath}: ${(e as Error).message}`;
			return result;
		}

		let currentLines = origContent.split('\n');
		for (const hunk of hunks) {
			const r = applyHunk(currentLines, hunk);
			if ('error' in r) {
				result.success = false;
				result.hunkFailed++;
				result.error = `应用 hunk 到 ${origPath} 失败: ${r.error}`;
				return result;
			}
			currentLines = r.lines;
			result.hunkApplied++;
		}
		const absNew = path.isAbsolute(newPath) ? newPath : path.resolve(ctx.workspacePath, newPath);
		plans.push({ abs: absNew, before: origContent, after: currentLines.join('\n'), isCreate: false, isDelete: false });
		// 如果是重命名，旧路径也要删除
		if (absOrig !== absNew) {
			plans.push({ abs: absOrig, before: origContent, after: null, isCreate: false, isDelete: true });
		}
	}

	// 全部 dry run 通过 → 执行写入
	for (const p of plans) {
		try {
			if (p.isDelete) {
				if (fs.existsSync(p.abs)) fs.unlinkSync(p.abs);
				result.filesDeleted.push(p.abs);
			} else {
				fs.mkdirSync(path.dirname(p.abs), { recursive: true });
				fs.writeFileSync(p.abs, p.after ?? '', 'utf8');
				if (p.isCreate) result.filesCreated.push(p.abs);
				else result.filesChanged.push(p.abs);
			}
			result.changes!.push({ path: p.abs, before: p.before, after: p.after });
			ctx.fileContextTracker.trackFileWrite(p.abs);
			ctx.didEditFile = true;
		} catch (e) {
			result.success = false;
			result.error = `写入失败 ${p.abs}: ${(e as Error).message}`;
			// 不回滚（已写入的保留；调用方依赖 session snapshot 回退）
			return result;
		}
	}

	return result;
}

export function formatApplyPatchResult(r: IApplyPatchResult): string {
	if (!r.success) return `Patch 失败: ${r.error ?? '未知错误'}（成功 ${r.hunkApplied} 个 hunk，失败 ${r.hunkFailed} 个）`;
	const parts: string[] = ['# apply_patch 成功'];
	parts.push(`${r.hunkApplied} 个 hunk 应用`);
	if (r.filesCreated.length) parts.push(`新建 ${r.filesCreated.length} 文件: ${r.filesCreated.join(', ')}`);
	if (r.filesChanged.length) parts.push(`修改 ${r.filesChanged.length} 文件: ${r.filesChanged.join(', ')}`);
	if (r.filesDeleted.length) parts.push(`删除 ${r.filesDeleted.length} 文件: ${r.filesDeleted.join(', ')}`);
	return parts.join('\n');
}
