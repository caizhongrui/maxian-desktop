/*---------------------------------------------------------------------------------------------
 *  Maxian Server — LSP Manager
 *
 *  对标 OpenCode `packages/opencode/src/lsp/index.ts`
 *  为每个 (serverID, root) 组合维护一个 LSPClient 实例，并提供统一的调用入口。
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { LSPClient } from './client.js';
import { ALL_SERVERS, pickServers, computeRoot, type LSPServerInfo } from './servers.js';
import type { Location, LocationLink, Hover, SymbolInformation, DocumentSymbol, WorkspaceSymbol, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, Diagnostic } from 'vscode-languageserver-types';

export namespace LSP {
	/** (serverID + root) → client */
	const clients = new Map<string, LSPClient>();

	function key(serverID: string, root: string): string { return `${serverID}|${root}`; }

	/** 为文件获取一个可用的 LSPClient（按序尝试多个候选 server） */
	async function getClientForFile(file: string, workspaceRoot: string): Promise<LSPClient | undefined> {
		const candidates = pickServers(file);
		for (const info of candidates) {
			const root = computeRoot(info, file, workspaceRoot);
			if (!root) continue;  // 被 excludeMarkers 过滤
			const k = key(info.id, root);
			const existing = clients.get(k);
			if (existing?.isAlive) return existing;

			try {
				const handle = await info.spawn(root);
				if (!handle) continue;  // 找不到可执行文件
				const client = new LSPClient({ serverID: info.id, handle, root });
				await client.whenReady();
				clients.set(k, client);
				return client;
			} catch (e) {
				console.warn(`[LSP] 启动 ${info.id} (root=${root}) 失败:`, (e as Error).message);
				continue;
			}
		}
		return undefined;
	}

	/** 是否能为该文件获得可用 LSP */
	export async function hasClients(file: string, workspaceRoot: string): Promise<boolean> {
		const c = await getClientForFile(file, workspaceRoot);
		return !!c;
	}

	/** 关闭所有客户端 */
	export async function shutdownAll(): Promise<void> {
		await Promise.all([...clients.values()].map(c => c.shutdown().catch(() => undefined)));
		clients.clear();
	}

	// ── 统一操作入口（1-based line/character 输入，LSP 内部 0-based） ──

	export interface Position { file: string; line: number; character: number }

	async function withClient<T>(
		file:          string,
		workspaceRoot: string,
		fn:            (c: LSPClient) => Promise<T>,
	): Promise<T | undefined> {
		const c = await getClientForFile(file, workspaceRoot);
		if (!c) return undefined;
		return fn(c);
	}

	export async function definition(pos: Position, workspaceRoot: string): Promise<(Location | LocationLink)[]> {
		return (await withClient(pos.file, workspaceRoot, c => c.definition(pos.file, pos.line - 1, pos.character - 1))) ?? [];
	}
	export async function references(pos: Position, workspaceRoot: string): Promise<Location[]> {
		return (await withClient(pos.file, workspaceRoot, c => c.references(pos.file, pos.line - 1, pos.character - 1))) ?? [];
	}
	export async function hover(pos: Position, workspaceRoot: string): Promise<Hover | null> {
		return (await withClient(pos.file, workspaceRoot, c => c.hover(pos.file, pos.line - 1, pos.character - 1))) ?? null;
	}
	export async function documentSymbol(file: string, workspaceRoot: string): Promise<(SymbolInformation | DocumentSymbol)[]> {
		return (await withClient(file, workspaceRoot, c => c.documentSymbol(file))) ?? [];
	}
	export async function workspaceSymbol(query: string, anyFile: string, workspaceRoot: string): Promise<(SymbolInformation | WorkspaceSymbol)[]> {
		return (await withClient(anyFile, workspaceRoot, c => c.workspaceSymbol(query))) ?? [];
	}
	export async function implementation(pos: Position, workspaceRoot: string): Promise<(Location | LocationLink)[]> {
		return (await withClient(pos.file, workspaceRoot, c => c.implementation(pos.file, pos.line - 1, pos.character - 1))) ?? [];
	}
	export async function prepareCallHierarchy(pos: Position, workspaceRoot: string): Promise<CallHierarchyItem[]> {
		return (await withClient(pos.file, workspaceRoot, c => c.prepareCallHierarchy(pos.file, pos.line - 1, pos.character - 1))) ?? [];
	}
	export async function incomingCalls(item: CallHierarchyItem, workspaceRoot: string): Promise<CallHierarchyIncomingCall[]> {
		// 从 item.uri 还原 file，再取 client
		const file = item.uri ? new URL(item.uri).pathname : '';
		return (await withClient(file, workspaceRoot, c => c.incomingCalls(item))) ?? [];
	}
	export async function outgoingCalls(item: CallHierarchyItem, workspaceRoot: string): Promise<CallHierarchyOutgoingCall[]> {
		const file = item.uri ? new URL(item.uri).pathname : '';
		return (await withClient(file, workspaceRoot, c => c.outgoingCalls(item))) ?? [];
	}
	export async function diagnostics(file: string, workspaceRoot: string): Promise<Diagnostic[]> {
		const c = await getClientForFile(file, workspaceRoot);
		if (!c) return [];
		await c.touchFile(file);
		// 等一点时间让 server 产生诊断
		await new Promise(r => setTimeout(r, 500));
		return c.getDiagnostics(file);
	}

	// ── 编辑动作（返回数据 + 直接 apply 两种都提供） ──

	export async function rename(pos: Position, newName: string, workspaceRoot: string): Promise<any> {
		return (await withClient(pos.file, workspaceRoot, c => c.rename(pos.file, pos.line - 1, pos.character - 1, newName))) ?? null;
	}
	export async function codeAction(pos: Position, kind: string | undefined, workspaceRoot: string): Promise<any[]> {
		return (await withClient(pos.file, workspaceRoot, c => c.codeAction(pos.file, pos.line - 1, pos.character - 1, kind))) ?? [];
	}
	export async function formatDocument(file: string, workspaceRoot: string): Promise<any[]> {
		return (await withClient(file, workspaceRoot, c => c.formatDocument(file))) ?? [];
	}
	export async function organizeImports(file: string, workspaceRoot: string): Promise<any[]> {
		return (await withClient(file, workspaceRoot, c => c.organizeImports(file))) ?? [];
	}

	/**
	 * 把 LSP WorkspaceEdit 应用到磁盘（支持 changes 和 documentChanges 两种格式）。
	 * 返回被修改的文件列表。
	 */
	export async function applyWorkspaceEdit(edit: any): Promise<string[]> {
		const fs = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const changedFiles: string[] = [];

		/** 对单个文件应用 TextEdit[] */
		const applyEditsToFile = (filePath: string, edits: Array<{ range: any; newText: string }>) => {
			let content = fs.readFileSync(filePath, 'utf8');
			const lines = content.split(/\r?\n/);
			// 按范围从后往前替换，避免偏移错乱
			const sorted = [...edits].sort((a, b) => {
				const la = a.range.start.line, ca = a.range.start.character;
				const lb = b.range.start.line, cb = b.range.start.character;
				if (la !== lb) return lb - la;
				return cb - ca;
			});
			for (const te of sorted) {
				const startLine = te.range.start.line;
				const startCh   = te.range.start.character;
				const endLine   = te.range.end.line;
				const endCh     = te.range.end.character;
				if (startLine === endLine) {
					lines[startLine] = lines[startLine].slice(0, startCh) + te.newText + lines[startLine].slice(endCh);
				} else {
					const first = lines[startLine].slice(0, startCh) + te.newText + (lines[endLine]?.slice(endCh) ?? '');
					lines.splice(startLine, endLine - startLine + 1, ...first.split('\n'));
				}
			}
			content = lines.join('\n');
			fs.writeFileSync(filePath, content, 'utf8');
			changedFiles.push(filePath);
		};

		// 优先处理 documentChanges（更新、rename、create、delete 各种）
		if (Array.isArray(edit?.documentChanges)) {
			for (const dc of edit.documentChanges) {
				if (dc.kind === 'rename') {
					const oldP = fileURLToPath(dc.oldUri);
					const newP = fileURLToPath(dc.newUri);
					fs.renameSync(oldP, newP);
					changedFiles.push(newP);
				} else if (dc.kind === 'create') {
					const p = fileURLToPath(dc.uri);
					fs.writeFileSync(p, '', 'utf8');
					changedFiles.push(p);
				} else if (dc.kind === 'delete') {
					const p = fileURLToPath(dc.uri);
					try { fs.unlinkSync(p); } catch {}
					changedFiles.push(p);
				} else if (dc.textDocument && Array.isArray(dc.edits)) {
					applyEditsToFile(fileURLToPath(dc.textDocument.uri), dc.edits);
				}
			}
		} else if (edit?.changes && typeof edit.changes === 'object') {
			// 旧格式 changes: { uri: TextEdit[] }
			for (const [uri, edits] of Object.entries(edit.changes)) {
				applyEditsToFile(fileURLToPath(uri), edits as any[]);
			}
		}
		return Array.from(new Set(changedFiles));
	}

	/** 对单个文件应用 TextEdit[]（formatDocument / organizeImports 用）*/
	export async function applyTextEdits(filePath: string, edits: any[]): Promise<void> {
		if (!edits || edits.length === 0) return;
		await applyWorkspaceEdit({ changes: { [`file://${filePath}`]: edits } });
	}
}
