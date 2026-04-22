/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Tool Routes
 *
 *  直接调用工具（供脚本/CI 使用，绕过会话层）
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { IToolExecutor } from '@maxian/core/tools';
import type { ToolUse, ToolName } from '@maxian/core';

export function ToolRoutes(toolExecutor: IToolExecutor) {
	const app = new Hono();

	// 列出可用工具
	app.get('/tools', (c) => {
		return c.json({
			tools: toolExecutor.getAvailableTools(),
		});
	});

	// 执行单个工具
	app.post(
		'/tools/execute',
		zValidator('json', z.object({
			name: z.string(),
			params: z.record(z.string(), z.unknown()),
			toolUseId: z.string().optional(),
		})),
		async (c) => {
			const { name, params, toolUseId } = c.req.valid('json');

			const toolUse: ToolUse = {
				type: 'tool_use',
				name: name as ToolName,
				params: params as Record<string, string>,
				partial: false,
				toolUseId,
			};

			const result = toolExecutor.executeToolWithResult
				? await toolExecutor.executeToolWithResult(toolUse)
				: {
					success: true,
					status: 'success' as const,
					result: await toolExecutor.executeTool(toolUse),
				};

			return c.json(result);
		}
	);

	return app;
}
