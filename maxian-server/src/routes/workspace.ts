/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Workspace Routes
 *
 *  多工作区管理：用户可以打开多个仓库，每个仓库独立会话池
 *--------------------------------------------------------------------------------------------*/

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { WorkspaceManager } from '../workspaceManager.js';

/** 文件扩展名 → MIME 类型 */
const MIME_MAP: Record<string, string> = {
	'.png':  'image/png',
	'.jpg':  'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif':  'image/gif',
	'.webp': 'image/webp',
	'.svg':  'image/svg+xml',
	'.ico':  'image/x-icon',
	'.bmp':  'image/bmp',
	'.avif': 'image/avif',
	'.mp4':  'video/mp4',
	'.webm': 'video/webm',
	'.mp3':  'audio/mpeg',
	'.wav':  'audio/wav',
	'.ogg':  'audio/ogg',
	'.pdf':  'application/pdf',
};

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.bmp','.avif']);
const AUDIO_EXTS = new Set(['.mp3','.wav','.ogg','.flac','.m4a']);
const VIDEO_EXTS = new Set(['.mp4','.webm','.mov','.mkv']);
const BINARY_EXTS = new Set([
	'.exe','.dll','.so','.dylib','.bin','.o','.a','.obj',
	'.zip','.tar','.gz','.7z','.rar','.tgz','.bz2',
	'.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
	'.ttf','.otf','.woff','.woff2','.eot',
	'.db','.sqlite','.class','.jar','.pyc',
]);

function detectMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_MAP[ext] ?? 'application/octet-stream';
}

/** 启发式判断一段 buffer 是否为二进制（前 8KB 中出现 NUL 字节） */
function looksBinary(buf: Buffer, sampleLen = 8192): boolean {
	const n = Math.min(buf.length, sampleLen);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

export function WorkspaceRoutes(workspaceManager: WorkspaceManager) {
	const app = new Hono();

	// 列出所有工作区
	app.get('/workspaces', (c) => {
		return c.json({
			workspaces: workspaceManager.list(),
		});
	});

	// 添加工作区
	app.post(
		'/workspaces',
		zValidator('json', z.object({
			path: z.string(),
		})),
		async (c) => {
			const { path } = c.req.valid('json');
			const ws = await workspaceManager.add(path);
			return c.json(ws, 201);
		}
	);

	// 重命名工作区
	app.patch(
		'/workspaces/:id',
		zValidator('json', z.object({ name: z.string() })),
		(c) => {
			const id = c.req.param('id');
			const { name } = c.req.valid('json');
			const ws = workspaceManager.rename(id, name);
			return c.json(ws);
		}
	);

	// 移除工作区
	app.delete('/workspaces/:id', async (c) => {
		const id = c.req.param('id');
		await workspaceManager.remove(id);
		return c.json({ ok: true });
	});

	// 获取工作区文件树
	app.get('/workspaces/:id/files', async (c) => {
		const id = c.req.param('id');
		const pattern = c.req.query('pattern') || '**/*';
		const files = await workspaceManager.listFiles(id, pattern);
		return c.json({ files });
	});

	// 读取工作区任意文件的内容（用于预览面板）
	// 文本：返回 utf8 字符串；图片/二进制：返回 base64
	// 路径安全：绝对路径必须位于工作区目录内
	app.get('/workspaces/:id/file-content', async (c) => {
		const id = c.req.param('id');
		const relOrAbs = c.req.query('path');
		if (!relOrAbs) return c.json({ error: 'path required' }, 400);

		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);

		// 解析为绝对路径
		const absolute = path.isAbsolute(relOrAbs)
			? path.normalize(relOrAbs)
			: path.normalize(path.join(ws.path, relOrAbs));

		// 安全检查：位于工作区内 OR 位于已知安全的用户/项目目录（skills/plugins/AGENTS.md 等）
		const wsRoot = path.resolve(ws.path) + path.sep;
		const abs    = path.resolve(absolute);

		const safeRoots = [
			path.resolve(ws.path),                                   // 工作区根
			path.join(os.homedir(), '.claude'),                       // 用户 ~/.claude（skills / AGENTS.md / CLAUDE.md）
			path.join(os.homedir(), '.maxian'),                       // 用户 ~/.maxian（skills / plugins / AGENTS.md）
			path.join(os.homedir(), '.agents'),                       // 用户 ~/.agents（符号链接常见目标）
			path.join(os.homedir(), 'Library', 'Application Support', 'tianhe-lingyu'),
		];
		const isInSafeRoot = safeRoots.some(root => {
			const r = path.resolve(root);
			return abs === r || abs.startsWith(r + path.sep);
		});

		if (abs !== path.resolve(ws.path) && !abs.startsWith(wsRoot) && !isInSafeRoot) {
			return c.json({ error: 'path outside allowed directories' }, 403);
		}

		try {
			const stat = fs.statSync(abs);
			if (stat.isDirectory()) {
				return c.json({ error: 'is a directory' }, 400);
			}

			const ext      = path.extname(abs).toLowerCase();
			const mimeType = detectMimeType(abs);
			const isImage  = IMAGE_EXTS.has(ext);
			const isAudio  = AUDIO_EXTS.has(ext);
			const isVideo  = VIDEO_EXTS.has(ext);

			// 尺寸限制
			const MAX_TEXT_SIZE  = 2  * 1024 * 1024; // 2MB
			const MAX_MEDIA_SIZE = 20 * 1024 * 1024; // 20MB

			if ((isImage || isAudio || isVideo) && stat.size > MAX_MEDIA_SIZE) {
				return c.json({
					path: relOrAbs, absolutePath: abs, size: stat.size,
					mimeType, isBinary: true, isImage, isAudio, isVideo,
					encoding: 'none', content: '',
					error: `file too large (${(stat.size/1024/1024).toFixed(1)}MB > 20MB)`,
				});
			}

			// 图片/音视频：base64
			if (isImage || isAudio || isVideo) {
				const buf = fs.readFileSync(abs);
				return c.json({
					path: relOrAbs, absolutePath: abs, size: stat.size,
					mimeType, isBinary: false, isImage, isAudio, isVideo,
					encoding: 'base64',
					content: buf.toString('base64'),
				});
			}

			// 已知二进制扩展名：直接返回二进制标记
			if (BINARY_EXTS.has(ext)) {
				return c.json({
					path: relOrAbs, absolutePath: abs, size: stat.size,
					mimeType, isBinary: true, isImage: false, isAudio: false, isVideo: false,
					encoding: 'none', content: '',
				});
			}

			if (stat.size > MAX_TEXT_SIZE) {
				return c.json({
					path: relOrAbs, absolutePath: abs, size: stat.size,
					mimeType, isBinary: false, isImage: false, isAudio: false, isVideo: false,
					encoding: 'utf8', content: '',
					error: `file too large (${(stat.size/1024/1024).toFixed(1)}MB > 2MB)`,
				});
			}

			// 读取 + 启发式二进制检测
			const buf = fs.readFileSync(abs);
			if (looksBinary(buf)) {
				return c.json({
					path: relOrAbs, absolutePath: abs, size: stat.size,
					mimeType, isBinary: true, isImage: false, isAudio: false, isVideo: false,
					encoding: 'none', content: '',
				});
			}

			return c.json({
				path: relOrAbs, absolutePath: abs, size: stat.size,
				mimeType, isBinary: false, isImage: false, isAudio: false, isVideo: false,
				encoding: 'utf8',
				content: buf.toString('utf8'),
			});
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// 写入工作区文件（P0-2: 应用到文件；P0-4: 外部变更对比）
	// body: { path: string; content: string; createIfMissing?: boolean; expectedMtimeMs?: number }
	app.post('/workspaces/:id/file-write', async (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		let body: any;
		try { body = await c.req.json(); } catch { return c.json({ error: 'invalid body' }, 400); }
		const relOrAbs = body?.path;
		const content  = body?.content;
		if (typeof relOrAbs !== 'string' || typeof content !== 'string') {
			return c.json({ error: 'path and content required' }, 400);
		}
		const absolute = path.isAbsolute(relOrAbs)
			? path.normalize(relOrAbs)
			: path.normalize(path.join(ws.path, relOrAbs));
		const wsRoot = path.resolve(ws.path) + path.sep;
		const abs    = path.resolve(absolute);
		if (abs !== path.resolve(ws.path) && !abs.startsWith(wsRoot)) {
			return c.json({ error: 'path outside workspace' }, 403);
		}
		try {
			let existed = false;
			try { fs.statSync(abs); existed = true; } catch { /* not exists */ }
			if (!existed && body?.createIfMissing === false) {
				return c.json({ error: 'file not found and createIfMissing=false' }, 404);
			}
			// 可选 mtime 冲突检测
			if (existed && typeof body?.expectedMtimeMs === 'number') {
				const st = fs.statSync(abs);
				if (Math.abs(st.mtimeMs - body.expectedMtimeMs) > 2) {
					return c.json({
						error: 'file modified externally',
						currentMtimeMs: st.mtimeMs,
						expectedMtimeMs: body.expectedMtimeMs,
					}, 409);
				}
			}
			// 保留 CRLF 风格（若原文有 \r\n，则写入也保持）
			let finalContent = content;
			if (existed) {
				try {
					const orig = fs.readFileSync(abs, 'utf8');
					if (orig.includes('\r\n') && !finalContent.includes('\r\n')) {
						finalContent = finalContent.replace(/\n/g, '\r\n');
					}
				} catch { /* ignore */ }
			}
			// 确保目录存在
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, finalContent, 'utf8');
			const st = fs.statSync(abs);
			return c.json({
				ok: true,
				path: relOrAbs,
				absolutePath: abs,
				size: st.size,
				mtimeMs: st.mtimeMs,
				created: !existed,
			});
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// 文件 mtime 查询（P0-4: 轮询检测外部修改）
	app.get('/workspaces/:id/file-stat', async (c) => {
		const id = c.req.param('id');
		const relOrAbs = c.req.query('path');
		if (!relOrAbs) return c.json({ error: 'path required' }, 400);
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		const absolute = path.isAbsolute(relOrAbs)
			? path.normalize(relOrAbs)
			: path.normalize(path.join(ws.path, relOrAbs));
		const wsRoot = path.resolve(ws.path) + path.sep;
		const abs    = path.resolve(absolute);
		const safeRoots = [
			path.resolve(ws.path),
			path.join(os.homedir(), '.claude'),
			path.join(os.homedir(), '.maxian'),
			path.join(os.homedir(), '.agents'),
			path.join(os.homedir(), 'Library', 'Application Support', 'tianhe-lingyu'),
		];
		const isInSafeRoot = safeRoots.some(root => {
			const r = path.resolve(root);
			return abs === r || abs.startsWith(r + path.sep);
		});
		if (abs !== path.resolve(ws.path) && !abs.startsWith(wsRoot) && !isInSafeRoot) {
			return c.json({ error: 'path outside allowed directories' }, 403);
		}
		try {
			const st = fs.statSync(abs);
			return c.json({
				path: relOrAbs,
				absolutePath: abs,
				size: st.size,
				mtimeMs: st.mtimeMs,
				exists: true,
			});
		} catch {
			return c.json({ path: relOrAbs, absolutePath: abs, size: 0, mtimeMs: 0, exists: false });
		}
	});

	// 项目级配置 + 自定义 agent/command
	app.get('/workspaces/:id/project-config', async (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		const mod = await import('../projectConfig.js');
		return c.json({
			config:   mod.loadProjectConfig(ws.path),
			agents:   mod.loadCustomAgents(ws.path),
			commands: mod.loadCustomCommands(ws.path),
		});
	});

	// 全局符号搜索（LSP workspaceSymbol + 文件名 fallback）
	app.get('/workspaces/:id/symbols', async (c) => {
		const id = c.req.param('id');
		const query = c.req.query('q') ?? '';
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		if (!query) return c.json({ symbols: [], files: [] });

		// 尝试 LSP workspaceSymbol
		let lspSymbols: any[] = [];
		try {
			const lspMod = await import('../lsp/index.js');
			// 找一个典型文件作为 LSP client "入口"
			const files = await workspaceManager.listFiles(id, '**/*.{ts,tsx,js,py,go,rs,java}');
			const filesArr: string[] = Array.isArray(files) ? files : ((files as any).files ?? []);
			const anyFile = filesArr[0];
			if (anyFile) {
				const absFile = path.isAbsolute(anyFile) ? anyFile : path.resolve(ws.path, anyFile);
				lspSymbols = await lspMod.LSP.workspaceSymbol(query, absFile, ws.path);
			}
		} catch (e) {
			// LSP 不可用就跳过
		}

		// 文件名 fallback：按子串匹配
		const files = await workspaceManager.listFiles(id, '**/*');
		const filesArr: string[] = Array.isArray(files) ? files : ((files as any).files ?? []);
		const q = query.toLowerCase();
		const fileMatches = filesArr
			.filter((f: string) => f.toLowerCase().includes(q))
			.slice(0, 50);

		return c.json({ symbols: lspSymbols.slice(0, 50), files: fileMatches });
	});

	// ─── Skills（技能文档）管理 ───────────────────────────────────────────────

	/** 从一个 md 文件中提取 title（frontmatter.name 或第一行 # 或文件名）和 description */
	function parseSkillMeta(absPath: string): { name: string; description: string; size: number } {
		// name 优先级：frontmatter.name > 父目录名（若文件名是 SKILL.md/README.md） > 文件 basename
		const base = path.basename(absPath, '.md');
		const parent = path.basename(path.dirname(absPath));
		const isEntryFile = /^(?:SKILL|skill|README)$/i.test(base);
		let name = isEntryFile ? parent : base;
		let description = '';
		let size = 0;
		try {
			const raw = fs.readFileSync(absPath, 'utf8');
			size = raw.length;

			// 解析 YAML frontmatter
			if (raw.startsWith('---\n')) {
				const end = raw.indexOf('\n---\n', 4);
				if (end > 0) {
					const fm = raw.slice(4, end);
					const descMatch = fm.match(/^description:\s*(.+)$/m);
					const nameMatch = fm.match(/^name:\s*(.+)$/m);
					if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
					if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
				}
			}

			// 没有 frontmatter.description：用正文第一段
			if (!description) {
				const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
				const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
				if (firstLine) description = firstLine.trim().slice(0, 160);
			}
		} catch { /* 读失败就用默认值 */ }
		return { name, description, size };
	}

	/** 列出工作区所有可用技能（扫描三个目录） */
	app.get('/workspaces/:id/skills', (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);

		const dirs = [
			{ path: path.join(ws.path, '.maxian', 'skills'), source: 'workspace-maxian' as const },
			{ path: path.join(ws.path, '.claude', 'skills'), source: 'workspace-claude' as const },
			{ path: path.join(os.homedir(), '.maxian', 'skills'), source: 'user-maxian' as const },
			{ path: path.join(os.homedir(), '.claude', 'skills'), source: 'user-claude' as const },
		];

		type SkillEntry = {
			name:        string;
			description: string;
			path:        string;
			source:      'workspace-maxian' | 'workspace-claude' | 'user-maxian' | 'user-claude';
			size:        number;
		};
		const seen = new Set<string>();
		const skills: SkillEntry[] = [];

		/** 在目录中查找 skill 入口：
		 *   1) 目录下直接的 .md 文件（name = basename without .md）
		 *   2) 目录下的子目录中的 SKILL.md / skill.md / README.md（name = 子目录名）
		 *  使用 statSync（跟随符号链接），符合 Claude skills 目录规范。
		 */
		function scanSkillsIn(dir: string): Array<{ name: string; abs: string }> {
			const out: Array<{ name: string; abs: string }> = [];
			let entries: string[];
			try { entries = fs.readdirSync(dir); } catch { return out; }
			for (const entry of entries) {
				const absEntry = path.join(dir, entry);
				let stat: fs.Stats;
				try { stat = fs.statSync(absEntry); } catch { continue; }  // statSync 跟随符号链接
				if (stat.isFile() && entry.endsWith('.md')) {
					out.push({ name: entry.slice(0, -3), abs: absEntry });
				} else if (stat.isDirectory()) {
					// 查找 SKILL.md / skill.md / README.md
					const candidates = ['SKILL.md', 'skill.md', 'README.md'];
					for (const c of candidates) {
						const abs = path.join(absEntry, c);
						if (fs.existsSync(abs)) {
							out.push({ name: entry, abs });
							break;
						}
					}
				}
			}
			return out;
		}

		for (const { path: dir, source } of dirs) {
			if (!fs.existsSync(dir)) continue;
			try {
				const found = scanSkillsIn(dir);
				for (const { name, abs } of found) {
					const meta = parseSkillMeta(abs);
					// 工作区级覆盖用户级（同名去重），优先使用目录名作为 name
					const finalName = meta.name || name;
					if (seen.has(finalName)) continue;
					seen.add(finalName);
					skills.push({
						name:        finalName,
						description: meta.description,
						path:        abs,
						source,
						size:        meta.size,
					});
				}
			} catch { /* 目录读不了就跳过 */ }
		}

		return c.json({
			skills,
			searchedDirs: dirs.map(d => ({ ...d, exists: fs.existsSync(d.path) })),
		});
	});

	// ─── Git Worktree 管理 ────────────────────────────────────────────────────

	/** 解析 git worktree list --porcelain 输出 */
	function parseWorktrees(output: string): Array<{ path: string; branch: string; head: string; locked: boolean }> {
		const worktrees: Array<{ path: string; branch: string; head: string; locked: boolean }> = [];
		const blocks = output.trim().split('\n\n');
		for (const block of blocks) {
			if (!block.trim()) continue;
			const lines = block.split('\n');
			const wt: { path: string; branch: string; head: string; locked: boolean } = {
				path: '', branch: '', head: '', locked: false,
			};
			for (const line of lines) {
				if (line.startsWith('worktree ')) wt.path = line.slice(9).trim();
				else if (line.startsWith('branch ')) wt.branch = line.slice(7).trim().replace('refs/heads/', '');
				else if (line.startsWith('HEAD ')) wt.head = line.slice(5, 12);
				else if (line === 'locked') wt.locked = true;
			}
			if (wt.path) worktrees.push(wt);
		}
		return worktrees;
	}

	/** 判断目录是否是 git 仓库 */
	function isGitRepo(dirPath: string): boolean {
		try {
			execSync('git rev-parse --git-dir', { cwd: dirPath, encoding: 'utf8', stdio: 'pipe' });
			return true;
		} catch {
			return false;
		}
	}

	// 列出工作区的 git worktrees
	app.get('/workspaces/:id/worktrees', (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		if (!isGitRepo(ws.path)) {
			return c.json({ worktrees: [], branches: [], isGitRepo: false });
		}
		try {
			const out = execSync('git worktree list --porcelain', { cwd: ws.path, encoding: 'utf8' });
			const worktrees = parseWorktrees(out);
			return c.json({ worktrees, isGitRepo: true });
		} catch (e) {
			return c.json({ worktrees: [], isGitRepo: true, error: String(e) });
		}
	});

	// 列出 git 分支（本地分支）
	app.get('/workspaces/:id/branches', (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		if (!isGitRepo(ws.path)) {
			return c.json({ branches: [], isGitRepo: false });
		}
		try {
			const out = execSync('git branch --format=%(refname:short)', { cwd: ws.path, encoding: 'utf8' });
			const branches = out.trim().split('\n').filter(Boolean);
			return c.json({ branches, isGitRepo: true });
		} catch (e) {
			return c.json({ branches: [], isGitRepo: true, error: String(e) });
		}
	});

	// 创建新 worktree
	app.post('/workspaces/:id/worktrees',
		zValidator('json', z.object({
			branch: z.string(),
			newBranch: z.string().optional(),  // 若提供，以新分支名创建
			worktreePath: z.string().optional(), // 若不提供，使用 <workspace>/../<branch>
		})),
		(c) => {
			const id = c.req.param('id');
			const ws = workspaceManager.list().find(w => w.id === id);
			if (!ws) return c.json({ error: 'workspace not found' }, 404);
			const { branch, newBranch, worktreePath } = c.req.valid('json');
			const wtPath = worktreePath ?? path.join(path.dirname(ws.path), newBranch ?? branch);
			try {
				const branchArg = newBranch ? `-b ${newBranch} ${branch}` : branch;
				execSync(`git worktree add "${wtPath}" ${branchArg}`, { cwd: ws.path, encoding: 'utf8' });
				return c.json({ ok: true, path: wtPath });
			} catch (e) {
				return c.json({ error: String(e) }, 500);
			}
		}
	);

	// 获取当前 git 分支
	app.get('/workspaces/:id/current-branch', (c) => {
		const id = c.req.param('id');
		const ws = workspaceManager.list().find(w => w.id === id);
		if (!ws) return c.json({ error: 'workspace not found' }, 404);
		if (!isGitRepo(ws.path)) return c.json({ branch: null, isGitRepo: false });
		try {
			const branch = execSync('git branch --show-current', { cwd: ws.path, encoding: 'utf8' }).trim();
			return c.json({ branch: branch || null, isGitRepo: true });
		} catch (e) {
			return c.json({ branch: null, isGitRepo: true, error: String(e) });
		}
	});

	// 检出 git 分支
	app.post('/workspaces/:id/checkout',
		zValidator('json', z.object({ branch: z.string() })),
		(c) => {
			const id = c.req.param('id');
			const ws = workspaceManager.list().find(w => w.id === id);
			if (!ws) return c.json({ error: 'workspace not found' }, 404);
			const { branch } = c.req.valid('json');
			try {
				execSync(`git checkout ${JSON.stringify(branch)}`, { cwd: ws.path, encoding: 'utf8' });
				return c.json({ ok: true });
			} catch (e) {
				return c.json({ error: String(e) }, 500);
			}
		}
	);

	// 删除 worktree
	app.delete('/workspaces/:id/worktrees',
		zValidator('json', z.object({ worktreePath: z.string() })),
		(c) => {
			const id = c.req.param('id');
			const ws = workspaceManager.list().find(w => w.id === id);
			if (!ws) return c.json({ error: 'workspace not found' }, 404);
			const { worktreePath } = c.req.valid('json');
			try {
				execSync(`git worktree remove "${worktreePath}" --force`, { cwd: ws.path, encoding: 'utf8' });
				return c.json({ ok: true });
			} catch (e) {
				return c.json({ error: String(e) }, 500);
			}
		}
	);

	return app;
}
