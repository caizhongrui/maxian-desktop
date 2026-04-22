/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Levenshtein Distance
 *
 *  计算两字符串之间的编辑距离，用于编辑工具的容错匹配。
 *  纯函数，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

/**
 * 计算两字符串之间的 Levenshtein 距离。
 * Levenshtein 距离 = 将 str1 改为 str2 所需的最小单字符编辑次数（插入、删除、替换）。
 */
export function distance(str1: string, str2: string): number {
	const len1 = str1.length;
	const len2 = str2.length;

	if (len1 === 0) {
		return len2;
	}
	if (len2 === 0) {
		return len1;
	}

	// 只保留两行，降低空间复杂度到 O(min(len1, len2))
	let prevRow = new Array(len2 + 1);
	let currRow = new Array(len2 + 1);

	for (let j = 0; j <= len2; j++) {
		prevRow[j] = j;
	}

	for (let i = 1; i <= len1; i++) {
		currRow[0] = i;

		for (let j = 1; j <= len2; j++) {
			const substitutionCost = str1[i - 1] === str2[j - 1] ? 0 : 1;
			const deletion = prevRow[j] + 1;
			const insertion = currRow[j - 1] + 1;
			const substitution = prevRow[j - 1] + substitutionCost;

			currRow[j] = Math.min(deletion, insertion, substitution);
		}

		[prevRow, currRow] = [currRow, prevRow];
	}

	return prevRow[len2];
}

/**
 * 计算两字符串的相似度（0~1）。
 * 1 = 完全相同，0 = 完全不同。
 */
export function similarity(str1: string, str2: string): number {
	const maxLength = Math.max(str1.length, str2.length);
	if (maxLength === 0) {
		return 1;
	}

	const dist = distance(str1, str2);
	return 1 - dist / maxLength;
}
