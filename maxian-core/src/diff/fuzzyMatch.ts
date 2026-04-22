/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 模糊匹配策略
 * 参考 OpenCode tool/edit.ts 实现的 9 种容错匹配策略
 *
 * 来源参考：
 * - Cline: https://github.com/cline/cline/blob/main/evals/diff-edits/
 * - Gemini CLI: https://github.com/google-gemini/gemini-cli
 *
 * 策略按顺序尝试，直到找到匹配：
 * 1. SimpleReplacer - 精确匹配
 * 2. LineTrimmedReplacer - 行首尾空白容错
 * 3. BlockAnchorReplacer - 首尾行锚点匹配
 * 4. WhitespaceNormalizedReplacer - 空白归一化
 * 5. IndentationFlexibleReplacer - 缩进灵活匹配
 * 6. EscapeNormalizedReplacer - 转义字符处理
 * 7. TrimmedBoundaryReplacer - 边界 trim
 * 8. ContextAwareReplacer - 上下文感知
 * 9. MultiOccurrenceReplacer - 多处匹配
 */

/**
 * 匹配结果
 */
export interface MatchResult {
	/** 是否找到匹配 */
	found: boolean;
	/** 匹配的起始位置 */
	start?: number;
	/** 匹配的结束位置 */
	end?: number;
	/** 实际匹配的内容 */
	matched?: string;
	/** 使用的策略名称 */
	strategy?: string;
	/** 匹配的相似度（0-1） */
	similarity?: number;
	/** P1优化：找到多处匹配但无法唯一定位（对齐 OpenCode uniqueness check） */
	multipleMatches?: boolean;
}

/**
 * 替换器接口
 */
type Replacer = (content: string, oldString: string) => Generator<MatchResult>;

/**
 * 计算 Levenshtein 距离
 */
function levenshteinDistance(str1: string, str2: string): number {
	const m = str1.length;
	const n = str2.length;

	// 创建距离矩阵
	const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

	// 初始化
	for (let i = 0; i <= m; i++) {
		dp[i][0] = i;
	}
	for (let j = 0; j <= n; j++) {
		dp[0][j] = j;
	}

	// 填充矩阵
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (str1[i - 1] === str2[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1];
			} else {
				dp[i][j] = Math.min(
					dp[i - 1][j] + 1,     // 删除
					dp[i][j - 1] + 1,     // 插入
					dp[i - 1][j - 1] + 1  // 替换
				);
			}
		}
	}

	return dp[m][n];
}

/**
 * 计算字符串相似度（基于 Levenshtein 距离）
 */
export function stringSimilarity(str1: string, str2: string): number {
	if (str1 === str2) return 1;
	if (!str1 || !str2) return 0;

	const maxLen = Math.max(str1.length, str2.length);
	if (maxLen === 0) return 1;

	const distance = levenshteinDistance(str1, str2);
	return 1 - distance / maxLen;
}

/**
 * Levenshtein 相似度阈值
 * 参考 OpenCode edit.ts:180-181
 */
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;   // 单候选放宽
// 多候选严格阈值（暂未使用）: 0.3

// ==================== 9 种替换策略 ====================

/**
 * 1. SimpleReplacer - 精确匹配
 * P1优化：yield 所有精确匹配位置，供 findMatch() 做唯一性检查
 */
function* SimpleReplacer(content: string, oldString: string): Generator<MatchResult> {
	let searchIndex = 0;
	while (true) {
		const index = content.indexOf(oldString, searchIndex);
		if (index === -1) break;
		yield {
			found: true,
			start: index,
			end: index + oldString.length,
			matched: oldString,
			strategy: 'SimpleReplacer',
			similarity: 1.0,
		};
		searchIndex = index + oldString.length;
	}
}

/**
 * 2. LineTrimmedReplacer - 行首尾空白容错
 * 每行首尾空白可以不精确匹配
 */
function* LineTrimmedReplacer(content: string, oldString: string): Generator<MatchResult> {
	const oldLines = oldString.split('\n');
	const contentLines = content.split('\n');

	// 创建 trim 后的版本用于比较
	const oldTrimmed = oldLines.map(line => line.trim());

	for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
		let match = true;
		for (let j = 0; j < oldLines.length; j++) {
			if (contentLines[i + j].trim() !== oldTrimmed[j]) {
				match = false;
				break;
			}
		}

		if (match) {
			// 计算实际位置
			let start = 0;
			for (let k = 0; k < i; k++) {
				start += contentLines[k].length + 1; // +1 for newline
			}
			let end = start;
			for (let k = 0; k < oldLines.length; k++) {
				end += contentLines[i + k].length + (k < oldLines.length - 1 ? 1 : 0);
			}

			const matched = contentLines.slice(i, i + oldLines.length).join('\n');
			yield {
				found: true,
				start,
				end,
				matched,
				strategy: 'LineTrimmedReplacer',
				similarity: 0.95,
			};
		}
	}
}

/**
 * 3. BlockAnchorReplacer - 首尾行锚点匹配
 * 首尾行必须匹配，中间使用 Levenshtein 相似度
 */
export function* BlockAnchorReplacer(content: string, oldString: string): Generator<MatchResult> {
	const oldLines = oldString.split('\n');
	if (oldLines.length < 2) return;

	const contentLines = content.split('\n');
	const firstLine = oldLines[0].trim();
	const lastLine = oldLines[oldLines.length - 1].trim();

	for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
		// 检查首行匹配
		if (contentLines[i].trim() !== firstLine) continue;

		// 检查尾行匹配
		const endIndex = i + oldLines.length - 1;
		if (contentLines[endIndex].trim() !== lastLine) continue;

		// 计算中间部分的相似度
		const middleOld = oldLines.slice(1, -1).join('\n');
		const middleContent = contentLines.slice(i + 1, endIndex).join('\n');
		const similarity = stringSimilarity(middleOld, middleContent);

		if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
			let start = 0;
			for (let k = 0; k < i; k++) {
				start += contentLines[k].length + 1;
			}
			let end = start;
			for (let k = 0; k < oldLines.length; k++) {
				end += contentLines[i + k].length + (k < oldLines.length - 1 ? 1 : 0);
			}

			const matched = contentLines.slice(i, i + oldLines.length).join('\n');
			yield {
				found: true,
				start,
				end,
				matched,
				strategy: 'BlockAnchorReplacer',
				similarity,
			};
		}
	}
}

/**
 * 4. WhitespaceNormalizedReplacer - 空白归一化
 * 多个空白字符视为单个空格
 */
export function* WhitespaceNormalizedReplacer(content: string, oldString: string): Generator<MatchResult> {
	const normalizeWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim();

	const normalizedOld = normalizeWhitespace(oldString);
	const contentLines = content.split('\n');

	// 尝试在连续的行中找到匹配
	for (let i = 0; i < contentLines.length; i++) {
		for (let j = i; j < Math.min(i + 20, contentLines.length); j++) {
			const block = contentLines.slice(i, j + 1).join('\n');
			if (normalizeWhitespace(block) === normalizedOld) {
				let start = 0;
				for (let k = 0; k < i; k++) {
					start += contentLines[k].length + 1;
				}
				const end = start + block.length;

				yield {
					found: true,
					start,
					end,
					matched: block,
					strategy: 'WhitespaceNormalizedReplacer',
					similarity: 0.9,
				};
			}
		}
	}
}

/**
 * 5. IndentationFlexibleReplacer - 缩进灵活匹配
 * 移除最小公共缩进后比较
 */
function* IndentationFlexibleReplacer(content: string, oldString: string): Generator<MatchResult> {
	const removeMinIndent = (s: string) => {
		const lines = s.split('\n');
		const nonEmptyLines = lines.filter(l => l.trim());
		if (nonEmptyLines.length === 0) return s;

		const minIndent = Math.min(...nonEmptyLines.map(l => l.match(/^\s*/)?.[0].length || 0));
		return lines.map(l => l.substring(minIndent)).join('\n');
	};

	const normalizedOld = removeMinIndent(oldString);
	const contentLines = content.split('\n');

	for (let i = 0; i < contentLines.length; i++) {
		const oldLineCount = oldString.split('\n').length;
		for (let j = i; j < Math.min(i + oldLineCount + 5, contentLines.length); j++) {
			const block = contentLines.slice(i, j + 1).join('\n');
			if (removeMinIndent(block) === normalizedOld) {
				let start = 0;
				for (let k = 0; k < i; k++) {
					start += contentLines[k].length + 1;
				}
				const end = start + block.length;

				yield {
					found: true,
					start,
					end,
					matched: block,
					strategy: 'IndentationFlexibleReplacer',
					similarity: 0.85,
				};
			}
		}
	}
}

/**
 * 6. EscapeNormalizedReplacer - 转义字符处理
 * 处理 \n, \t, \\ 等转义字符
 */
function* EscapeNormalizedReplacer(content: string, oldString: string): Generator<MatchResult> {
	const normalizeEscapes = (s: string) => {
		return s
			.replace(/\\n/g, '\n')
			.replace(/\\t/g, '\t')
			.replace(/\\r/g, '\r')
			.replace(/\\\\/g, '\\');
	};

	const normalizedOld = normalizeEscapes(oldString);
	const index = content.indexOf(normalizedOld);

	if (index !== -1) {
		yield {
			found: true,
			start: index,
			end: index + normalizedOld.length,
			matched: normalizedOld,
			strategy: 'EscapeNormalizedReplacer',
			similarity: 0.95,
		};
	}
}

/**
 * 7. TrimmedBoundaryReplacer - 边界 trim
 * 只 trim 首尾行
 */
export function* TrimmedBoundaryReplacer(content: string, oldString: string): Generator<MatchResult> {
	const trimBoundaries = (s: string) => {
		const lines = s.split('\n');
		if (lines.length === 0) return s;
		lines[0] = lines[0].trim();
		lines[lines.length - 1] = lines[lines.length - 1].trim();
		return lines.join('\n');
	};

	const trimmedOld = trimBoundaries(oldString);
	const index = content.indexOf(trimmedOld);

	if (index !== -1) {
		yield {
			found: true,
			start: index,
			end: index + trimmedOld.length,
			matched: trimmedOld,
			strategy: 'TrimmedBoundaryReplacer',
			similarity: 0.9,
		};
	}
}

/**
 * 8. ContextAwareReplacer - 上下文感知
 * 首尾行匹配 + 50% 中间行相似度
 */
export function* ContextAwareReplacer(content: string, oldString: string): Generator<MatchResult> {
	const oldLines = oldString.split('\n');
	if (oldLines.length < 3) return;

	const contentLines = content.split('\n');
	const firstLine = oldLines[0].trim();
	const lastLine = oldLines[oldLines.length - 1].trim();

	for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
		// 首行必须匹配
		if (contentLines[i].trim() !== firstLine) continue;

		// 尾行必须匹配
		const expectedEndIndex = i + oldLines.length - 1;
		if (expectedEndIndex >= contentLines.length) continue;
		if (contentLines[expectedEndIndex].trim() !== lastLine) continue;

		// 计算中间行的相似度
		let matchedMiddleLines = 0;
		const middleOldLines = oldLines.slice(1, -1);
		const middleContentLines = contentLines.slice(i + 1, expectedEndIndex);

		for (let j = 0; j < middleOldLines.length && j < middleContentLines.length; j++) {
			if (stringSimilarity(middleOldLines[j].trim(), middleContentLines[j].trim()) > 0.8) {
				matchedMiddleLines++;
			}
		}

		const middleMatchRatio = middleOldLines.length > 0
			? matchedMiddleLines / middleOldLines.length
			: 1;

		// 50% 以上中间行匹配
		if (middleMatchRatio >= 0.5) {
			let start = 0;
			for (let k = 0; k < i; k++) {
				start += contentLines[k].length + 1;
			}
			let end = start;
			for (let k = 0; k < oldLines.length; k++) {
				end += contentLines[i + k].length + (k < oldLines.length - 1 ? 1 : 0);
			}

			const matched = contentLines.slice(i, i + oldLines.length).join('\n');
			yield {
				found: true,
				start,
				end,
				matched,
				strategy: 'ContextAwareReplacer',
				similarity: 0.5 + middleMatchRatio * 0.5,
			};
		}
	}
}

/**
 * 9. MultiOccurrenceReplacer - 多处匹配
 * 找到所有匹配位置
 */
function* MultiOccurrenceReplacer(content: string, oldString: string): Generator<MatchResult> {
	let searchIndex = 0;
	while (true) {
		const index = content.indexOf(oldString, searchIndex);
		if (index === -1) break;

		yield {
			found: true,
			start: index,
			end: index + oldString.length,
			matched: oldString,
			strategy: 'MultiOccurrenceReplacer',
			similarity: 1.0,
		};

		searchIndex = index + oldString.length;
	}
}

/**
 * 完整 9-strategy 级联（对标 OpenCode src/tool/edit.ts:636-646）
 * 顺序从严格到宽松：
 *   1. SimpleReplacer              精确匹配（最安全）
 *   2. LineTrimmedReplacer         每行去掉前后空白后匹配
 *   3. BlockAnchorReplacer         首尾行锚定 + 中间行 Levenshtein 相似度
 *   4. WhitespaceNormalizedReplacer 任意空白字符序列视为单空格
 *   5. IndentationFlexibleReplacer 移除公共缩进后比较（AI 生成代码常见）
 *   6. EscapeNormalizedReplacer    处理 \n / \t 转义字符差异
 *   7. TrimmedBoundaryReplacer     首尾多余空行容错
 *   8. ContextAwareReplacer        首尾锚 + 中间非空行 50% 相似度
 *   9. MultiOccurrenceReplacer     所有精确匹配（replaceAll 专用）
 *
 * 若前一个策略唯一匹配成功 → 直接采用；多处匹配或不匹配 → 尝试下一个。
 */
const SAFE_REPLACERS: Array<{ name: string; fn: Replacer }> = [
	{ name: 'SimpleReplacer', fn: SimpleReplacer },
	{ name: 'LineTrimmedReplacer', fn: LineTrimmedReplacer },
	{ name: 'BlockAnchorReplacer', fn: BlockAnchorReplacer },
	{ name: 'WhitespaceNormalizedReplacer', fn: WhitespaceNormalizedReplacer },
	{ name: 'IndentationFlexibleReplacer', fn: IndentationFlexibleReplacer },
	{ name: 'EscapeNormalizedReplacer', fn: EscapeNormalizedReplacer },
	{ name: 'TrimmedBoundaryReplacer', fn: TrimmedBoundaryReplacer },
	{ name: 'ContextAwareReplacer', fn: ContextAwareReplacer },
	// MultiOccurrenceReplacer 不进级联 —— replaceAll 模式专用，fuzzyReplace 单独调
];

/**
 * 使用所有策略尝试匹配
 * P1优化：对齐 OpenCode 唯一性检查 — 若某策略找到多处匹配则跳过，只使用唯一匹配
 * 所有策略均无唯一匹配时，若任意策略有多处匹配则返回 multipleMatches: true
 */
export function findMatch(content: string, oldString: string): MatchResult {
	let hasMultipleMatches = false;

	for (const { fn } of SAFE_REPLACERS) {
		// 收集该策略的所有匹配结果（最多收集 2 个以快速判断唯一性）
		const matches: MatchResult[] = [];
		for (const result of fn(content, oldString)) {
			if (result.found) {
				matches.push(result);
				if (matches.length > 1) break; // 超过 1 个匹配就不需要继续收集
			}
		}

		if (matches.length === 1) {
			// 唯一匹配 — 直接使用
			return matches[0];
		} else if (matches.length > 1) {
			// 该策略有多处匹配，记录并尝试下一个更严格的策略
			hasMultipleMatches = true;
		}
		// matches.length === 0：该策略无匹配，继续下一个策略
	}

	// B1: 弯引号/直引号归一化容错（Claude Code 三层容错之一）
	// AI 输出 "string"（弯引号），文件实际是 "string"（直引号）时，精确匹配失败
	const normalizedOldString = normalizeCurlyQuotes(oldString);
	if (normalizedOldString !== oldString) {
		for (const { fn } of SAFE_REPLACERS) {
			const matches: MatchResult[] = [];
			for (const result of fn(content, normalizedOldString)) {
				if (result.found) {
					matches.push(result);
					if (matches.length > 1) break;
				}
			}
			if (matches.length === 1) {
				return { ...matches[0], strategy: (matches[0].strategy || '') + '+CurlyQuoteNorm' };
			} else if (matches.length > 1) {
				hasMultipleMatches = true;
			}
		}
	}

	// B2: API Desanitization 容错（Anthropic API 传输时缩写某些标签）
	// <function_results> → <fnr>，<function_calls> → <fn> 等
	const desanitizedOldString = desanitizeApiTags(oldString);
	if (desanitizedOldString !== oldString) {
		for (const { fn } of SAFE_REPLACERS) {
			const matches: MatchResult[] = [];
			for (const result of fn(content, desanitizedOldString)) {
				if (result.found) {
					matches.push(result);
					if (matches.length > 1) break;
				}
			}
			if (matches.length === 1) {
				return { ...matches[0], strategy: (matches[0].strategy || '') + '+Desanitize' };
			} else if (matches.length > 1) {
				hasMultipleMatches = true;
			}
		}
	}

	if (hasMultipleMatches) {
		return { found: false, multipleMatches: true };
	}

	return { found: false };
}

/**
 * B1: 弯引号归一化 — 将 AI 输出的智能引号替换为直引号（ASCII）
 * AI 常输出 "text" 或 'text'，但文件中是 "text" 或 'text'
 */
function normalizeCurlyQuotes(text: string): string {
	return text
		.replace(/[\u201C\u201D]/g, '"')   // " " → "
		.replace(/[\u2018\u2019]/g, "'")   // ' ' → '
		.replace(/[\u00AB\u00BB]/g, '"');  // « » → "
}

/**
 * B2: API Desanitization — 还原 Anthropic API 传输时对 XML 标签的缩写
 * API 会将某些标签缩短以节省空间，AI 看到缩写版本，但文件里是原始版本
 */
function desanitizeApiTags(text: string): string {
	return text
		.replace(/<fnr>/g, '<function_results>')
		.replace(/<\/fnr>/g, '</function_results>')
		.replace(/<fn>/g, '<function_calls>')
		.replace(/<\/fn>/g, '</function_calls>')
		.replace(/<fc>/g, '<function_calls>')
		.replace(/<\/fc>/g, '</function_calls>');
}

/**
 * 检测 old_string 与文件内容之间的空白风格不一致（tab vs space）
 */
function detectWhitespaceMismatch(content: string, oldString: string): string | null {
	const oldHasTab = /^[\t]+/m.test(oldString);
	const oldHasSpaceIndent = /^ {2,}/m.test(oldString);
	const fileHasTab = /^[\t]+/m.test(content);
	const fileHasSpaceIndent = /^ {2,}/m.test(content);

	if (oldHasTab && !fileHasTab && fileHasSpaceIndent) {
		return '[whitespace mismatch: old_string uses TAB but file uses SPACES]';
	}
	if (oldHasSpaceIndent && !fileHasSpaceIndent && fileHasTab) {
		return '[whitespace mismatch: old_string uses SPACES but file uses TAB]';
	}
	return null;
}

/**
 * 在文件中查找与 old_string 最相似的 N 个片段，用于失败时的结构化反馈
 * 参考 Claude Code / OpenCode 的候选建议机制
 */
export function findTopSimilarSnippets(
	content: string,
	oldString: string,
	topN: number = 3
): Array<{ startLine: number; endLine: number; snippet: string; similarity: number }> {
	const contentLines = content.split('\n');
	const oldLines = oldString.split('\n');
	const windowSize = oldLines.length;

	if (windowSize === 0 || contentLines.length === 0) {
		return [];
	}

	const candidates: Array<{ startLine: number; endLine: number; snippet: string; similarity: number }> = [];
	const step = Math.max(1, Math.floor(windowSize / 2));

	// 计算 old 的 token 集合（去重），用于快速粗筛
	const oldNormalized = oldString.trim();

	for (let i = 0; i <= Math.max(0, contentLines.length - windowSize); i += step) {
		const windowLines = contentLines.slice(i, i + windowSize);
		const windowText = windowLines.join('\n');
		const sim = stringSimilarity(windowText.trim(), oldNormalized);
		if (sim > 0.2) {
			candidates.push({
				startLine: i + 1,
				endLine: i + windowLines.length,
				snippet: windowText,
				similarity: sim,
			});
		}
	}

	// 按相似度降序
	candidates.sort((a, b) => b.similarity - a.similarity);

	// 去重：相近 startLine 的候选只保留最高分
	const dedup: typeof candidates = [];
	for (const c of candidates) {
		if (dedup.every(d => Math.abs(d.startLine - c.startLine) > windowSize)) {
			dedup.push(c);
			if (dedup.length >= topN) break;
		}
	}

	return dedup;
}

/**
 * 构造结构化失败信息：展示 top N 相似片段 + 上下文 + 相似度
 */
function buildStructuredFailure(
	content: string,
	oldString: string
): string {
	const contentLines = content.split('\n');
	const snippets = findTopSimilarSnippets(content, oldString, 3);
	const parts: string[] = [];

	parts.push('oldString not found in content.');

	const wsHint = detectWhitespaceMismatch(content, oldString);
	if (wsHint) {
		parts.push(wsHint);
	}

	if (snippets.length > 0) {
		parts.push('');
		parts.push('与 old_string 最相似的候选片段（按相似度降序）：');
		snippets.forEach((s, idx) => {
			const ctxStart = Math.max(1, s.startLine - 3);
			const ctxEnd = Math.min(contentLines.length, s.endLine + 3);
			const contextLines: string[] = [];
			for (let ln = ctxStart; ln <= ctxEnd; ln++) {
				const marker = (ln >= s.startLine && ln <= s.endLine) ? '>' : ' ';
				contextLines.push(`${marker} ${ln.toString().padStart(5)} | ${contentLines[ln - 1] ?? ''}`);
			}
			parts.push('');
			parts.push(`候选 ${idx + 1} — 行 ${s.startLine}-${s.endLine}，相似度 ${(s.similarity * 100).toFixed(1)}%`);
			parts.push(contextLines.join('\n'));
		});
		parts.push('');
		parts.push('请根据以上上下文重新构造 old_string（注意空白/缩进），或扩大匹配窗口后重试。');
	} else {
		parts.push('');
		parts.push('未在文件中找到与 old_string 相似的片段。请先 read_file 确认目标内容是否存在。');
	}

	return parts.join('\n');
}

/**
 * 使用容错匹配执行替换
 * P1优化：返回 error 字段，报告多处匹配错误（对齐 OpenCode "Found multiple matches"）
 */
export function fuzzyReplace(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean = false
): { success: boolean; result: string; strategy?: string; matchCount: number; error?: string; warning?: string } {
	if (replaceAll) {
		// replaceAll 模式：使用 MultiOccurrenceReplacer 找到所有精确匹配
		const exactMatches: MatchResult[] = [];
		for (const result of MultiOccurrenceReplacer(content, oldString)) {
			if (result.found) {
				exactMatches.push(result);
			}
		}

		if (exactMatches.length === 0) {
			// 精确匹配无结果，尝试容错匹配（找唯一匹配替换一次）
			const match = findMatch(content, oldString);
			if (!match.found) {
				if (match.multipleMatches) {
					return {
						success: false, result: content, matchCount: 0,
						error: `找到多处匹配 "${oldString.substring(0, 50)}"，无法确定唯一替换位置。请提供更精确的上下文。`
					};
				}
				return {
					success: false, result: content, matchCount: 0,
					error: buildStructuredFailure(content, oldString),
				};
			}
			const result = content.substring(0, match.start!) + newString + content.substring(match.end!);
			const warning = match.strategy && match.strategy !== 'SimpleReplacer'
				? `[fuzzy matched: strategy=${match.strategy}]`
				: undefined;
			return { success: true, result, strategy: match.strategy, matchCount: 1, warning };
		}

		// 从后向前替换（避免位置偏移）
		let result = content;
		for (let i = exactMatches.length - 1; i >= 0; i--) {
			const m = exactMatches[i];
			result = result.substring(0, m.start!) + newString + result.substring(m.end!);
		}

		return { success: true, result, strategy: 'MultiOccurrenceReplacer', matchCount: exactMatches.length };
	}

	// 单次替换：使用唯一性检查
	const match = findMatch(content, oldString);
	if (!match.found) {
		if (match.multipleMatches) {
			// P1优化：对齐 OpenCode "Found multiple matches" 错误
			return {
				success: false, result: content, matchCount: 0,
				error: `找到多处匹配 "${oldString.substring(0, 50)}"，无法确定唯一替换位置。\n请在 old_string 中提供更多上下文（如包含更多行），以唯一定位替换位置。`
			};
		}
		return {
			success: false, result: content, matchCount: 0,
			error: buildStructuredFailure(content, oldString),
		};
	}

	const result = content.substring(0, match.start!) + newString + content.substring(match.end!);
	const warning = match.strategy && match.strategy !== 'SimpleReplacer'
		? `[fuzzy matched: strategy=${match.strategy}]`
		: undefined;
	return { success: true, result, strategy: match.strategy, matchCount: 1, warning };
}

/**
 * 导出策略名称列表
 */
export const FUZZY_MATCH_STRATEGIES = SAFE_REPLACERS.map(r => r.name);
