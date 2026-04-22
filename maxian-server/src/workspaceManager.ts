/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Workspace Manager (SQLite-backed)
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { WorkspaceInfo } from './types.js';
import { getDb } from './database.js';

type WsRecord = WorkspaceInfo & { id: string };

/** 数据库行类型 */
interface WsRow {
	id:        string;
	path:      string;
	name:      string;
	opened_at: number;
}

function rowToRecord(row: WsRow): WsRecord {
	return { id: row.id, path: row.path, name: row.name, openedAt: row.opened_at };
}

export class WorkspaceManager {
	// ─── 初始化 ─────────────────────────────────────────────────────────────

	/**
	 * 从数据库加载工作区列表。
	 * 返回的对象每次操作都直接查询 SQLite，无内存缓存。
	 */
	static async load(): Promise<WorkspaceManager> {
		const mgr = new WorkspaceManager();
		// 触发 DB 初始化（schema 创建）
		const db = getDb();
		const count = (db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number }).c;
		console.log(`[Database] 已加载 ${count} 个工作区`);
		return mgr;
	}

	// ─── 查询 ────────────────────────────────────────────────────────────────

	list(): WsRecord[] {
		const db = getDb();
		const rows = db.prepare('SELECT * FROM workspaces ORDER BY opened_at DESC').all() as WsRow[];
		return rows.map(rowToRecord);
	}

	get(id: string): WsRecord | null {
		const db = getDb();
		const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WsRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	// ─── 增删改 ──────────────────────────────────────────────────────────────

	async add(absolutePath: string): Promise<WsRecord> {
		const resolved = path.resolve(absolutePath);
		const stat = await fs.stat(resolved);
		if (!stat.isDirectory()) {
			throw new Error(`${resolved} is not a directory`);
		}

		const db = getDb();
		// 去重：路径已存在则直接返回
		const existing = db.prepare('SELECT * FROM workspaces WHERE path = ?').get(resolved) as WsRow | undefined;
		if (existing) return rowToRecord(existing);

		const id = randomUUID();
		const name = path.basename(resolved);
		const openedAt = Date.now();

		db.prepare(
			'INSERT INTO workspaces (id, path, name, opened_at) VALUES (?, ?, ?, ?)'
		).run(id, resolved, name, openedAt);

		return { id, path: resolved, name, openedAt };
	}

	rename(id: string, name: string): WsRecord {
		const db = getDb();
		const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WsRow | undefined;
		if (!row) throw new Error(`Workspace ${id} not found`);
		const trimmed = name.trim();
		if (!trimmed) throw new Error('工作区名称不能为空');

		db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(trimmed, id);
		return rowToRecord({ ...row, name: trimmed });
	}

	async remove(id: string): Promise<void> {
		const db = getDb();
		db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
	}

	/**
	 * 列出工作区下的文件（相对路径，深度限 8 层）。
	 * 若提供非空 query，则仅返回文件名或路径包含 query（大小写不敏感）的文件。
	 */
	async listFiles(id: string, query: string = ''): Promise<string[]> {
		const ws = this.get(id);
		if (!ws) throw new Error(`Workspace ${id} not found`);
		const results: string[] = [];
		await this.walkDir(ws.path, ws.path, results, 0, 8);

		if (!query || query === '*' || query === '**/*') return results;

		// 过滤：文件名或相对路径含 query（忽略大小写）
		const q = query.toLowerCase().replace(/^\*|\*$/g, ''); // 去掉 glob 通配符
		if (!q) return results;
		return results.filter(f => f.toLowerCase().includes(q));
	}

	private static readonly IGNORED_DIRS = new Set([
		'node_modules', 'dist', 'build', 'out', 'target', '.git',
		'.svn', '__pycache__', '.pytest_cache', '.mypy_cache',
		'vendor', 'Pods', '.gradle', '.idea', '.vscode',
		'coverage', '.nyc_output', '.turbo', '.next', '.nuxt',
	]);

	private async walkDir(
		root: string,
		current: string,
		out: string[],
		depth: number,
		maxDepth: number
	): Promise<void> {
		if (depth > maxDepth) return;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (WorkspaceManager.IGNORED_DIRS.has(entry.name)) continue;
			const full = path.join(current, entry.name);
			const rel = path.relative(root, full);
			if (entry.isDirectory()) {
				await this.walkDir(root, full, out, depth + 1, maxDepth);
			} else {
				out.push(rel);
			}
		}
	}
}
