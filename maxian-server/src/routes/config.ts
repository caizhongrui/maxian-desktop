/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Config Routes
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { IConfiguration } from '@maxian/core';

export function ConfigRoutes(config: IConfiguration) {
	const app = new Hono();

	app.get('/config/:key', (c) => {
		const key = c.req.param('key');
		const value = config.getValue(key);
		return c.json({ key, value });
	});

	app.put(
		'/config/:key',
		zValidator('json', z.object({
			value: z.unknown(),
		})),
		async (c) => {
			const key = c.req.param('key');
			const { value } = c.req.valid('json');
			if (config.updateValue) {
				await config.updateValue(key, value);
			}
			return c.json({ ok: true });
		}
	);

	return app;
}
