/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Token Estimation
 *
 *  纯函数，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

/**
 * 统一 token 估算口径：
 * 对中文/代码混合文本，按 4 chars ≈ 1 token 估算更稳定。
 */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * 根据字符数估算 token 数量。
 * @param chars 字符总数
 * @param charsPerToken 每个 token 对应的字符数（默认 4）
 */
export function estimateTokensFromChars(
	chars: number,
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN
): number {
	const safeChars = Number.isFinite(chars) ? Math.max(0, chars) : 0;
	const safeDivisor = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
	return Math.ceil(safeChars / safeDivisor);
}

/**
 * 根据文本估算 token 数量。
 */
export function estimateTokensFromText(
	text: string,
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN
): number {
	return estimateTokensFromChars(text.length, charsPerToken);
}

/**
 * 估算字符串的 UTF-8 字节长度。
 * 中文/日文/韩文字符约 3 字节，ASCII 字符 1 字节。
 */
export function estimateByteLength(str: string): number {
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code > 0x7f) {
			bytes += 3;
		} else {
			bytes += 1;
		}
	}
	return bytes;
}
