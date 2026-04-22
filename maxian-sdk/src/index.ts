/*---------------------------------------------------------------------------------------------
 *  Maxian SDK — HTTP Client for @maxian/server
 *--------------------------------------------------------------------------------------------*/

export interface ClientOptions {
	baseUrl: string;
	username?: string;
	password?: string;
	fetch?: typeof fetch;
}

/** 持久化存储的 UI 消息（从 GET /sessions/:id/messages 返回） */
export interface StoredMessage {
	id: string;
	role: 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'reasoning';
	content: string;
	createdAt: number;
}

export interface SessionSummary {
	id: string;
	title: string;
	status: 'running' | 'done' | 'error' | 'idle';
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	workspacePath?: string;
	uiMode: 'code' | 'chat';
	archived?: boolean;
	pinned?: boolean;
}

export interface Workspace {
	id: string;
	path: string;
	name: string;
	openedAt: number;
}

export interface MaxianEvent {
	type: string;
	sessionId: string;
	[key: string]: unknown;
}

export interface HealthResult {
	ok: boolean;
	version: string;
	uptime: number;
}

export class MaxianClient {
	private readonly baseUrl: string;
	private readonly auth?: string;
	private readonly authQuery?: string; // base64(user:pass) for EventSource ?auth=
	private readonly fetchFn: typeof fetch;

	constructor(opts: ClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
		if (opts.username && opts.password) {
			const encoded = btoa(`${opts.username}:${opts.password}`);
			this.auth = 'Basic ' + encoded;
			this.authQuery = encoded;
		}
		this.fetchFn = opts.fetch ?? fetch;
	}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.auth) headers['Authorization'] = this.auth;
		const res = await this.fetchFn(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`[${res.status}] ${path}: ${text || res.statusText}`);
		}
		if (res.status === 204) return undefined as T;
		// 使用 text() + JSON.parse：Tauri plugin-http 下 res.json() 对大 body 偶尔挂起
		const text = await res.text();
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch (e) {
			throw new Error(`[${res.status}] ${path}: 响应 JSON 解析失败 (${(e as Error).message})`);
		}
	}

	async health(): Promise<HealthResult> {
		return this.request('GET', '/health');
	}

	async listSessions(): Promise<{ sessions: SessionSummary[] }> {
		return this.request('GET', '/sessions');
	}

	async createSession(opts: { title?: string; workspacePath: string; mode?: string; uiMode?: 'code' | 'chat' }): Promise<SessionSummary> {
		return this.request('POST', '/sessions', opts);
	}

	async renameSession(id: string, title: string): Promise<SessionSummary> {
		return this.request('PATCH', `/sessions/${id}`, { title });
	}

	/** 更新会话模式（code / ask / plan / ...） */
	async updateSessionMode(id: string, mode: string): Promise<SessionSummary> {
		return this.request('PATCH', `/sessions/${id}`, { mode });
	}

	async getSessionMessages(
		id: string,
		opts?: { limit?: number; before?: number }
	): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
		const qs = new URLSearchParams();
		if (opts?.limit  !== undefined) qs.set('limit',  String(opts.limit));
		if (opts?.before !== undefined) qs.set('before', String(opts.before));
		const q = qs.toString() ? `?${qs}` : '';
		return this.request('GET', `/sessions/${id}/messages${q}`);
	}

	async deleteSession(id: string): Promise<void> {
		await this.request('DELETE', `/sessions/${id}`);
	}

	async sendMessage(sessionId: string, opts: { content: string; images?: string[] }): Promise<{ messageId: string }> {
		return this.request('POST', `/sessions/${sessionId}/messages`, opts);
	}

	async cancelTask(sessionId: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/cancel`);
	}

	/** 批准或拒绝工具调用权限请求 */
	async approveToolCall(sessionId: string, toolUseId: string, approved: boolean, feedback?: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/approve`, { toolUseId, approved, feedback });
	}

	/** 获取会话中被修改的文件列表 */
	async getChangedFiles(sessionId: string): Promise<{ files: string[] }> {
		return this.request('GET', `/sessions/${sessionId}/changed-files`);
	}

	/** 将指定文件恢复到会话开始前的状态（文件快照） */
	async revertFile(sessionId: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('POST', `/sessions/${sessionId}/revert`, { path: filePath });
	}

	/** 获取文件变更 diff（原始快照内容 vs 当前磁盘内容） */
	async getFileDiff(sessionId: string, filePath: string): Promise<{ original: string | null; current: string }> {
		return this.request('GET', `/sessions/${sessionId}/file-diff?path=${encodeURIComponent(filePath)}`);
	}

	/** 分叉会话：复制消息历史到新会话 */
	async forkSession(sessionId: string): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/fork`);
	}

	/** 回退到指定消息（删除该消息及其后所有消息） */
	async revertToMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; deleted: number; newMsgCount: number; error?: string }> {
		return this.request('POST', `/sessions/${sessionId}/revert-to`, { messageId });
	}

	/** 回答 Agent 的 question 工具提问 */
	async answerQuestion(sessionId: string, opts: { answer?: string; selected?: string[]; cancelled?: boolean }): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/answer-question`, opts);
	}

	/** 响应 Agent 的 plan_exit 请求 */
	async respondPlanExit(sessionId: string, approved: boolean, feedback?: string): Promise<void> {
		await this.request('POST', `/sessions/${sessionId}/plan-exit`, { approved, feedback });
	}

	/** 手动触发上下文压缩（/compact 命令）*/
	async compactSession(sessionId: string): Promise<{
		ok: boolean; level: number; tokensBefore: number; tokensAfter: number;
		prunedTools: number; summarizedMsgs: number; error?: string;
	}> {
		return this.request('POST', `/sessions/${sessionId}/compact`);
	}

	/** 归档 / 取消归档 */
	async setSessionArchived(sessionId: string, archived: boolean): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/archive`, { archived });
	}

	/** 置顶 / 取消置顶 */
	async setSessionPinned(sessionId: string, pinned: boolean): Promise<{ ok: boolean; session?: SessionSummary }> {
		return this.request('POST', `/sessions/${sessionId}/pin`, { pinned });
	}

	/** 删除单条消息 */
	async deleteMessage(sessionId: string, messageId: string): Promise<{ deleted: boolean }> {
		return this.request('DELETE', `/sessions/${sessionId}/messages/${messageId}`);
	}

	/** 编辑用户消息（并删除其后所有消息） */
	async editUserMessage(sessionId: string, messageId: string, content: string): Promise<{ ok: boolean; deletedAfter: number; error?: string }> {
		return this.request('PATCH', `/sessions/${sessionId}/messages/${messageId}`, { content });
	}

	/** 从指定消息重新生成（删除其后消息，由前端再触发一次 send 重跑） */
	async regenerateFromMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; kept: number; deleted: number; promptUserId: string | null }> {
		return this.request('POST', `/sessions/${sessionId}/messages/${messageId}/regenerate`);
	}

	/** 从指定消息 fork 出新会话 */
	async forkFromMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; newSessionId?: string }> {
		return this.request('POST', `/sessions/${sessionId}/messages/${messageId}/fork`);
	}

	/**
	 * 订阅会话 SSE 事件流。
	 *
	 * 使用 XMLHttpRequest 代替 fetch + ReadableStream：
	 *  - XHR 不被 Tauri HTTP plugin 拦截，能在 WKWebView 中做真正的流式读取
	 *  - 通过 onprogress 逐块处理 SSE 数据
	 *  - 自动重连 + 指数退避，最大 16 秒
	 *  - auth 通过 ?auth= 查询参数传递（loopback）或 Authorization header（远程）
	 */
	subscribeEvents(sessionId: string, onEvent: (e: MaxianEvent) => void, onError?: (e: unknown) => void): () => void {
		const qs = this.authQuery ? `?auth=${encodeURIComponent(this.authQuery)}` : '';
		const url = `${this.baseUrl}/sessions/${sessionId}/events${qs}`;
		const isLoopback = /127\.0\.0\.1|localhost|\[::1\]/.test(this.baseUrl);

		let aborted = false;
		let currentXhr: XMLHttpRequest | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let delay = 250;

		const connect = () => {
			if (aborted) return;

			const xhr = new XMLHttpRequest();
			currentXhr = xhr;
			xhr.open('GET', url, true);
			xhr.setRequestHeader('Accept', 'text/event-stream');
			xhr.setRequestHeader('Cache-Control', 'no-cache');
			// 非 loopback 时通过 Authorization header 传认证；loopback 走 ?auth= 查询参数
			if (this.auth && !isLoopback) {
				xhr.setRequestHeader('Authorization', this.auth);
			}

			let buf = '';
			let lastLength = 0;

			const processChunk = () => {
				const text = xhr.responseText;
				if (text.length <= lastLength) return;
				buf += text.slice(lastLength);
				lastLength = text.length;

				// 按双换行分割事件块
				const blocks = buf.split('\n\n');
				buf = blocks.pop() ?? '';

				for (const block of blocks) {
					if (!block.trim()) continue;
					for (const line of block.split('\n')) {
						if (line.startsWith('data:')) {
							const data = line.slice(5).trim();
							if (data && data !== '[DONE]') {
								try { onEvent(JSON.parse(data) as MaxianEvent); } catch (e) { onError?.(e); }
							}
						}
					}
				}
			};

			xhr.onprogress = processChunk;

			xhr.onload = () => {
				processChunk(); // 处理最后一块
				if (!aborted) {
					// 服务端关闭连接 → 立即重连（重置 delay）
					delay = 250;
					retryTimer = setTimeout(connect, delay);
				}
			};

			xhr.onerror = () => {
				if (aborted) return;
				onError?.(new Error(`SSE connection failed: ${url}`));
				retryTimer = setTimeout(() => {
					delay = Math.min(delay * 2, 16000);
					connect();
				}, delay);
			};

			xhr.send();
		};

		connect();

		return () => {
			aborted = true;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			currentXhr?.abort();
			currentXhr = null;
		};
	}

	async listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
		return this.request('GET', '/workspaces');
	}

	async addWorkspace(path: string): Promise<Workspace> {
		return this.request('POST', '/workspaces', { path });
	}

	async renameWorkspace(id: string, name: string): Promise<Workspace> {
		return this.request('PATCH', `/workspaces/${id}`, { name });
	}

	async removeWorkspace(id: string): Promise<void> {
		await this.request('DELETE', `/workspaces/${id}`);
	}

	async listFiles(workspaceId: string, pattern?: string): Promise<{ files: string[] }> {
		const qs = pattern ? `?pattern=${encodeURIComponent(pattern)}` : '';
		return this.request('GET', `/workspaces/${workspaceId}/files${qs}`);
	}

	/** 读取项目级配置 + 自定义 agent / command */
	async getProjectConfig(workspaceId: string): Promise<{
		config: {
			defaultBusinessCode?: string;
			permissions?: any;
			model?: { temperature?: number; topP?: number; maxTokens?: number };
			additionalSystemPrompt?: string;
			plugins?: string[];
			disabledTools?: string[];
		};
		agents: Array<{ name: string; description: string; systemPrompt: string; tools?: string[]; model?: string; temperature?: number; topP?: number }>;
		commands: Array<{ name: string; description: string; template: string; agent?: string }>;
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/project-config`);
	}

	/** 全局符号 + 文件名搜索（⌘P 命令面板用）*/
	async searchSymbols(workspaceId: string, query: string): Promise<{
		symbols: Array<{ name: string; kind?: number; location?: any; containerName?: string }>;
		files:   string[];
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/symbols?q=${encodeURIComponent(query)}`);
	}

	/** 读取工作区任意文件，用于预览面板
	 *  - 文本文件：encoding='utf8'，content=文件文本
	 *  - 图片/音视频：encoding='base64'，content=base64 数据（isImage/isAudio/isVideo 指示类型）
	 *  - 二进制：encoding='none'，content=''，isBinary=true
	 *  - 文件过大或出错：带 error 字段（仍返回 200）
	 */
	async readFileContent(workspaceId: string, filePath: string): Promise<{
		path:         string;
		absolutePath: string;
		size:         number;
		mimeType:     string;
		isBinary:     boolean;
		isImage:      boolean;
		isAudio:      boolean;
		isVideo:      boolean;
		encoding:     'utf8' | 'base64' | 'none';
		content:      string;
		error?:       string;
	}> {
		return this.request(
			'GET',
			`/workspaces/${workspaceId}/file-content?path=${encodeURIComponent(filePath)}`,
		);
	}

	/** 写入文件内容（P0-2: 应用代码到文件；保留 CRLF 风格；支持 mtime 冲突检测）
	 *  - createIfMissing 默认 true；若为 false 且文件不存在，返回 404
	 *  - expectedMtimeMs：若提供，写入前对比；若 mtime 不匹配，返回 409（文件被外部修改）
	 */
	async writeFileContent(workspaceId: string, filePath: string, content: string, opts?: {
		createIfMissing?: boolean;
		expectedMtimeMs?: number;
	}): Promise<{
		ok:           true;
		path:         string;
		absolutePath: string;
		size:         number;
		mtimeMs:      number;
		created:      boolean;
	}> {
		return this.request(
			'POST',
			`/workspaces/${workspaceId}/file-write`,
			{ path: filePath, content, ...(opts ?? {}) },
		);
	}

	/** 查询文件 mtime/size（P0-4: 外部变更检测） */
	async getFileStat(workspaceId: string, filePath: string): Promise<{
		path:         string;
		absolutePath: string;
		size:         number;
		mtimeMs:      number;
		exists:       boolean;
	}> {
		return this.request(
			'GET',
			`/workspaces/${workspaceId}/file-stat?path=${encodeURIComponent(filePath)}`,
		);
	}

	/** 列出工作区可用的 Skills（扫描 .maxian/skills/ 、.claude/skills/ 及用户级目录） */
	async listSkills(workspaceId: string): Promise<{
		skills: Array<{
			name:        string;
			description: string;
			path:        string;
			source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude';
			size:        number;
		}>;
		searchedDirs: Array<{ path: string; source: string; exists: boolean }>;
	}> {
		return this.request('GET', `/workspaces/${workspaceId}/skills`);
	}

	/** Git Worktree 相关 */
	async listWorktrees(workspaceId: string): Promise<{ worktrees: Array<{ path: string; branch: string; head: string; locked: boolean }> }> {
		return this.request('GET', `/workspaces/${workspaceId}/worktrees`);
	}

	async listBranches(workspaceId: string): Promise<{ branches: string[] }> {
		return this.request('GET', `/workspaces/${workspaceId}/branches`);
	}

	async createWorktree(workspaceId: string, opts: { branch: string; newBranch?: string; worktreePath?: string }): Promise<{ ok: boolean; path?: string; error?: string }> {
		return this.request('POST', `/workspaces/${workspaceId}/worktrees`, opts);
	}

	async removeWorktree(workspaceId: string, worktreePath: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('DELETE', `/workspaces/${workspaceId}/worktrees`, { worktreePath });
	}

	/** 获取工作区当前 git 分支 */
	async getCurrentBranch(workspaceId: string): Promise<{ branch: string | null; isGitRepo: boolean; error?: string }> {
		return this.request('GET', `/workspaces/${workspaceId}/current-branch`);
	}

	/** 检出 git 分支 */
	async checkoutBranch(workspaceId: string, branch: string): Promise<{ ok: boolean; error?: string }> {
		return this.request('POST', `/workspaces/${workspaceId}/checkout`, { branch });
	}

	/** 配置服务端的 AI 代理（登录后调用，凭据在服务端运行时生效） */
	async configureAi(opts: { apiUrl: string; username: string; password: string }): Promise<void> {
		await this.request('POST', '/auth/configure', opts);
	}

	/** 清除服务端 AI 代理配置（登出时调用） */
	async clearAiConfig(): Promise<void> {
		await this.request('DELETE', '/auth/configure');
	}

	/** 查询服务端 AI 配置状态 */
	async getAiStatus(): Promise<{ configured: boolean; apiUrl: string | null }> {
		return this.request('GET', '/auth/status');
	}

	async listTools(): Promise<{ tools: string[] }> {
		return this.request('GET', '/tools');
	}

	async executeTool(opts: { name: string; params: Record<string, unknown>; toolUseId?: string }): Promise<unknown> {
		return this.request('POST', '/tools/execute', opts);
	}
}
