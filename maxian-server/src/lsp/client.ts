/*---------------------------------------------------------------------------------------------
 *  Maxian Server — LSP Client
 *
 *  对标 OpenCode `packages/opencode/src/lsp/client.ts`
 *  基于 vscode-jsonrpc 与 LSP server 进程通信，支持完整的 LSP 标准操作。
 *--------------------------------------------------------------------------------------------*/

import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type {
	Position, Range, Location, LocationLink, Hover,
	SymbolInformation, DocumentSymbol, WorkspaceSymbol,
	CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall,
	Diagnostic,
} from 'vscode-languageserver-types';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import type { LSPServerHandle } from './servers.js';

export interface LSPClientOptions {
	serverID:    string;
	handle:      LSPServerHandle;
	root:        string;
	/** 初始化超时（默认 10s） */
	initTimeoutMs?: number;
}

export class LSPClient {
	readonly serverID: string;
	readonly root:     string;
	private connection: MessageConnection;
	private initialized = false;
	private ready:      Promise<void>;
	/** 已同步到 server 的文件 URI → 当前版本号 */
	private openedFiles = new Map<string, number>();
	/** 发布诊断 */
	private diagnostics = new Map<string, Diagnostic[]>();
	private killed = false;

	constructor(opts: LSPClientOptions) {
		this.serverID = opts.serverID;
		this.root     = opts.root;

		const proc = opts.handle.process;
		this.connection = createMessageConnection(
			new StreamMessageReader(proc.stdout as any),
			new StreamMessageWriter(proc.stdin as any),
		);

		// 诊断订阅
		this.connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
			const filePath = fileURLToPath(params.uri);
			this.diagnostics.set(filePath, params.diagnostics ?? []);
		});
		// 常见请求的无操作响应
		this.connection.onRequest('window/workDoneProgress/create', () => null);
		this.connection.onRequest('workspace/configuration', async () => [opts.handle.initialization ?? {}]);
		this.connection.onRequest('client/registerCapability', async () => { /* noop */ });
		this.connection.onRequest('client/unregisterCapability', async () => { /* noop */ });
		this.connection.onRequest('workspace/workspaceFolders', async () => [{
			name: 'workspace', uri: pathToFileURL(opts.root).href,
		}]);
		this.connection.onError((e) => {
			// 避免未处理错误杀掉进程
			console.warn(`[LSP ${this.serverID}] connection error:`, e);
		});
		this.connection.onClose(() => {
			this.killed = true;
		});
		this.connection.listen();

		this.ready = this.initialize(opts);
	}

	private async initialize(opts: LSPClientOptions): Promise<void> {
		const timeoutMs = opts.initTimeoutMs ?? 10000;
		const initPromise = this.connection.sendRequest('initialize', {
			processId:         opts.handle.process.pid,
			rootUri:           pathToFileURL(opts.root).href,
			workspaceFolders:  [{ name: 'workspace', uri: pathToFileURL(opts.root).href }],
			initializationOptions: opts.handle.initialization ?? {},
			capabilities: {
				window: { workDoneProgress: true },
				workspace: {
					workspaceFolders: true,
					configuration:    true,
					didChangeWatchedFiles: { dynamicRegistration: true },
				},
				textDocument: {
					synchronization:  { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
					definition:       { linkSupport: true, dynamicRegistration: false },
					references:       { dynamicRegistration: false },
					hover:            { contentFormat: ['plaintext', 'markdown'], dynamicRegistration: false },
					documentSymbol:   { hierarchicalDocumentSymbolSupport: true, dynamicRegistration: false },
					implementation:   { linkSupport: true, dynamicRegistration: false },
					callHierarchy:    { dynamicRegistration: false },
					publishDiagnostics: { relatedInformation: true, versionSupport: false },
				},
			},
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`LSP ${this.serverID} initialize 超时`)), timeoutMs);
		});
		await Promise.race([initPromise, timeoutPromise]);
		this.connection.sendNotification('initialized', {});
		this.initialized = true;
	}

	/** 等待就绪 */
	async whenReady(): Promise<void> { return this.ready; }

	/** 打开或同步文件（每次请求前调用确保 server 已知文件） */
	async touchFile(filePath: string): Promise<void> {
		if (this.killed) throw new Error(`LSP ${this.serverID} 已关闭`);
		await this.ready;
		const uri = pathToFileURL(filePath).href;
		let text: string;
		try { text = await fs.readFile(filePath, 'utf8'); }
		catch (e) { throw new Error(`无法读取 ${filePath}: ${(e as Error).message}`); }

		const known = this.openedFiles.get(uri);
		if (known === undefined) {
			this.connection.sendNotification('textDocument/didOpen', {
				textDocument: { uri, languageId: this.serverID, version: 1, text },
			});
			this.openedFiles.set(uri, 1);
		} else {
			const nextVersion = known + 1;
			this.connection.sendNotification('textDocument/didChange', {
				textDocument:    { uri, version: nextVersion },
				contentChanges:  [{ text }],
			});
			this.openedFiles.set(uri, nextVersion);
		}
		// 给 server 200ms 处理
		await new Promise(r => setTimeout(r, 200));
	}

	/** 诊断缓存 */
	getDiagnostics(filePath: string): Diagnostic[] {
		return this.diagnostics.get(filePath) ?? [];
	}

	// ── LSP 操作 ────────────────────────────────────────────────────────

	async definition(filePath: string, line: number, character: number): Promise<Location[] | LocationLink[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<any>('textDocument/definition', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
		});
		if (!r) return [];
		return Array.isArray(r) ? r : [r];
	}

	async references(filePath: string, line: number, character: number): Promise<Location[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<Location[]>('textDocument/references', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
			context:      { includeDeclaration: true },
		});
		return r ?? [];
	}

	async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<Hover>('textDocument/hover', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
		});
		return r ?? null;
	}

	async documentSymbol(filePath: string): Promise<(SymbolInformation | DocumentSymbol)[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<(SymbolInformation | DocumentSymbol)[]>('textDocument/documentSymbol', {
			textDocument: { uri: pathToFileURL(filePath).href },
		});
		return r ?? [];
	}

	async workspaceSymbol(query: string): Promise<(SymbolInformation | WorkspaceSymbol)[]> {
		await this.ready;
		const r = await this.connection.sendRequest<(SymbolInformation | WorkspaceSymbol)[]>('workspace/symbol', {
			query,
		});
		return r ?? [];
	}

	async implementation(filePath: string, line: number, character: number): Promise<Location[] | LocationLink[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<any>('textDocument/implementation', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
		});
		if (!r) return [];
		return Array.isArray(r) ? r : [r];
	}

	async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<CallHierarchyItem[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<CallHierarchyItem[]>('textDocument/prepareCallHierarchy', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
		});
		return r ?? [];
	}

	async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
		await this.ready;
		const r = await this.connection.sendRequest<CallHierarchyIncomingCall[]>('callHierarchy/incomingCalls', { item });
		return r ?? [];
	}

	async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
		await this.ready;
		const r = await this.connection.sendRequest<CallHierarchyOutgoingCall[]>('callHierarchy/outgoingCalls', { item });
		return r ?? [];
	}

	// ── 编辑动作（返回 WorkspaceEdit，由调用者 applyWorkspaceEdit 真正写盘） ──

	/** 重命名符号 —— 返回跨文件的 WorkspaceEdit */
	async rename(filePath: string, line: number, character: number, newName: string): Promise<any> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<any>('textDocument/rename', {
			textDocument: { uri: pathToFileURL(filePath).href },
			position:     { line, character },
			newName,
		});
		return r ?? null;
	}

	/** 代码操作（quick fix / refactor / source 等），返回 CodeAction[] */
	async codeAction(filePath: string, line: number, character: number, kind?: string): Promise<any[]> {
		await this.touchFile(filePath);
		const only = kind ? [kind] : undefined;
		const r = await this.connection.sendRequest<any[]>('textDocument/codeAction', {
			textDocument: { uri: pathToFileURL(filePath).href },
			range: {
				start: { line, character },
				end:   { line, character },
			},
			context: { diagnostics: [], ...(only ? { only } : {}) },
		});
		return r ?? [];
	}

	/** 格式化整个文档 —— 返回 TextEdit[] */
	async formatDocument(filePath: string, options?: { tabSize?: number; insertSpaces?: boolean }): Promise<any[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<any[]>('textDocument/formatting', {
			textDocument: { uri: pathToFileURL(filePath).href },
			options: {
				tabSize:      options?.tabSize ?? 2,
				insertSpaces: options?.insertSpaces ?? true,
			},
		});
		return r ?? [];
	}

	/** 组织 import（TypeScript 等）—— 用 codeAction 实现 */
	async organizeImports(filePath: string): Promise<any[]> {
		await this.touchFile(filePath);
		const r = await this.connection.sendRequest<any[]>('textDocument/codeAction', {
			textDocument: { uri: pathToFileURL(filePath).href },
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			context: { diagnostics: [], only: ['source.organizeImports'] },
		});
		return r ?? [];
	}

	/** 优雅关闭 */
	async shutdown(): Promise<void> {
		if (this.killed) return;
		this.killed = true;
		try {
			await Promise.race([
				this.connection.sendRequest('shutdown', null),
				new Promise(r => setTimeout(r, 2000)),
			]);
			this.connection.sendNotification('exit');
		} catch { /* ignore */ }
		try { this.connection.dispose(); } catch { /* ignore */ }
	}

	get isAlive(): boolean {
		return !this.killed && this.initialized;
	}
}
