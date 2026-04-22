/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Persistent Storage Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 持久化存储抽象接口（用于会话历史、偏好记忆等）。
 *
 * 实现方：
 * - IDE：基于 VSCode IStorageService（LevelDB）
 * - Desktop：基于 SQLite（tauri-plugin-sql）+ 文件（.maxian/sessions.json）
 */
export interface IStorage {
	/**
	 * 读取键对应的值。
	 */
	get<T = unknown>(key: string): Promise<T | null>;

	/**
	 * 写入键值对。
	 * @param scope 作用域（global=全局跨工作区、workspace=仅当前工作区）
	 */
	set<T = unknown>(key: string, value: T, scope?: StorageScope): Promise<void>;

	/**
	 * 删除键。
	 */
	delete(key: string): Promise<void>;

	/**
	 * 列出某个前缀下的所有键。
	 */
	listKeys(prefix?: string): Promise<string[]>;
}

export type StorageScope = 'global' | 'workspace';
