/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Configuration Abstraction
 *
 *  此接口设计为兼容 VSCode IConfigurationService 的最小子集，
 *  使 IDE 可直接将 VSCode 的 IConfigurationService 传入 Core 而无需适配。
 *--------------------------------------------------------------------------------------------*/

/**
 * 配置读写抽象接口。
 *
 * 实现方：
 * - IDE：VSCode IConfigurationService 已直接满足本接口（结构化匹配）
 * - Desktop：基于配置文件（~/.maxian/config.json）+ 环境变量包装
 */
export interface IConfiguration {
	/**
	 * 读取配置项。
	 * @param key 配置键（支持点号分隔，如 "zhikai.auth.apiUrl"）
	 */
	getValue<T>(key: string): T | undefined;
	getValue<T>(key: string, defaultValue: T): T;

	/**
	 * 写入配置项（VSCode 风格签名）。
	 * 返回 Promise。target 可选，Desktop 实现通常忽略。
	 */
	updateValue?(key: string, value: unknown, target?: unknown): Promise<void>;

	/**
	 * 监听配置变更（可选）。
	 */
	onDidChangeConfiguration?(handler: (e: unknown) => void): IDisposable;
}

interface IDisposable {
	dispose(): void;
}
