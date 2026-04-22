/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Auth Routes
 *
 *  POST /auth/configure  — 动态配置 AI 代理凭据（登录后由客户端调用）
 *  DELETE /auth/configure — 清除 AI 代理凭据（登出）
 *  GET /auth/status      — 查询当前 AI 配置状态
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';

export interface AiRuntimeConfig {
	apiUrl: string;
	/** base64 编码的用户名 */
	username: string;
	/** base64 编码的密码 */
	password: string;
}

export type SetAiConfigFn = (cfg: AiRuntimeConfig | null) => void;

export function AuthRoutes(setAiConfig: SetAiConfigFn, getAiConfig: () => AiRuntimeConfig | null) {
	const app = new Hono();

	/** 配置 AI 代理 */
	app.post('/auth/configure', async (c) => {
		let body: Record<string, string>;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}
		const { apiUrl, username, password } = body;
		if (!apiUrl || !username || !password) {
			return c.json({ error: 'Missing required fields: apiUrl, username, password' }, 400);
		}
		setAiConfig({ apiUrl, username, password });
		console.log('[Maxian Server] AI 代理已配置:', apiUrl);
		return c.json({ ok: true });
	});

	/** 清除 AI 代理配置（登出） */
	app.delete('/auth/configure', (c) => {
		setAiConfig(null);
		console.log('[Maxian Server] AI 代理配置已清除');
		return c.json({ ok: true });
	});

	/** 查询当前 AI 配置状态 */
	app.get('/auth/status', (c) => {
		const cfg = getAiConfig();
		return c.json({
			configured: !!cfg,
			apiUrl: cfg?.apiUrl ?? null,
		});
	});

	return app;
}
