/*---------------------------------------------------------------------------------------------
 *  Maxian Server — Context Compaction
 *
 *  对话历史压缩：在接近模型上下文窗口上限时，分两级收缩 API history，
 *  保证后续对话不触发上下文溢出错误。
 *
 *  目标模型：1M tokens 上下文窗口。阈值：
 *    - LEVEL 1（按类型剪枝）：> 600K tokens (60%)
 *    - LEVEL 2（LLM 总结）：> 850K tokens (85%) 且 Level 1 节省不足
 *    - 硬上限预留：最多使用 900K，给响应流留 100K
 *
 *  缓存友好设计：
 *    - 压缩点**靠前**（保留最近 RECENT_KEEP_ROUNDS 轮不动）
 *    - 一次压缩大手笔（不零散）→ 前缀稳定 → 后续命中缓存
 *    - 系统提示 + 工具定义绝对稳定（cli.ts 保证）
 *--------------------------------------------------------------------------------------------*/

import type { MessageParam, ContentBlock } from '@maxian/core/api';
import { AiProxyHandler } from '@maxian/core/api/aiproxy';

// ─── 阈值配置 ─────────────────────────────────────────────────────────
//
// 默认目标：128K 上下文（Qwen-plus / GPT-4o / Claude Sonnet 标准）
// 大于这个的模型通过环境变量调整：
//   MAXIAN_CONTEXT_WINDOW=1000000       （比如 Claude 1M context）
//   MAXIAN_COMPACT_L1_THRESHOLD=600000
//   MAXIAN_COMPACT_L2_THRESHOLD=850000
//
// 阈值意义：
//   L1（按类型剪枝）：~55% → 早剪防止上下文过大导致 AI 注意力涣散
//   L2（LLM 总结）：~85% 且 L1 不够 → 激进压缩
//   硬上限保留：~92% 给响应流（~8%）
const parseIntEnv = (key: string, defaultVal: number): number => {
	const v = process.env[key];
	if (!v) return defaultVal;
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : defaultVal;
};

export const CONTEXT_WINDOW       = parseIntEnv('MAXIAN_CONTEXT_WINDOW',       128_000);
export const COMPACT_L1_THRESHOLD = parseIntEnv('MAXIAN_COMPACT_L1_THRESHOLD', Math.floor(CONTEXT_WINDOW * 0.55));
export const COMPACT_L2_THRESHOLD = parseIntEnv('MAXIAN_COMPACT_L2_THRESHOLD', Math.floor(CONTEXT_WINDOW * 0.85));
export const RESERVED_OUTPUT      = Math.floor(CONTEXT_WINDOW * 0.08);
export const RECENT_KEEP_ROUNDS   = 5;         // 最近多少"用户-助手"对不动

console.log(
	`[Compaction] 阈值配置：窗口 ${CONTEXT_WINDOW.toLocaleString()} | ` +
	`L1 剪枝 ${COMPACT_L1_THRESHOLD.toLocaleString()} | ` +
	`L2 总结 ${COMPACT_L2_THRESHOLD.toLocaleString()} | ` +
	`响应预留 ${RESERVED_OUTPUT.toLocaleString()} tokens`
);

// ─── 按工具类型的保留策略 ──────────────────────────────────────────────
/**
 * 每种工具最近 N 次保留全文，更早的替换为占位符。
 * -1 表示永久保留全部（edit/write/apply_patch/load_skill/question/plan_exit）
 *  0 表示只保留最新一次（todo_write）
 *  正数表示最近 N 次保留全文
 */
const TOOL_KEEP_POLICY: Record<string, number> = {
	// 文件修改类：全部保留（修改轨迹是关键上下文）
	edit:          -1,
	write_to_file: -1,
	multiedit:     -1,
	apply_patch:   -1,
	// 技能 + 交互：全部保留
	load_skill:    -1,
	question:      -1,
	plan_exit:     -1,
	// 文件阅读：最近 3 次
	read_file:     3,
	// 执行命令：最近 2 次
	bash:             2,
	execute_command:  2,
	// 搜索 / 列表：最近 1 次
	grep:         1,
	search_files: 1,
	glob:         1,
	ls:           1,
	list_files:   1,
	web_fetch:    1,
	websearch:    1,
	codesearch:   1,
	lsp:          1,
	// todo：只保留最新一次
	todo_write:   0,
	update_todo_list: 0,
	// 未知工具默认：最近 2 次
};
const TOOL_KEEP_DEFAULT = 2;

/** 估算一段 string/JSON 内容的 token 数（粗略 ~4 chars/token） */
export function estimateTokens(content: unknown): number {
	if (content == null) return 0;
	const str = typeof content === 'string' ? content : JSON.stringify(content);
	return Math.ceil(str.length / 4);
}

/** 估算整个 history 的 token 数（含 system prompt 估算） */
export function estimateHistoryTokens(
	history:       MessageParam[],
	systemPromptLen = 0,
): number {
	let total = Math.ceil(systemPromptLen / 4);
	for (const msg of history) {
		if (typeof msg.content === 'string') {
			total += estimateTokens(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content as ContentBlock[]) {
				if ((block as any).type === 'text') {
					total += estimateTokens((block as any).text);
				} else if ((block as any).type === 'tool_use') {
					total += estimateTokens((block as any).input);
					total += estimateTokens((block as any).name);
				} else if ((block as any).type === 'tool_result') {
					total += estimateTokens((block as any).content);
				} else if ((block as any).type === 'image') {
					total += 1000;   // 图片粗估 1K token
				}
			}
		}
	}
	return total;
}

/** 获取工具结果应保留的最近次数 */
function getKeepCount(toolName: string): number {
	return TOOL_KEEP_POLICY[toolName] !== undefined
		? TOOL_KEEP_POLICY[toolName]
		: TOOL_KEEP_DEFAULT;
}

/**
 * 从工具参数中提取关键摘要（让 AI 在占位符里仍能认出"这是干什么的那次"）
 * 对每种工具给出最有辨识度的字段（path / command / pattern 等）
 */
function summarizeToolInput(toolName: string, input: unknown): string {
	if (!input || typeof input !== 'object') return '';
	const inp = input as Record<string, any>;
	const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
	switch (toolName) {
		case 'read_file':
		case 'write_to_file':
		case 'edit':
		case 'multiedit':
		case 'apply_patch':
		case 'list_files':
		case 'ls':
			return inp.path ? `path=${truncate(String(inp.path), 80)}` : '';
		case 'bash':
		case 'execute_command':
			return inp.command ? `cmd=${truncate(String(inp.command), 80)}` : '';
		case 'grep':
		case 'search_files':
			return [
				inp.pattern ? `pattern=${truncate(String(inp.pattern), 40)}` : '',
				inp.path ? `path=${truncate(String(inp.path), 40)}` : '',
			].filter(Boolean).join(' ');
		case 'glob':
			return inp.pattern ? `pattern=${truncate(String(inp.pattern), 60)}` : '';
		case 'web_fetch':
			return inp.url ? `url=${truncate(String(inp.url), 60)}` : '';
		case 'lsp':
			return inp.operation ? `op=${String(inp.operation)}${inp.file ? ` file=${truncate(String(inp.file), 40)}` : ''}` : '';
		case 'load_skill':
			return inp.skill_name ? `skill=${String(inp.skill_name)}` : '';
		case 'todo_write':
			return Array.isArray(inp.todos) ? `${inp.todos.length} 条` : '';
		case 'task':
			return inp.subagentType ? `type=${String(inp.subagentType)}` : '';
		default:
			return '';
	}
}

/**
 * 从 tool_result 内容中提取首尾行（判断成功/失败 + 主要结论）
 * 如果结果较短直接全保留；较长则取前 N 字 + 后 M 字
 */
function summarizeToolResult(result: string, maxChars: number = 200): string {
	if (!result) return '';
	if (result.length <= maxChars) return result;
	const head = result.slice(0, Math.floor(maxChars * 0.6));
	const tail = result.slice(-Math.floor(maxChars * 0.4));
	return `${head}\n... [中间 ${result.length - maxChars} 字省略] ...\n${tail}`;
}

/**
 * 生成精细化工具结果占位符（F 阶段升级）：
 *   旧：[已清理：edit 第 3/5 次调用的结果（约 1200 字）]
 *   新：[已清理 edit 第 3/5 次 | path=src/foo.ts | 结果摘要：Successfully edited ...]
 *
 * 保留工具名 + 序号 + 关键参数 + 结果首尾 → AI 切换上下文后仍能判断之前做过什么
 */
function makePlaceholder(
	toolName: string,
	idx: number,
	total: number,
	toolInput: unknown,
	origResult: string,
): string {
	const paramSummary = summarizeToolInput(toolName, toolInput);
	const resultSummary = summarizeToolResult(origResult, 200);
	const parts = [
		`已清理 ${toolName} 第 ${idx + 1}/${total} 次`,
		paramSummary,
	].filter(Boolean).join(' | ');
	return `[${parts}]\n结果摘要（原 ${origResult.length} 字）：${resultSummary}`;
}

// ─── Level 1：按类型剪枝 ─────────────────────────────────────────────────

export interface PruneResult {
	compactedHistory: MessageParam[];
	tokensBefore:     number;
	tokensAfter:      number;
	prunedToolCalls:  number;
	boundary:         number;   // 压缩应用的消息索引（后面这些不动）
}

/**
 * 按工具类型剪枝：从头扫到"最近 RECENT_KEEP_ROUNDS 轮的起点"之前，
 * 对每种工具统计出现次数，老的工具结果按 TOOL_KEEP_POLICY 替换为占位符。
 * 不改变 tool_use / tool_result 配对结构。
 */
export function pruneByToolType(
	history:         MessageParam[],
	systemPromptLen: number,
): PruneResult {
	const tokensBefore = estimateHistoryTokens(history, systemPromptLen);

	// 先找到"最近 N 轮"的起点索引（不动点）
	let userMsgIdx: number[] = [];
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === 'user' && !isToolResultMessage(history[i])) {
			userMsgIdx.push(i);
			if (userMsgIdx.length >= RECENT_KEEP_ROUNDS) break;
		}
	}
	// boundary 是最近 N 轮中最老那轮的起点；再往前就是可压缩区
	const boundary = userMsgIdx.length > 0 ? userMsgIdx[userMsgIdx.length - 1] : history.length;

	// 预扫描：为每个 tool_use_id 记录它出现的顺序和工具名
	interface ToolEntry { msgIdx: number; blockIdx: number; toolName: string; toolUseId: string }
	const allToolUses: ToolEntry[] = [];
	for (let i = 0; i < history.length; i++) {
		const msg = history[i];
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
		for (let j = 0; j < msg.content.length; j++) {
			const block = msg.content[j] as any;
			if (block.type === 'tool_use') {
				allToolUses.push({
					msgIdx: i, blockIdx: j,
					toolName: String(block.name ?? 'unknown'),
					toolUseId: String(block.id ?? ''),
				});
			}
		}
	}

	// 按工具名分组
	const byTool = new Map<string, ToolEntry[]>();
	for (const e of allToolUses) {
		if (!byTool.has(e.toolName)) byTool.set(e.toolName, []);
		byTool.get(e.toolName)!.push(e);
	}

	// 对每种工具，标记哪些 tool_use_id 的 result 可以被替换
	const toPrune = new Set<string>();  // tool_use_id set
	for (const [toolName, entries] of byTool) {
		const keep = getKeepCount(toolName);
		if (keep === -1) continue;  // 全保留
		const total = entries.length;
		// 只剪 boundary 之前的
		const compactable = entries.filter(e => e.msgIdx < boundary);
		const keepFrom    = total - keep;   // 最后 keep 个保留
		for (const e of compactable) {
			// 计算这是第几次出现（从 0 开始）
			const rank = entries.indexOf(e);
			if (rank < keepFrom) {
				toPrune.add(e.toolUseId);
			}
		}
	}

	// 克隆 history 并替换 tool_result 内容
	let prunedCount = 0;
	const compactedHistory = history.map((msg, msgIdx) => {
		if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
		// user 消息的 content 如果是 tool_result 数组
		const newContent: ContentBlock[] = (msg.content as ContentBlock[]).map((block: any) => {
			if (block.type !== 'tool_result') return block;
			if (!toPrune.has(block.tool_use_id)) return block;

			// 计算占位符（F：保留工具名 + 序号 + 参数摘要 + 结果首尾）
			const toolEntry = allToolUses.find(e => e.toolUseId === block.tool_use_id);
			const toolName = toolEntry?.toolName ?? 'unknown';
			const toolInstances = byTool.get(toolName) ?? [];
			const rank = toolInstances.findIndex(e => e.toolUseId === block.tool_use_id);
			// 取原 tool_use 的 input（保留参数上下文）
			let toolInput: unknown = undefined;
			if (toolEntry) {
				const uMsg = history[toolEntry.msgIdx];
				if (uMsg && Array.isArray(uMsg.content)) {
					const ub: any = (uMsg.content as any[])[toolEntry.blockIdx];
					toolInput = ub?.input;
				}
			}
			const origResult = typeof block.content === 'string'
				? block.content
				: JSON.stringify(block.content);
			prunedCount++;
			return {
				...block,
				content: makePlaceholder(toolName, rank, toolInstances.length, toolInput, origResult),
			};
		});
		return { ...msg, content: newContent };
	});

	const tokensAfter = estimateHistoryTokens(compactedHistory, systemPromptLen);
	return {
		compactedHistory,
		tokensBefore,
		tokensAfter,
		prunedToolCalls: prunedCount,
		boundary,
	};
}

function isToolResultMessage(msg: MessageParam): boolean {
	if (msg.role !== 'user' || !Array.isArray(msg.content)) return false;
	const arr = msg.content as any[];
	return arr.length > 0 && arr.every(b => b?.type === 'tool_result');
}

// ─── Level 2：LLM 总结 ───────────────────────────────────────────────────

export interface SummarizeResult {
	compactedHistory: MessageParam[];
	tokensBefore:     number;
	tokensAfter:      number;
	summarizedCount:  number;
	summary:          string;
}

const SUMMARIZE_PROMPT = `你是对话历史压缩助手。下面的对话已经接近上下文上限，需要把**老的**部分总结成一段结构化概要，后续助手能仅凭这段概要 + 最近几轮原文继续工作。

**必须按这个模板输出**：

## 目标
（用户最终要达成什么）

## 关键约束 / 规则
（不能违反的硬性要求、技术栈、代码规范）

## 发现
（通过 read_file / grep 等发现的重要代码结构、文件位置、已知 bug、架构约定）

## 已完成
- 文件 A：做了什么修改
- 文件 B：做了什么修改

## 进行中
（还没完成但已经开始的工作）

## 待做
（用户期望但还没开始的）

## 触碰文件
\`\`\`
path/to/a.ts
path/to/b.css
...
\`\`\`

---

**硬性要求**：
- **简体中文**
- 不超过 2000 字
- 不要重复原文本
- 不要描述你自己在做什么（第一人称视角）
- 代码、路径、命令保持原样不翻译`;

/**
 * 调用 LLM 总结 boundary 之前的消息，返回一条 assistant 总结消息 + 保留 boundary 之后的原样历史。
 */
export async function summarizeOldHistory(
	history:          MessageParam[],
	boundary:         number,
	systemPromptLen:  number,
	handler:          AiProxyHandler,
): Promise<SummarizeResult> {
	const tokensBefore = estimateHistoryTokens(history, systemPromptLen);
	const oldPart = history.slice(0, boundary);
	const newPart = history.slice(boundary);

	if (oldPart.length === 0) {
		return {
			compactedHistory: history,
			tokensBefore, tokensAfter: tokensBefore,
			summarizedCount: 0, summary: '',
		};
	}

	// 把 oldPart 序列化成文本作为输入
	const serialized = serializeHistoryForSummary(oldPart);

	// 调用 LLM（不带工具）
	let summary = '';
	try {
		for await (const chunk of handler.createMessage(SUMMARIZE_PROMPT, [
			{ role: 'user', content: serialized },
		], undefined)) {
			if (chunk.type === 'text') summary += chunk.text;
			else if (chunk.type === 'error') throw new Error(chunk.error);
		}
	} catch (e) {
		// 总结失败：回退到简单占位
		summary = `[上下文压缩失败，保留占位：此处原有 ${oldPart.length} 条消息被省略。错误：${(e as Error).message}]`;
	}

	// 构造压缩后的历史：一条 user（伪装摘要请求） + 一条 assistant（摘要内容） + newPart
	const compactedHistory: MessageParam[] = [
		{
			role:    'user',
			content: '[系统自动压缩：请根据下文摘要继续对话]',
		},
		{
			role:    'assistant',
			content: `[会话上下文已压缩，以下是前文摘要]\n\n${summary}`,
		},
		...newPart,
	];

	const tokensAfter = estimateHistoryTokens(compactedHistory, systemPromptLen);
	return {
		compactedHistory,
		tokensBefore,
		tokensAfter,
		summarizedCount: oldPart.length,
		summary,
	};
}

/** 把一段 MessageParam[] 序列化为可读文本（供 LLM 总结输入） */
function serializeHistoryForSummary(msgs: MessageParam[]): string {
	const parts: string[] = ['# 历史对话（待总结）\n'];
	for (const msg of msgs) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				parts.push(`## 用户\n${msg.content}\n`);
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content as any[]) {
					if (block.type === 'tool_result') {
						const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
						parts.push(`## 工具结果 (${block.tool_use_id?.slice(0, 8) ?? ''})\n${content.slice(0, 1500)}${content.length > 1500 ? '\n…[截断]' : ''}\n`);
					} else if (block.type === 'text') {
						parts.push(`## 用户\n${block.text}\n`);
					}
				}
			}
		} else if (msg.role === 'assistant') {
			if (typeof msg.content === 'string') {
				parts.push(`## 助手\n${msg.content}\n`);
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content as any[]) {
					if (block.type === 'text') {
						parts.push(`## 助手\n${block.text}\n`);
					} else if (block.type === 'tool_use') {
						const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
						parts.push(`## 助手调用工具: ${block.name}\n${input.slice(0, 500)}${input.length > 500 ? '…' : ''}\n`);
					}
				}
			}
		}
	}
	return parts.join('\n');
}

// ─── 组合入口：按阈值自动选择压缩级别 ────────────────────────────────────

export interface CompactionReport {
	level:          0 | 1 | 2;   // 0 = 没压缩；1 = Level 1；2 = Level 2
	tokensBefore:   number;
	tokensAfter:    number;
	prunedTools:    number;
	summarizedMsgs: number;
	summary?:       string;
	compactedHistory: MessageParam[];
}

export async function compactIfNeeded(
	history:         MessageParam[],
	systemPromptLen: number,
	handler:         AiProxyHandler | null,
): Promise<CompactionReport> {
	const tokens = estimateHistoryTokens(history, systemPromptLen);

	// 未达 Level 1：不压缩
	if (tokens < COMPACT_L1_THRESHOLD) {
		return {
			level: 0, tokensBefore: tokens, tokensAfter: tokens,
			prunedTools: 0, summarizedMsgs: 0,
			compactedHistory: history,
		};
	}

	// Level 1: 按类型剪枝
	const pruneResult = pruneByToolType(history, systemPromptLen);

	// 若剪枝后仍超过 L2 阈值，且有 handler 可用 → 走 Level 2
	if (pruneResult.tokensAfter >= COMPACT_L2_THRESHOLD && handler) {
		const sumResult = await summarizeOldHistory(
			pruneResult.compactedHistory,
			pruneResult.boundary,
			systemPromptLen,
			handler,
		);
		return {
			level: 2,
			tokensBefore: pruneResult.tokensBefore,
			tokensAfter:  sumResult.tokensAfter,
			prunedTools:  pruneResult.prunedToolCalls,
			summarizedMsgs: sumResult.summarizedCount,
			summary:        sumResult.summary,
			compactedHistory: sumResult.compactedHistory,
		};
	}

	return {
		level: 1,
		tokensBefore: pruneResult.tokensBefore,
		tokensAfter:  pruneResult.tokensAfter,
		prunedTools:  pruneResult.prunedToolCalls,
		summarizedMsgs: 0,
		compactedHistory: pruneResult.compactedHistory,
	};
}

/** 手动触发（/compact 命令）：强制走 Level 2（若有 handler）*/
export async function forceCompact(
	history:         MessageParam[],
	systemPromptLen: number,
	handler:         AiProxyHandler | null,
): Promise<CompactionReport> {
	// 先按类型剪
	const pruneResult = pruneByToolType(history, systemPromptLen);
	// 再强制总结
	if (handler && pruneResult.boundary > 0) {
		const sumResult = await summarizeOldHistory(
			pruneResult.compactedHistory,
			pruneResult.boundary,
			systemPromptLen,
			handler,
		);
		return {
			level: 2,
			tokensBefore: pruneResult.tokensBefore,
			tokensAfter:  sumResult.tokensAfter,
			prunedTools:  pruneResult.prunedToolCalls,
			summarizedMsgs: sumResult.summarizedCount,
			summary:        sumResult.summary,
			compactedHistory: sumResult.compactedHistory,
		};
	}
	return {
		level: 1,
		tokensBefore: pruneResult.tokensBefore,
		tokensAfter:  pruneResult.tokensAfter,
		prunedTools:  pruneResult.prunedToolCalls,
		summarizedMsgs: 0,
		compactedHistory: pruneResult.compactedHistory,
	};
}
