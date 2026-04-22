/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Session Routes
 *
 *  对应 OpenCode 的 session routes：创建/删除/列出会话、发送消息、SSE 流式订阅
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from '../sessionManager.js';
import { getDb } from '../database.js';

export function SessionRoutes(sessionManager: SessionManager) {
	const app = new Hono();

	// 列出所有会话
	app.get('/sessions', (c) => {
		return c.json({
			sessions: sessionManager.listSessions(),
		});
	});

	// 创建新会话
	app.post(
		'/sessions',
		zValidator('json', z.object({
			title: z.string().optional(),
			workspacePath: z.string(),
			mode: z.enum(['code', 'ask', 'debug', 'architect', 'solo']).optional(),
			uiMode: z.enum(['code', 'chat']).optional(),
		})),
		async (c) => {
			const body = c.req.valid('json');
			const session = await sessionManager.createSession(body);
			return c.json(session, 201);
		}
	);

	// 获取指定会话
	app.get('/sessions/:id', (c) => {
		const id = c.req.param('id');
		const session = sessionManager.getSession(id);
		if (!session) {
			return c.json({ error: 'Session not found' }, 404);
		}
		return c.json(session);
	});

	// 重命名会话 / 更新模式
	app.patch(
		'/sessions/:id',
		zValidator('json', z.object({
			title: z.string().optional(),
			mode: z.enum(['code', 'ask', 'chat', 'plan', 'debug', 'architect', 'solo']).optional(),
		})),
		(c) => {
			const id = c.req.param('id');
			const body = c.req.valid('json');
			const db = getDb();
			if (body.title !== undefined) {
				db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
					.run(body.title, Date.now(), id);
			}
			if (body.mode !== undefined) {
				db.prepare('UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?')
					.run(body.mode, Date.now(), id);
			}
			const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
			return c.json(row ? {
				id: row.id, title: row.title, status: row.status,
				createdAt: row.created_at, updatedAt: row.updated_at,
				messageCount: row.message_count, inputTokens: row.input_tokens,
				outputTokens: row.output_tokens, workspacePath: row.workspace_path,
			} : { id });
		}
	);

	// 删除会话
	app.delete('/sessions/:id', async (c) => {
		const id = c.req.param('id');
		await sessionManager.deleteSession(id);
		return c.json({ ok: true });
	});

	// 发送消息到会话（非流式 —— 异步触发，通过 SSE 接收结果）
	app.post(
		'/sessions/:id/messages',
		zValidator('json', z.object({
			content: z.string(),
			images: z.array(z.string()).optional(),
		})),
		async (c) => {
			const id = c.req.param('id');
			const body = c.req.valid('json');
			const messageId = await sessionManager.sendMessage(id, body);
			return c.json({ messageId });
		}
	);

	// 获取会话历史消息（支持 ?limit=50&before=<timestamp> 分页）
	app.get('/sessions/:id/messages', async (c) => {
		const id = c.req.param('id');
		const limitStr = c.req.query('limit');
		const beforeStr = c.req.query('before');
		const limit  = limitStr  ? parseInt(limitStr,  10) : 50;
		const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
		const result = await sessionManager.loadMessages(id, { limit, before });
		return c.json(result);
	});

	// SSE 事件流：订阅会话的所有事件（流式响应、工具调用、完成等）
	app.get('/sessions/:id/events', (c) => {
		const id = c.req.param('id');
		return streamSSE(c, async (outgoing) => {
			let aborted = false;
			const unsubscribe = sessionManager.subscribe(id, async (event) => {
				if (aborted) return;
				try {
					await outgoing.writeSSE({
						event: event.type,
						data: JSON.stringify(event),
					});
				} catch { /* 连接已断开，让外层清理 */ }
			});

			// 心跳 keepalive：每 15s 发一个 SSE 注释行，防止中间层（代理/防火墙/OS）
			// 在长时间无事件（比如限流等待 30s）时把连接当 idle 断掉
			const hb = setInterval(async () => {
				if (aborted) return;
				try {
					// SSE 注释行（以 `:` 开头）对客户端不可见，但保持 TCP 流活跃
					await outgoing.writeSSE({
						event: 'heartbeat',
						data: JSON.stringify({ ts: Date.now() }),
					});
				} catch {
					aborted = true;
				}
			}, 15000);

			// 保持连接直到客户端断开
			await new Promise<void>((resolve) => {
				outgoing.onAbort(() => {
					aborted = true;
					clearInterval(hb);
					unsubscribe();
					resolve();
				});
			});
		});
	});

	// 取消会话正在执行的任务
	app.post('/sessions/:id/cancel', async (c) => {
		const id = c.req.param('id');
		await sessionManager.cancelTask(id);
		return c.json({ ok: true });
	});

	// 批准/拒绝工具调用
	app.post(
		'/sessions/:id/approve',
		zValidator('json', z.object({
			toolUseId: z.string(),
			approved: z.boolean(),
			feedback: z.string().optional(),
		})),
		async (c) => {
			const id = c.req.param('id');
			const body = c.req.valid('json');
			await sessionManager.approveToolCall(id, body);
			return c.json({ ok: true });
		}
	);

	// 获取会话的文件变更列表（快照记录）
	app.get('/sessions/:id/changed-files', (c) => {
		const id = c.req.param('id');
		try {
			const db = getDb();
			const rows = db.prepare(
				`SELECT DISTINCT path FROM file_snapshots WHERE session_id = ? ORDER BY created_at ASC`
			).all(id) as Array<{ path: string }>;
			return c.json({ files: rows.map(r => r.path) });
		} catch (e) {
			return c.json({ files: [] });
		}
	});

	// 恢复文件到最新快照
	app.post(
		'/sessions/:id/revert',
		zValidator('json', z.object({ path: z.string() })),
		async (c) => {
			const id = c.req.param('id');
			const { path: filePathRaw } = c.req.valid('json');
			try {
				const wsPath = sessionManager.getWorkspacePath(id);
				const absolutePath = path.isAbsolute(filePathRaw)
					? path.normalize(filePathRaw)
					: (wsPath ? path.resolve(wsPath, filePathRaw) : path.resolve(filePathRaw));

				const db = getDb();
				// 兼容绝对 + 原样两种 key
				let row = db.prepare(
					`SELECT content FROM file_snapshots WHERE session_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1`
				).get(id, absolutePath) as { content: string } | undefined;
				let hitPath = absolutePath;
				if (!row && absolutePath !== filePathRaw) {
					row = db.prepare(
						`SELECT content FROM file_snapshots WHERE session_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1`
					).get(id, filePathRaw) as { content: string } | undefined;
					if (row) hitPath = filePathRaw;
				}

				if (!row) {
					return c.json({ ok: false, error: '没有找到该文件的快照' }, 404);
				}

				fs.writeFileSync(absolutePath, row.content, 'utf8');
				// 删除命中的那条快照
				db.prepare(
					`DELETE FROM file_snapshots WHERE session_id = ? AND path = ? AND created_at = (
						SELECT MAX(created_at) FROM file_snapshots WHERE session_id = ? AND path = ?
					)`
				).run(id, hitPath, id, hitPath);

				return c.json({ ok: true });
			} catch (e) {
				return c.json({ ok: false, error: (e as Error).message }, 500);
			}
		}
	);

	// 获取文件变更的 diff（原始快照 vs 当前内容）
	app.get('/sessions/:id/file-diff', (c) => {
		const id = c.req.param('id');
		const filePathRaw = c.req.query('path');
		if (!filePathRaw) return c.json({ error: 'path required' }, 400);
		try {
			// 解析为绝对路径：file_snapshots 存的是绝对路径，相对路径要用 session 工作区拼
			const wsPath = sessionManager.getWorkspacePath(id);
			const absolutePath = path.isAbsolute(filePathRaw)
				? path.normalize(filePathRaw)
				: (wsPath ? path.resolve(wsPath, filePathRaw) : path.resolve(filePathRaw));

			const db = getDb();
			// 同时尝试绝对和传入的原样两种匹配，兼容旧数据
			let row = db.prepare(
				`SELECT content FROM file_snapshots WHERE session_id = ? AND path = ? ORDER BY created_at ASC LIMIT 1`
			).get(id, absolutePath) as { content: string } | undefined;
			if (!row && absolutePath !== filePathRaw) {
				row = db.prepare(
					`SELECT content FROM file_snapshots WHERE session_id = ? AND path = ? ORDER BY created_at ASC LIMIT 1`
				).get(id, filePathRaw) as { content: string } | undefined;
			}

			let current = '';
			try { current = fs.readFileSync(absolutePath, 'utf8'); } catch { /* 文件已被删除 */ }

			return c.json({ original: row?.content ?? null, current });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// 手动触发压缩（/compact 命令）
	app.post('/sessions/:id/compact', async (c) => {
		const id = c.req.param('id');
		try {
			// 通过全局入口调用（cli.ts 注册）
			const fn = (globalThis as any).__maxianForceCompact as
				(sessionId: string) => Promise<any>;
			if (!fn) return c.json({ ok: false, error: 'compact not available' }, 500);
			const report = await fn(id);
			return c.json({ ok: true, ...report });
		} catch (e) {
			return c.json({ ok: false, error: (e as Error).message }, 500);
		}
	});

	// 回答 question 工具的提问
	app.post(
		'/sessions/:id/answer-question',
		zValidator('json', z.object({
			answer:    z.string().optional(),
			selected:  z.array(z.string()).optional(),
			cancelled: z.boolean().optional(),
		})),
		async (c) => {
			const id = c.req.param('id');
			const body = c.req.valid('json');
			await sessionManager.answerQuestion(id, {
				answer:    body.answer ?? '',
				selected:  body.selected,
				cancelled: body.cancelled ?? false,
			});
			return c.json({ ok: true });
		}
	);

	// 响应 plan_exit 工具
	app.post(
		'/sessions/:id/plan-exit',
		zValidator('json', z.object({
			approved: z.boolean(),
			feedback: z.string().optional(),
		})),
		async (c) => {
			const id = c.req.param('id');
			const body = c.req.valid('json');
			await sessionManager.respondPlanExit(id, {
				approved: body.approved,
				feedback: body.feedback,
			});
			return c.json({ ok: true });
		}
	);

	// 归档 / 取消归档
	app.post(
		'/sessions/:id/archive',
		zValidator('json', z.object({ archived: z.boolean() })),
		async (c) => {
			const id = c.req.param('id');
			const { archived } = c.req.valid('json');
			const s = sessionManager.setSessionArchived(id, archived);
			return c.json({ ok: !!s, session: s });
		}
	);

	// 置顶 / 取消置顶
	app.post(
		'/sessions/:id/pin',
		zValidator('json', z.object({ pinned: z.boolean() })),
		async (c) => {
			const id = c.req.param('id');
			const { pinned } = c.req.valid('json');
			const s = sessionManager.setSessionPinned(id, pinned);
			return c.json({ ok: !!s, session: s });
		}
	);

	// 单条消息删除
	app.delete('/sessions/:id/messages/:messageId', async (c) => {
		const id = c.req.param('id');
		const messageId = c.req.param('messageId');
		const r = await sessionManager.deleteMessage(id, messageId);
		return c.json(r);
	});

	// 编辑用户消息
	app.patch(
		'/sessions/:id/messages/:messageId',
		zValidator('json', z.object({ content: z.string() })),
		async (c) => {
			const id = c.req.param('id');
			const messageId = c.req.param('messageId');
			const { content } = c.req.valid('json');
			try {
				const r = await sessionManager.editUserMessage(id, messageId, content);
				return c.json(r);
			} catch (e) {
				return c.json({ ok: false, error: (e as Error).message }, 400);
			}
		}
	);

	// 从消息重新生成（删除该消息之后所有，返回最后一条 user 消息 id 给前端触发重发）
	app.post('/sessions/:id/messages/:messageId/regenerate', async (c) => {
		const id = c.req.param('id');
		const messageId = c.req.param('messageId');
		const r = await sessionManager.regenerateFromMessage(id, messageId);
		return c.json(r);
	});

	// 从消息 fork 新会话
	app.post('/sessions/:id/messages/:messageId/fork', async (c) => {
		const id = c.req.param('id');
		const messageId = c.req.param('messageId');
		const r = await sessionManager.forkFromMessage(id, messageId);
		return c.json(r);
	});

	// 回退到指定消息（删除该消息及其后所有消息，同步截断 API 历史）
	app.post(
		'/sessions/:id/revert-to',
		zValidator('json', z.object({ messageId: z.string() })),
		async (c) => {
			const id = c.req.param('id');
			const { messageId } = c.req.valid('json');
			try {
				const result = await sessionManager.revertToMessage(id, messageId);
				return c.json({ ok: true, ...result });
			} catch (e) {
				return c.json({ ok: false, error: (e as Error).message }, 500);
			}
		}
	);

	// 分叉会话（复制消息历史到新会话）
	app.post('/sessions/:id/fork', async (c) => {
		const id = c.req.param('id');
		try {
			const sessions = sessionManager.listSessions();
			const original = sessions.find(s => s.id === id);
			if (!original) return c.json({ ok: false, error: 'Session not found' }, 404);

			const history = await sessionManager.loadHistory(id);
			const newSession = await sessionManager.createSession({
				title: `${original.title} (分叉)`,
				workspacePath: original.workspacePath ?? process.cwd(),
				mode: (original as any).mode ?? 'code',
			});

			if (history.length > 0) {
				await sessionManager.saveHistory(newSession.id, history as any);
			}

			return c.json({ ok: true, session: newSession });
		} catch (e) {
			return c.json({ ok: false, error: (e as Error).message }, 500);
		}
	});

	return app;
}
