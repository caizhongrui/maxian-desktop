/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Node.js Adapter
 *
 *  用 @hono/node-server 启动 Hono 应用。对齐 OpenCode adapter.node.ts 的模式。
 *--------------------------------------------------------------------------------------------*/

import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { ListenOptions, Listener } from '../types.js';

/**
 * 启动 Hono 应用到指定端口。
 */
export async function listen(app: Hono, opts: ListenOptions): Promise<Listener> {
	const hostname = opts.hostname ?? '127.0.0.1';

	const start = (port: number) =>
		new Promise<ServerType>((resolve, reject) => {
			const server = serve(
				{ fetch: app.fetch, port, hostname },
				(addr) => {
					if (!addr || typeof addr === 'string') {
						reject(new Error(`Failed to resolve server address`));
						return;
					}
					resolve(server);
				}
			);
			server.once('error', (err: Error) => {
				reject(err);
			});
		});

	// port=0 让 OS 分配随机端口；指定端口被占用则直接报错（避免 Tauri 前后端端口不一致）
	const server = await start(opts.port);

	const addr = server.address();
	if (!addr || typeof addr === 'string') {
		throw new Error(`Failed to resolve server address for port ${opts.port}`);
	}

	const actualPort = addr.port;
	const actualHost = addr.address === '::' || addr.address === '0.0.0.0'
		? '127.0.0.1'
		: addr.address;

	let closing: Promise<void> | undefined;

	return {
		hostname: actualHost,
		port: actualPort,
		url: new URL(`http://${actualHost}:${actualPort}`),
		httpServer: server as unknown as import('node:http').Server,
		stop: async (closeConnections = true) => {
			if (closing) { return closing; }
			closing = new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) { reject(err); } else { resolve(); }
				});
				if (closeConnections) {
					// node 18+ 才有 closeAllConnections
					const srv = server as unknown as { closeAllConnections?: () => void };
					srv.closeAllConnections?.();
				}
			});
			return closing;
		},
	};
}
