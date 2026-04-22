/*---------------------------------------------------------------------------------------------
 *  Maxian Server — SQLite Database Layer
 *
 *  使用 better-sqlite3（同步 API）替代 JSON 文件持久化。
 *  数据库位置：~/.maxian/maxian.db
 *  表结构：
 *    workspaces       — 工作区列表
 *    sessions         — 会话元数据
 *    messages         — 会话 UI 消息（用户+助手完整内容）
 *    history_entries  — API 对话历史条目（MessageParam，按 position 有序）
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export const DB_DIR  = path.join(os.homedir(), '.maxian');
export const DB_PATH = path.join(DB_DIR, 'maxian.db');

/**
 * 运行时检测：Bun 环境（由 bun --compile 产出的单文件二进制）用 `bun:sqlite`
 * 原因：better-sqlite3 的 `bindings` 模块在 Bun 虚拟 FS 里找不到 package.json 报错。
 * Bun 运行时把 sqlite 内置编译进二进制，零外部依赖。
 *
 * Node 环境（yarn tauri dev / 正常 node 运行）仍用 better-sqlite3（有完整的 Node N-API
 * prebuild），开发体验不变。
 *
 * 两者 API 表面 99% 相同，仅 `.pragma()` 需薄薄一层适配。
 */
const IS_BUN = typeof (globalThis as any).Bun !== 'undefined';

/** 用 Function 构造器绕过 bundler 静态分析（同 pty 的套路） */
async function loadDatabaseClass(): Promise<new (file: string) => Database.Database> {
	if (IS_BUN) {
		const modName = 'bun' + ':' + 'sqlite';   // 拆字符串防扫描
		const dyn = new Function('m', 'return import(m)');
		const mod = await dyn(modName);
		// bun:sqlite 的 Database 缺少 .pragma() —— 打补丁
		const BunDb = mod.Database;
		const proto = BunDb.prototype;
		if (!proto.pragma) {
			proto.pragma = function(pragma: string, opts?: { simple?: boolean }) {
				// better-sqlite3 行为：返回 object[] 或 (simple=true) 的标量
				const sql = 'PRAGMA ' + pragma;
				const rows = this.query(sql).all() as any[];
				if (opts?.simple) {
					const first = rows[0];
					if (!first) return undefined;
					return first[Object.keys(first)[0]];
				}
				return rows;
			};
		}
		return BunDb;
	}
	// Node 环境：直接 import better-sqlite3
	const mod = await import('better-sqlite3');
	return mod.default as any;
}

let _db: Database.Database | null = null;
let _DatabaseCtor: (new (file: string) => Database.Database) | null = null;

/** 获取单例数据库连接（首次调用时初始化 schema） */
export function getDb(): Database.Database {
	if (!_db) {
		if (!_DatabaseCtor) {
			throw new Error('Database 尚未初始化。请先在入口处 await initDb() 完成异步加载');
		}
		fs.mkdirSync(DB_DIR, { recursive: true });
		_db = new _DatabaseCtor(DB_PATH);
		// WAL 模式：读写不互锁，并发性能更好
		_db.pragma('journal_mode = WAL');
		// 外键约束开启
		_db.pragma('foreign_keys = ON');
		initSchema(_db);
		console.log(`[Database] SQLite opened at ${DB_PATH} (${IS_BUN ? 'bun:sqlite' : 'better-sqlite3'})`);
	}
	return _db;
}

/** 初始化数据库驱动（必须在 getDb() 之前调用一次） */
export async function initDb(): Promise<void> {
	if (_DatabaseCtor) return;
	_DatabaseCtor = await loadDatabaseClass();
}

/** 初始化表结构（idempotent，可反复调用） */
function initSchema(db: Database.Database): void {
	db.exec(`
		-- ── 工作区 ──────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS workspaces (
			id         TEXT    PRIMARY KEY,
			path       TEXT    UNIQUE NOT NULL,
			name       TEXT    NOT NULL,
			opened_at  INTEGER NOT NULL
		);

		-- ── 会话元数据 ────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS sessions (
			id            TEXT    PRIMARY KEY,
			title         TEXT    NOT NULL,
			status        TEXT    NOT NULL DEFAULT 'idle',
			created_at    INTEGER NOT NULL,
			updated_at    INTEGER NOT NULL,
			message_count INTEGER NOT NULL DEFAULT 0,
			input_tokens  INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			workspace_path TEXT   NOT NULL,
			mode          TEXT    NOT NULL DEFAULT 'code',
			ui_mode       TEXT    NOT NULL DEFAULT 'code'
		);

		-- ── UI 消息 ───────────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS messages (
			id         TEXT    PRIMARY KEY,
			session_id TEXT    NOT NULL,
			role       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);

		-- ── API 历史条目 ──────────────────────────────────────────
		CREATE TABLE IF NOT EXISTS history_entries (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT    NOT NULL,
			role       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			position   INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);

		-- ── 文件快照（撤销用） ───────────────────────────────────────
		CREATE TABLE IF NOT EXISTS file_snapshots (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT    NOT NULL,
			path       TEXT    NOT NULL,
			content    TEXT    NOT NULL,
			created_at INTEGER NOT NULL
		);

		-- ── 索引 ──────────────────────────────────────────────────
		CREATE INDEX IF NOT EXISTS idx_messages_session
			ON messages(session_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_history_session
			ON history_entries(session_id, position);
		CREATE INDEX IF NOT EXISTS idx_sessions_updated
			ON sessions(updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_snapshots_session_path
			ON file_snapshots(session_id, path, created_at DESC);
	`);

	// ── 数据库迁移：补充新增列（对已存在的旧数据库） ─────────────────────────
	const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map(r => r.name);
	if (!cols.includes('ui_mode')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'code'`);
		console.log('[Database] 迁移完成：sessions 表新增 ui_mode 列');
	}
	if (!cols.includes('archived')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
		console.log('[Database] 迁移完成：sessions 表新增 archived 列');
	}
	if (!cols.includes('pinned')) {
		db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
		console.log('[Database] 迁移完成：sessions 表新增 pinned 列');
	}
}
