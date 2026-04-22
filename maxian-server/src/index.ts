/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Public API
 *
 *  供桌面端 / CLI / VSCode 扩展消费。
 *--------------------------------------------------------------------------------------------*/

export * from './types.js';
export * from './sessionManager.js';
export * from './workspaceManager.js';
export { createServer } from './server.js';
export type { CreateServerOptions, CreatedServer } from './server.js';
export { listen } from './adapter/node.js';
export { bootstrap, wireEventsToSessionManager } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';

export const MAXIAN_SERVER_VERSION = '0.1.0';
