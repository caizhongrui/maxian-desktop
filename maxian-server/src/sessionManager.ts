/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Session Manager (SQLite-backed)
 *
 *  所有元数据、UI 消息、API 历史均持久化到 SQLite (better-sqlite3，同步 API)。
 *  SSE 订阅 / 任务状态等运行时状态仍保留在内存中。
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import type { MaxianEvent } from '@maxian/core';
import type { SessionSummary } from './types.js';
import { getDb } from './database.js';

export interface CreateSessionOptions {
	title?: string;
	workspacePath: string;
	mode?: 'code' | 'ask' | 'debug' | 'architect' | 'solo';
	/** UI 侧边栏模式：'code' = 代码模式，'chat' = 对话模式 */
	uiMode?: 'code' | 'chat';
}

export interface SendMessageOptions {
	content: string;
	images?: string[];
}

export interface ApproveOptions {
	toolUseId: string;
	approved: boolean;
	feedback?: string;
}

/** 存储的 UI 消息格式 */
export interface StoredMessage {
	id: string;
	role: 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'reasoning';
	content: string;
	createdAt: number;
}

/** API 历史条目 — 存储层（content 可能是纯文本或 JSON 序列化的 ContentBlock[]） */
export interface HistoryEntry {
	role: string; // 'user' | 'assistant' | 'tool'
	content: string;
}

/** 完整 MessageParam（支持 ContentBlock[] content） */
export interface MessageParam {
	role: string;
	content: string | unknown[];
}

/** 数据库行类型 */
interface SessionRow {
	id:            string;
	title:         string;
	status:        string;
	created_at:    number;
	updated_at:    number;
	message_count: number;
	input_tokens:  number;
	output_tokens: number;
	workspace_path: string;
	mode:          string;
	ui_mode:       string;
	archived:      number;
	pinned:        number;
}

interface MessageRow {
	id:         string;
	session_id: string;
	role:       string;
	content:    string;
	created_at: number;
}

interface HistoryRow {
	session_id: string;
	role:       string;
	content:    string;
	position:   number;
}

function rowToSummary(row: SessionRow): SessionSummary {
	return {
		id:           row.id,
		title:        row.title,
		status:       row.status as SessionSummary['status'],
		createdAt:    row.created_at,
		updatedAt:    row.updated_at,
		messageCount: row.message_count,
		inputTokens:  row.input_tokens,
		outputTokens: row.output_tokens,
		workspacePath: row.workspace_path,
		uiMode:       (row.ui_mode ?? 'code') as 'code' | 'chat',
		archived:     !!(row.archived ?? 0),
		pinned:       !!(row.pinned ?? 0),
	};
}

/** 运行时状态（不持久化） */
interface SessionRuntime {
	subscribers:     Set<(event: MaxianEvent) => void | Promise<void>>;
	cancelled:       boolean;
	pendingApprovals: Map<string, {
		resolve: (approved: boolean, feedback?: string) => void;
	}>;
	/** 当前挂起的 question 请求（最多一个） */
	pendingQuestion?: {
		resolve: (answer: { answer: string; selected?: string[]; cancelled: boolean }) => void;
		reject:  (err: Error) => void;
	};
	/** 当前挂起的 plan_exit 请求（最多一个） */
	pendingPlanExit?: {
		resolve: (result: { approved: boolean; feedback?: string }) => void;
		reject:  (err: Error) => void;
	};
}

export class SessionManager {
	private runtimes = new Map<string, SessionRuntime>();

	// ─── 初始化 ─────────────────────────────────────────────────────────────

	/**
	 * 从数据库加载已有会话（重置 running → idle）。
	 * 运行时状态（subscribers / pending approvals）从空白开始。
	 */
	static async load(): Promise<SessionManager> {
		const mgr = new SessionManager();
		const db = getDb();

		// 重启时将所有 running 状态重置为 idle
		db.prepare("UPDATE sessions SET status = 'idle' WHERE status = 'running'").run();

		const count = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
		console.log(`[Database] 已加载 ${count} 个会话`);
		return mgr;
	}

	// ─── 运行时辅助 ─────────────────────────────────────────────────────────

	private ensureRuntime(id: string): SessionRuntime {
		if (!this.runtimes.has(id)) {
			this.runtimes.set(id, {
				subscribers: new Set(),
				cancelled: false,
				pendingApprovals: new Map(),
			});
		}
		return this.runtimes.get(id)!;
	}

	private getRuntime(id: string): SessionRuntime | undefined {
		return this.runtimes.get(id);
	}

	// ─── 查询 ────────────────────────────────────────────────────────────────

	listSessions(): SessionSummary[] {
		const db = getDb();
		// 置顶会话优先；其次按更新时间降序
		const rows = db.prepare(
			'SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC'
		).all() as SessionRow[];
		return rows.map(rowToSummary);
	}

	getSession(id: string): SessionSummary | null {
		const db = getDb();
		const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
		if (!row) return null;
		return rowToSummary(row);
	}

	// ─── 归档 / 置顶（P0-2） ────────────────────────────────────────────────

	setSessionArchived(id: string, archived: boolean): SessionSummary | null {
		const db = getDb();
		db.prepare('UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?')
			.run(archived ? 1 : 0, Date.now(), id);
		return this.getSession(id);
	}

	setSessionPinned(id: string, pinned: boolean): SessionSummary | null {
		const db = getDb();
		db.prepare('UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?')
			.run(pinned ? 1 : 0, Date.now(), id);
		return this.getSession(id);
	}

	getWorkspacePath(id: string): string | null {
		const db = getDb();
		const row = db.prepare('SELECT workspace_path FROM sessions WHERE id = ?').get(id) as Pick<SessionRow, 'workspace_path'> | undefined;
		return row?.workspace_path ?? null;
	}

	getMode(id: string): string {
		const db = getDb();
		const row = db.prepare('SELECT mode FROM sessions WHERE id = ?').get(id) as Pick<SessionRow, 'mode'> | undefined;
		return row?.mode ?? 'code';
	}

	// ─── 创建 / 重命名 / 删除 ────────────────────────────────────────────────

	async createSession(opts: CreateSessionOptions): Promise<SessionSummary> {
		const db = getDb();
		const id = randomUUID();
		const now = Date.now();
		const title = opts.title ?? '新会话';
		const mode = opts.mode ?? 'code';
		const uiMode = opts.uiMode ?? 'code';

		db.prepare(`
			INSERT INTO sessions
				(id, title, status, created_at, updated_at, message_count, input_tokens, output_tokens, workspace_path, mode, ui_mode)
			VALUES
				(?, ?, 'idle', ?, ?, 0, 0, 0, ?, ?, ?)
		`).run(id, title, now, now, opts.workspacePath, mode, uiMode);

		return {
			id,
			title,
			status: 'idle',
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			workspacePath: opts.workspacePath,
			uiMode,
		};
	}

	renameSession(id: string, title: string): SessionSummary {
		const db = getDb();
		const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
		if (!row) throw new Error(`Session ${id} not found`);
		const trimmed = title.trim();
		if (!trimmed) throw new Error('会话名称不能为空');

		const now = Date.now();
		db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id);
		return this.getSession(id)!;
	}

	async deleteSession(id: string): Promise<void> {
		const rt = this.getRuntime(id);
		if (rt) {
			for (const { resolve } of rt.pendingApprovals.values()) {
				resolve(false, 'Session deleted');
			}
			rt.pendingApprovals.clear();
			rt.subscribers.clear();
			this.runtimes.delete(id);
		}
		// FileTime 里的会话状态也清掉，避免内存泄漏
		try {
			const { FileTime } = await import('@maxian/core/file/FileTime');
			FileTime.clearSession(id);
		} catch { /* ignore */ }
		const db = getDb();
		// ON DELETE CASCADE 会自动删除 messages 和 history_entries
		db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
	}

	// ─── SSE 订阅 ─────────────────────────────────────────────────────────

	subscribe(id: string, handler: (event: MaxianEvent) => void | Promise<void>): () => void {
		const rt = this.ensureRuntime(id);
		rt.subscribers.add(handler);
		return () => { rt.subscribers.delete(handler); };
	}

	async emitEvent(id: string, event: MaxianEvent): Promise<void> {
		const rt = this.getRuntime(id);
		if (!rt) return;
		for (const handler of rt.subscribers) {
			try { await handler(event); } catch (err) {
				console.error('[SessionManager] subscriber error:', err);
			}
		}
	}

	// ─── 消息持久化 ──────────────────────────────────────────────────────────

	/** 追加一条 UI 消息 */
	async appendMessage(sessionId: string, msg: StoredMessage): Promise<void> {
		const db = getDb();
		db.prepare(
			'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
		).run(msg.id, sessionId, msg.role, msg.content, msg.createdAt);
	}

	/** 读取会话 UI 消息列表 */
	async loadMessages(
		sessionId: string,
		opts?: { limit?: number; before?: number }
	): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
		const db = getDb();
		const limit = opts?.limit ?? 50;
		const before = opts?.before;

		// 取最新 N+1 条（多取 1 条判断是否有更多）
		const sql = before
			? `SELECT id, role, content, created_at FROM messages
			   WHERE session_id = ? AND created_at < ?
			   ORDER BY created_at DESC LIMIT ?`
			: `SELECT id, role, content, created_at FROM messages
			   WHERE session_id = ?
			   ORDER BY created_at DESC LIMIT ?`;
		const params = before ? [sessionId, before, limit + 1] : [sessionId, limit + 1];
		const rows = db.prepare(sql).all(...params) as Array<{
			id: string; role: string; content: string; created_at: number
		}>;

		const hasMore = rows.length > limit;
		const slice = rows.slice(0, limit).reverse(); // 反转回时间正序
		return {
			messages: slice.map(r => ({
				id: r.id,
				role: r.role as StoredMessage['role'],
				content: r.content,
				createdAt: r.created_at,
			})),
			hasMore,
		};
	}

	/** 持久化助手回复（流结束后由 cli.ts 调用） */
	async appendAssistantMessage(sessionId: string, content: string): Promise<void> {
		await this.appendMessage(sessionId, {
			id: randomUUID(),
			role: 'assistant',
			content,
			createdAt: Date.now(),
		});
	}

	/**
	 * 持久化思考过程（Agent 模式的 reasoning）
	 * content 是最终聚合文本，供切换会话后还原显示
	 */
	async appendReasoningMessage(sessionId: string, content: string): Promise<void> {
		if (!content || content.length === 0) return;
		await this.appendMessage(sessionId, {
			id: randomUUID(),
			role: 'reasoning',
			content,
			createdAt: Date.now(),
		});
	}

	/**
	 * 持久化工具调用（含参数 + 结果）
	 * content 是 JSON 字符串 { toolName, toolUseId, toolParams, toolResult, toolSuccess }
	 */
	async appendToolMessage(sessionId: string, opts: {
		id?:          string;
		toolName:     string;
		toolUseId:    string;
		toolParams?:  Record<string, unknown>;
		toolResult?:  string;
		toolSuccess?: boolean;
	}): Promise<void> {
		await this.appendMessage(sessionId, {
			id:        opts.id ?? randomUUID(),
			role:      'tool',
			content:   JSON.stringify({
				toolName:    opts.toolName,
				toolUseId:   opts.toolUseId,
				toolParams:  opts.toolParams ?? {},
				toolResult:  opts.toolResult ?? '',
				toolSuccess: opts.toolSuccess ?? true,
			}),
			createdAt: Date.now(),
		});
	}

	/** 删除单条消息（不连带删除后续）*/
	async deleteMessage(sessionId: string, messageId: string): Promise<{ deleted: boolean }> {
		const db = getDb();
		const info = db.prepare(
			'DELETE FROM messages WHERE session_id = ? AND id = ?'
		).run(sessionId, messageId);
		// 同步重建 API 历史
		await this._rebuildApiHistoryFromUi(sessionId);
		return { deleted: info.changes > 0 };
	}

	/** 编辑用户消息并删除其后所有消息（将触发重跑 AI）*/
	async editUserMessage(
		sessionId: string,
		messageId: string,
		newContent: string,
	): Promise<{ ok: boolean; deletedAfter: number }> {
		const db = getDb();
		const row = db.prepare(
			'SELECT created_at, role FROM messages WHERE session_id = ? AND id = ?'
		).get(sessionId, messageId) as { created_at: number; role: string } | undefined;
		if (!row) return { ok: false, deletedAfter: 0 };
		if (row.role !== 'user') throw new Error('只能编辑用户消息');

		// 更新内容
		db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(newContent, messageId);
		// 删除该消息之后的所有消息
		const before = db.prepare(
			'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ? AND created_at > ?'
		).get(sessionId, row.created_at) as { cnt: number };
		db.prepare(
			'DELETE FROM messages WHERE session_id = ? AND created_at > ?'
		).run(sessionId, row.created_at);

		await this._rebuildApiHistoryFromUi(sessionId);
		return { ok: true, deletedAfter: before.cnt };
	}

	/**
	 * 重生成：从指定消息往后全部删除（保留该消息本身若是 user，
	 * 否则连带往前找到最近一条 user 保留再删后面的）
	 */
	async regenerateFromMessage(
		sessionId: string,
		messageId: string,
	): Promise<{ ok: boolean; kept: number; deleted: number; promptUserId: string | null }> {
		const db = getDb();
		const target = db.prepare(
			'SELECT created_at, role FROM messages WHERE session_id = ? AND id = ?'
		).get(sessionId, messageId) as { created_at: number; role: string } | undefined;
		if (!target) return { ok: false, kept: 0, deleted: 0, promptUserId: null };

		// 决定截断点：target 若是 user → 保留并删后面；其他角色 → 找到前一条 user 保留
		let keepUntilTs: number;
		let promptUserId: string | null = null;
		if (target.role === 'user') {
			keepUntilTs = target.created_at;
			promptUserId = messageId;
		} else {
			const prevUser = db.prepare(
				`SELECT id, created_at FROM messages
				 WHERE session_id = ? AND role = 'user' AND created_at < ?
				 ORDER BY created_at DESC LIMIT 1`
			).get(sessionId, target.created_at) as { id: string; created_at: number } | undefined;
			if (!prevUser) return { ok: false, kept: 0, deleted: 0, promptUserId: null };
			keepUntilTs = prevUser.created_at;
			promptUserId = prevUser.id;
		}

		const before = db.prepare(
			'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?'
		).get(sessionId) as { cnt: number };
		db.prepare(
			'DELETE FROM messages WHERE session_id = ? AND created_at > ?'
		).run(sessionId, keepUntilTs);
		const after = db.prepare(
			'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?'
		).get(sessionId) as { cnt: number };

		await this._rebuildApiHistoryFromUi(sessionId);
		return { ok: true, kept: after.cnt, deleted: before.cnt - after.cnt, promptUserId };
	}

	/** 从指定消息 fork 出新会话（保留 >= 该消息位置之前的所有消息到新 session）*/
	async forkFromMessage(
		sessionId: string,
		messageId: string,
	): Promise<{ ok: boolean; newSessionId?: string }> {
		const original = this.getSession(sessionId);
		if (!original) return { ok: false };

		const db = getDb();
		const target = db.prepare(
			'SELECT created_at FROM messages WHERE session_id = ? AND id = ?'
		).get(sessionId, messageId) as { created_at: number } | undefined;
		if (!target) return { ok: false };

		// 新会话
		const newSession = await this.createSession({
			title:         `${original.title} (fork from msg)`,
			workspacePath: original.workspacePath ?? process.cwd(),
			mode:          (original as any).mode ?? 'code',
			uiMode:        original.uiMode,
		});

		// 复制 <= target 的消息
		const rows = db.prepare(
			`SELECT id, role, content, created_at FROM messages
			 WHERE session_id = ? AND created_at <= ?
			 ORDER BY created_at ASC`
		).all(sessionId, target.created_at) as Array<{ id: string; role: string; content: string; created_at: number }>;

		for (const r of rows) {
			db.prepare(
				'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
			).run(randomUUID(), newSession.id, r.role, r.content, r.created_at);
		}
		// 重建 API 历史
		await this._rebuildApiHistoryFromUi(newSession.id);

		return { ok: true, newSessionId: newSession.id };
	}

	/** 根据当前 UI messages 重建 API history（只保留 user/assistant 文本） */
	private async _rebuildApiHistoryFromUi(sessionId: string): Promise<void> {
		const db = getDb();
		const remaining = db.prepare(
			`SELECT role, content FROM messages WHERE session_id = ?
			 ORDER BY created_at ASC`
		).all(sessionId) as Array<{ role: string; content: string }>;

		const rebuiltHistory = remaining
			.filter(r => r.role === 'user' || r.role === 'assistant')
			.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }));
		await this.saveHistory(sessionId, rebuiltHistory as any);
	}

	/**
	 * 回退到指定消息：删除 createdAt >= targetTs 的所有 UI 消息，
	 * 并同步截断 API 历史（history.json）使其与 UI 一致。
	 * 返回删除的消息数量。
	 */
	async revertToMessage(sessionId: string, targetMsgId: string): Promise<{ deleted: number; newMsgCount: number }> {
		const db = getDb();
		// 先查目标消息 createdAt
		const target = db.prepare(
			'SELECT created_at FROM messages WHERE session_id = ? AND id = ?'
		).get(sessionId, targetMsgId) as { created_at: number } | undefined;
		if (!target) return { deleted: 0, newMsgCount: 0 };

		// 删除该消息及其后所有消息
		const before = db.prepare(
			'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?'
		).get(sessionId) as { cnt: number };

		db.prepare(
			'DELETE FROM messages WHERE session_id = ? AND created_at >= ?'
		).run(sessionId, target.created_at);

		const after = db.prepare(
			'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?'
		).get(sessionId) as { cnt: number };

		// 同时截断 API 历史：粗略按用户消息对应重建
		// 取保留的 UI 消息重建一个 user/assistant 对话历史
		const remaining = db.prepare(
			`SELECT role, content FROM messages WHERE session_id = ?
			 ORDER BY created_at ASC`
		).all(sessionId) as Array<{ role: string; content: string }>;

		const rebuiltHistory = remaining
			.filter(r => r.role === 'user' || r.role === 'assistant')
			.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }));

		await this.saveHistory(sessionId, rebuiltHistory as any);

		return { deleted: before.cnt - after.cnt, newMsgCount: after.cnt };
	}

	// ─── API 历史 ─────────────────────────────────────────────────────────

	/** 保存 API 对话历史（整体替换）。
	 *  支持完整 MessageParam 格式：content 可以是纯文本或 ContentBlock[]（序列化为 JSON）。
	 */
	async saveHistory(sessionId: string, history: MessageParam[]): Promise<void> {
		const db = getDb();
		const txn = db.transaction(() => {
			db.prepare('DELETE FROM history_entries WHERE session_id = ?').run(sessionId);
			const insert = db.prepare(
				'INSERT INTO history_entries (session_id, role, content, position) VALUES (?, ?, ?, ?)'
			);
			for (let i = 0; i < history.length; i++) {
				const entry = history[i];
				// content 如果是数组（ContentBlock[]）则序列化为 JSON
				const contentStr = typeof entry.content === 'string'
					? entry.content
					: JSON.stringify(entry.content);
				insert.run(sessionId, entry.role, contentStr, i);
			}
		});
		txn();
	}

	/** 加载 API 对话历史，返回完整 MessageParam 格式。
	 *  会尝试将 content 反序列化为 ContentBlock[]（若存储时是数组）。
	 */
	async loadHistory(sessionId: string): Promise<MessageParam[]> {
		const db = getDb();
		const rows = db.prepare(
			'SELECT role, content FROM history_entries WHERE session_id = ? ORDER BY position ASC'
		).all(sessionId) as Array<{ role: string; content: string }>;
		return rows.map(r => {
			let content: string | unknown[];
			try {
				const parsed = JSON.parse(r.content);
				content = Array.isArray(parsed) ? parsed : r.content;
			} catch {
				content = r.content;
			}
			return { role: r.role, content };
		});
	}

	// ─── 消息发送 ────────────────────────────────────────────────────────────

	async sendMessage(id: string, opts: SendMessageOptions): Promise<string> {
		const db = getDb();
		const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
		if (!row) throw new Error(`Session ${id} not found`);

		const rt = this.ensureRuntime(id);
		rt.cancelled = false;

		const messageId = randomUUID();
		const now = Date.now();

		// 更新会话状态
		db.prepare(`
			UPDATE sessions
			SET status = 'running', updated_at = ?, message_count = message_count + 1
			WHERE id = ?
		`).run(now, id);

		// 持久化用户消息
		db.prepare(
			'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
		).run(messageId, id, 'user', opts.content, now);

		// 触发处理器
		for (const handler of this.onSendMessageHandlers) {
			try { await handler(id, messageId, opts); } catch (err) {
				console.error('[SessionManager] sendMessage handler error:', err);
			}
		}

		return messageId;
	}

	// ─── 取消 / 批准 ──────────────────────────────────────────────────────

	async cancelTask(id: string): Promise<void> {
		const rt = this.getRuntime(id);
		if (rt) {
			rt.cancelled = true;
		}
		// 唤醒挂起的 question / plan_exit（否则 agent loop 会一直 await 这些 Promise）
		if (rt?.pendingQuestion) {
			try { rt.pendingQuestion.resolve({ answer: '', cancelled: true }); } catch {}
			rt.pendingQuestion = undefined;
		}
		if (rt?.pendingPlanExit) {
			try { rt.pendingPlanExit.resolve({ approved: false, feedback: '任务被取消' }); } catch {}
			rt.pendingPlanExit = undefined;
		}
		// 唤醒所有挂起的 approval（被拒绝处理）
		if (rt) {
			for (const [, pend] of rt.pendingApprovals) {
				try { pend.resolve(false, '任务已取消'); } catch {}
			}
			rt.pendingApprovals.clear();
		}
		const db = getDb();
		db.prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?").run(Date.now(), id);

		for (const handler of this.onCancelHandlers) {
			try { await handler(id); } catch (err) {
				console.error('[SessionManager] cancel handler error:', err);
			}
		}
	}

	/** Agent loop 在关键节点调用，轮询检查是否被取消 */
	isCancelled(id: string): boolean {
		return this.getRuntime(id)?.cancelled === true;
	}

	/** Agent loop 在开始新任务时清掉上次的 cancelled 标记 */
	resetCancelled(id: string): void {
		const rt = this.getRuntime(id);
		if (rt) rt.cancelled = false;
	}

	async approveToolCall(id: string, opts: ApproveOptions): Promise<void> {
		const rt = this.getRuntime(id);
		if (!rt) return;
		const pending = rt.pendingApprovals.get(opts.toolUseId);
		if (!pending) {
			console.warn(`[SessionManager] No pending approval for ${opts.toolUseId}`);
			return;
		}
		pending.resolve(opts.approved, opts.feedback);
		rt.pendingApprovals.delete(opts.toolUseId);
	}

	async registerApproval(id: string, toolUseId: string): Promise<{ approved: boolean; feedback?: string }> {
		const rt = this.ensureRuntime(id);
		return new Promise((resolve) => {
			rt.pendingApprovals.set(toolUseId, {
				resolve: (approved, feedback) => resolve({ approved, feedback }),
			});
		});
	}

	// ─── Question 工具支持 ───────────────────────────────────────────────────

	/**
	 * Agent 调用 question 工具后挂起等待用户回答。
	 * 超时后抛出错误（agent loop 会把错误消息回传给 LLM）。
	 */
	async waitForQuestionAnswer(
		id:        string,
		timeoutMs: number,
	): Promise<{ answer: string; selected?: string[]; cancelled: boolean }> {
		const rt = this.ensureRuntime(id);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (rt.pendingQuestion) { rt.pendingQuestion = undefined; }
				reject(new Error('question 等待超时'));
			}, timeoutMs);
			rt.pendingQuestion = {
				resolve: (a) => { clearTimeout(timer); resolve(a); },
				reject:  (e) => { clearTimeout(timer); reject(e); },
			};
		});
	}

	/** 前端回答 question 时调用 */
	async answerQuestion(
		id:     string,
		answer: { answer: string; selected?: string[]; cancelled: boolean },
	): Promise<void> {
		const rt = this.getRuntime(id);
		if (!rt?.pendingQuestion) return;
		rt.pendingQuestion.resolve(answer);
		rt.pendingQuestion = undefined;
	}

	// ─── Plan Exit 工具支持 ─────────────────────────────────────────────────

	async waitForPlanExit(
		id:        string,
		timeoutMs: number,
	): Promise<{ approved: boolean; feedback?: string }> {
		const rt = this.ensureRuntime(id);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (rt.pendingPlanExit) { rt.pendingPlanExit = undefined; }
				reject(new Error('plan_exit 等待超时'));
			}, timeoutMs);
			rt.pendingPlanExit = {
				resolve: (r) => { clearTimeout(timer); resolve(r); },
				reject:  (e) => { clearTimeout(timer); reject(e); },
			};
		});
	}

	async respondPlanExit(
		id:     string,
		result: { approved: boolean; feedback?: string },
	): Promise<void> {
		const rt = this.getRuntime(id);
		if (!rt?.pendingPlanExit) return;
		rt.pendingPlanExit.resolve(result);
		rt.pendingPlanExit = undefined;
	}

	// ─── 统计更新 ────────────────────────────────────────────────────────────

	updateStats(id: string, stats: Partial<Pick<SessionSummary, 'inputTokens' | 'outputTokens' | 'status' | 'messageCount'>>): void {
		const db = getDb();
		const parts: string[] = ['updated_at = ?'];
		const values: unknown[] = [Date.now()];

		if (stats.status    !== undefined) { parts.push('status = ?');        values.push(stats.status); }
		if (stats.inputTokens  !== undefined) { parts.push('input_tokens = ?');  values.push(stats.inputTokens); }
		if (stats.outputTokens !== undefined) { parts.push('output_tokens = ?'); values.push(stats.outputTokens); }
		if (stats.messageCount !== undefined) { parts.push('message_count = ?'); values.push(stats.messageCount); }

		values.push(id);
		db.prepare(`UPDATE sessions SET ${parts.join(', ')} WHERE id = ?`).run(...values);
	}

	// ─── 外部处理器注册 ───────────────────────────────────────────────────────

	private onSendMessageHandlers = new Set<(
		sessionId: string,
		messageId: string,
		opts: SendMessageOptions,
	) => void | Promise<void>>();
	private onCancelHandlers = new Set<(sessionId: string) => void | Promise<void>>();

	onSendMessage(handler: (
		sessionId: string,
		messageId: string,
		opts: SendMessageOptions,
	) => void | Promise<void>): () => void {
		this.onSendMessageHandlers.add(handler);
		return () => this.onSendMessageHandlers.delete(handler);
	}

	onCancel(handler: (sessionId: string) => void | Promise<void>): () => void {
		this.onCancelHandlers.add(handler);
		return () => this.onCancelHandlers.delete(handler);
	}
}
