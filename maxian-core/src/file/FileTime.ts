/*---------------------------------------------------------------------------------------------
 *  Maxian Core — FileTime（文件陈旧检测）
 *
 *  对标 OpenCode `packages/opencode/src/file/time.ts` 的精简版。
 *
 *  作用：
 *    1. read(sessionId, file)  —— AI 读取文件时记下当前 mtime + size
 *    2. assert(sessionId, file) —— AI 试图编辑文件前验证：
 *       • 该会话必须读过这个文件（"先读后改"硬约束）
 *       • 当前磁盘 mtime/size 与记录一致（防止外部编辑后 AI 用陈旧内容覆盖）
 *    3. withLock(file, fn)     —— 同一文件的并发写入串行化
 *
 *  比起提示词约束"请先读文件"，代码级硬失败能消除整类 bug。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export namespace FileTime {
	export interface Stamp {
		/** AI 最后读取的时间（我们判断"读过没"） */
		read: Date;
		/** 当时磁盘的 mtime 毫秒值（undefined = 文件不存在） */
		mtime: number | undefined;
		/** 当时磁盘的大小字节（undefined = 文件不存在） */
		size: number | undefined;
	}

	/** sessionId → filepath → Stamp */
	const __reads = new Map<string, Map<string, Stamp>>();

	/** filepath → 串行化 Promise（简易信号量）*/
	const __locks = new Map<string, Promise<unknown>>();

	/**
	 * 路径归一化（跨平台）：
	 *   - 优先走 fs.realpathSync（解析符号链接 + 大小写 + 相对路径）
	 *   - Windows 上补充：小写 drive letter + 反斜杠统一为正斜杠
	 *   - 失败（文件不存在）时退回 path.resolve() 的逻辑归一化
	 *
	 * 为什么需要这一层：
	 *   - AI 可能用 'src/foo.ts' 读、用 './src/foo.ts' 编辑 → 同一文件不同 key
	 *   - Windows 上 'D:\proj\foo' 和 'd:/proj/foo' 是同一文件但字符串不等
	 *   - macOS 大小写不敏感文件系统里 'Foo.ts' 和 'foo.ts' 是同一文件
	 *
	 * 对应 OpenCode 的 Filesystem.normalizePath（同样处理这几类差异）
	 */
	function normalize(filepath: string): string {
		let abs: string;
		try {
			abs = fs.realpathSync(filepath);
		} catch {
			abs = path.resolve(filepath);
		}
		if (process.platform === 'win32') {
			// 统一分隔符 + drive letter 小写
			abs = abs.replace(/\\/g, '/');
			if (/^[A-Z]:\//.test(abs)) {
				abs = abs[0].toLowerCase() + abs.slice(1);
			}
		}
		return abs;
	}

	function getOrCreateSessionMap(sessionId: string): Map<string, Stamp> {
		let s = __reads.get(sessionId);
		if (!s) { s = new Map(); __reads.set(sessionId, s); }
		return s;
	}

	function captureStamp(filepath: string): Stamp {
		try {
			const st = fs.statSync(filepath);
			return {
				read:  new Date(),
				mtime: st.mtimeMs,
				size:  st.size,
			};
		} catch {
			return { read: new Date(), mtime: undefined, size: undefined };
		}
	}

	/** AI 读取文件后调用：记录 mtime/size 作为后续 assert 的基线 */
	export function read(sessionId: string, filepath: string): void {
		const norm = normalize(filepath);
		getOrCreateSessionMap(sessionId).set(norm, captureStamp(norm));
	}

	/** 查询该会话是否读过此文件 + 最后读取时间 */
	export function get(sessionId: string, filepath: string): Date | undefined {
		const norm = normalize(filepath);
		return __reads.get(sessionId)?.get(norm)?.read;
	}

	/** 清理会话时调用（会话关闭/切换，避免内存增长） */
	export function clearSession(sessionId: string): void {
		__reads.delete(sessionId);
	}

	/**
	 * 断言：AI 准备编辑文件前调用。
	 * 抛错场景：
	 *   1. 该会话从未读过此文件 → 提示必须先 read_file
	 *   2. 磁盘 mtime/size 与记录不一致 → 文件已被外部修改，提示重新读取
	 *
	 * 环境变量 `MAXIAN_DISABLE_FILETIME_CHECK=1` 可禁用（调试/特殊场景）
	 */
	export function assert(sessionId: string, filepath: string): void {
		if (process.env.MAXIAN_DISABLE_FILETIME_CHECK === '1') return;

		const norm = normalize(filepath);
		const prev = __reads.get(sessionId)?.get(norm);

		if (!prev) {
			throw new Error(
				`必须先使用 read_file 读取 ${filepath} 才能编辑。\n` +
				`这是为了防止编辑未读过的陈旧文件。请先调用 read_file 工具。`
			);
		}

		// 文件新创建（之前 prev.mtime === undefined）的场景不用检查变更
		if (prev.mtime === undefined) return;

		const curr = captureStamp(norm);
		if (curr.mtime === undefined) {
			throw new Error(`文件 ${filepath} 已不存在（上次读取后被删除）。请重新确认路径。`);
		}

		const changed = curr.mtime !== prev.mtime || curr.size !== prev.size;
		if (changed) {
			const currIso = new Date(curr.mtime).toISOString();
			const prevIso = prev.read.toISOString();
			throw new Error(
				`文件 ${filepath} 自上次读取后已被外部修改。\n` +
				`• 上次读取时间：${prevIso}\n` +
				`• 当前磁盘修改时间：${currIso}\n\n` +
				`请**先调用 read_file 重新读取最新内容**，再进行编辑。\n` +
				`（这可能是用户在编辑器里手改了文件，或另一个工具修改了它。）`
			);
		}
	}

	/** 同一文件的并发写入串行化（避免 edit + multiedit 交叉写入造成数据丢失） */
	export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
		const norm = normalize(filepath);
		const prev = __locks.get(norm) ?? Promise.resolve();
		const next = prev.then(fn, fn);   // 不管上一个是成功还是失败，串行往下跑
		__locks.set(norm, next);
		try {
			return await next;
		} finally {
			// 清理自己，避免内存泄漏（只清理自己这条链）
			if (__locks.get(norm) === next) __locks.delete(norm);
		}
	}
}
