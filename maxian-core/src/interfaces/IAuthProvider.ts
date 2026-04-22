/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Authentication Abstraction
 *--------------------------------------------------------------------------------------------*/

/**
 * 认证抽象接口。
 *
 * 实现方：
 * - IDE：读取 VSCode IStorageService 中的凭据
 * - Desktop：从 OS Keychain（Keychain/Credential Manager/libsecret）读取
 */
export interface IAuthProvider {
	/**
	 * 获取当前认证凭据。
	 * @returns 凭据对象，若未登录返回 null
	 */
	getCredentials(): Promise<AuthCredentials | null>;

	/**
	 * 判断是否已登录。
	 */
	isAuthenticated(): Promise<boolean>;

	/**
	 * 清除凭据（登出）。
	 */
	clearCredentials(): Promise<void>;
}

export interface AuthCredentials {
	/** 用户名（已 base64 编码） */
	username: string;
	/** 密码 / Token（已 base64 编码） */
	password: string;
	/** API 端点 URL */
	apiUrl: string;
	/** 用户邮箱（用于日志上报） */
	userEmail?: string;
}
