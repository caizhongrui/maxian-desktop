/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Line Numbers Utilities
 *
 *  为文件内容添加 / 移除行号前缀。用于 read_file 等工具的输出格式化。
 *  格式：`{lineNum}: {line}`（对齐 OpenCode read.ts 规范）
 *  纯函数，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

/**
 * 为内容添加行号前缀。
 *
 * @param content 原始内容
 * @param startLine 起始行号（默认 1）
 * @returns 带行号的内容
 */
export function addLineNumbers(content: string, startLine: number = 1): string {
	if (content === '') {
		return startLine === 1 ? '' : `${startLine}: \n`;
	}

	const lines = content.split('\n');
	const lastLineEmpty = lines[lines.length - 1] === '';
	if (lastLineEmpty) {
		lines.pop();
	}

	const numberedContent = lines
		.map((line, index) => `${startLine + index}: ${line}`)
		.join('\n');

	return numberedContent + '\n';
}

/**
 * 判断内容的每一行是否都有行号前缀。
 * 兼容新格式 "N: content" 和旧格式 "N | content"。
 */
export function everyLineHasLineNumbers(content: string): boolean {
	const lines = content.split(/\r?\n/);
	return lines.length > 0 && lines.every((line) =>
		/^\d+: /.test(line) || /^\s*\d+\s+\|(?!\|)/.test(line)
	);
}

/**
 * 从内容中移除行号前缀。
 *
 * @param content 带行号的内容
 * @param aggressive false（默认）= 严格匹配；true = 宽松匹配
 */
export function stripLineNumbers(content: string, aggressive: boolean = false): string {
	const lines = content.split(/\r?\n/);

	const processedLines = lines.map((line) => {
		const newFmtMatch = line.match(/^(\d+): (.*)$/);
		if (newFmtMatch) {
			return newFmtMatch[2];
		}
		const oldFmtMatch = aggressive
			? line.match(/^\s*(?:\d+\s)?\|\s(.*)$/)
			: line.match(/^\s*\d+\s+\|(?!\|)\s?(.*)$/);
		return oldFmtMatch ? oldFmtMatch[1] : line;
	});

	const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
	let result = processedLines.join(lineEnding);

	if (content.endsWith(lineEnding)) {
		if (!result.endsWith(lineEnding)) {
			result += lineEnding;
		}
	}

	return result;
}
