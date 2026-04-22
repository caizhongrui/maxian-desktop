/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Workspace Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作区信息抽象接口。
 *
 * 实现方：
 * - IDE：基于 VSCode IWorkspaceContextService
 * - Desktop：基于用户选择的文件夹（存入 SQLite）
 */
export interface IWorkspace {
	/**
	 * 获取当前工作区的根目录绝对路径。
	 * @returns 根目录路径；如无打开的工作区返回 null
	 */
	getRootPath(): string | null;

	/**
	 * 获取所有工作区根目录（多根工作区支持）。
	 * @returns 所有根目录路径数组
	 */
	getRootPaths(): string[];

	/**
	 * 判断路径是否在工作区内。
	 */
	isInWorkspace(path: string): boolean;

	/**
	 * 将绝对路径转为相对于工作区根的相对路径。
	 * @returns 相对路径；若路径不在工作区内，返回原路径
	 */
	toRelativePath(absolutePath: string): string;

	/**
	 * 获取工作区名称（通常是根目录的 basename）。
	 */
	getName(): string;
}
