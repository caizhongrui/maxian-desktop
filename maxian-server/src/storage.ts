/*---------------------------------------------------------------------------------------------
 *  Maxian Server — JSON File Persistence
 *
 *  OpenCode 参照：JSON 文件存储，每个会话一个目录，原子写入（先写 .tmp 再 rename）。
 *  存储根目录：~/.maxian/
 *    workspaces.json                   -- 工作区列表
 *    sessions/{id}/metadata.json       -- 会话元数据
 *    sessions/{id}/messages.json       -- 会话 UI 消息（用户+助手）
 *    sessions/{id}/history.json        -- API 对话历史（MessageParam[]）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export const STORAGE_ROOT   = path.join(os.homedir(), '.maxian');
export const WORKSPACES_FILE = path.join(STORAGE_ROOT, 'workspaces.json');
export const SESSIONS_DIR   = path.join(STORAGE_ROOT, 'sessions');

export function sessionDir(id: string)      { return path.join(SESSIONS_DIR, id); }
export function metadataFile(id: string)    { return path.join(sessionDir(id), 'metadata.json'); }
export function messagesFile(id: string)    { return path.join(sessionDir(id), 'messages.json'); }
export function historyFile(id: string)     { return path.join(sessionDir(id), 'history.json'); }

/** Ensure directory exists (mkdir -p) */
export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

/** Atomic JSON write: write to .tmp then rename */
export async function writeJson(file: string, data: unknown): Promise<void> {
	const tmp = file + '.tmp';
	const json = JSON.stringify(data, null, 2);
	await ensureDir(path.dirname(file));
	await fs.writeFile(tmp, json, 'utf8');
	await fs.rename(tmp, file);
}

/** Read JSON file; returns fallback if missing or invalid */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		const raw = await fs.readFile(file, 'utf8');
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Delete directory recursively (ignore errors) */
export async function removeDir(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch { /* ignore */ }
}

/** List sub-directory names under a directory */
export async function listDirs(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		return [];
	}
}
