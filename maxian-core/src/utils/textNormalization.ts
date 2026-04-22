/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Text Normalization
 *
 *  处理弯引号、排印字符、HTML 实体等。用于编辑工具的容错匹配。
 *  纯函数，无平台依赖。
 *--------------------------------------------------------------------------------------------*/

/**
 * 常用字符映射表。
 */
export const NORMALIZATION_MAPS = {
	/** 弯引号 → 直引号 */
	SMART_QUOTES: {
		'\u201C': '"', // Left double quote
		'\u201D': '"', // Right double quote
		'\u2018': "'", // Left single quote
		'\u2019': "'", // Right single quote
	},
	/** 排印字符 → ASCII 等价物 */
	TYPOGRAPHIC: {
		'\u2026': '...', // Ellipsis
		'\u2014': '-',   // Em dash
		'\u2013': '-',   // En dash
		'\u00A0': ' ',   // Non-breaking space
	},
} as const;

/**
 * 字符串规范化选项。
 */
export interface NormalizeOptions {
	/** 替换弯引号为直引号 */
	smartQuotes?: boolean;
	/** 替换排印字符为 ASCII */
	typographicChars?: boolean;
	/** 合并多个空白字符为单个空格 */
	extraWhitespace?: boolean;
	/** 去除首尾空白 */
	trim?: boolean;
}

const DEFAULT_OPTIONS: Required<NormalizeOptions> = {
	smartQuotes: true,
	typographicChars: true,
	extraWhitespace: true,
	trim: true,
};

/**
 * 根据配置规范化字符串。
 */
export function normalizeString(str: string, options: NormalizeOptions = DEFAULT_OPTIONS): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	let normalized = str;

	if (opts.smartQuotes) {
		for (const [smart, regular] of Object.entries(NORMALIZATION_MAPS.SMART_QUOTES)) {
			normalized = normalized.replace(new RegExp(smart, 'g'), regular);
		}
	}

	if (opts.typographicChars) {
		for (const [typographic, regular] of Object.entries(NORMALIZATION_MAPS.TYPOGRAPHIC)) {
			normalized = normalized.replace(new RegExp(typographic, 'g'), regular);
		}
	}

	if (opts.extraWhitespace) {
		normalized = normalized.replace(/\s+/g, ' ');
	}

	if (opts.trim) {
		normalized = normalized.trim();
	}

	return normalized;
}

/**
 * 反转义常见 HTML 实体。
 */
export function unescapeHtmlEntities(text: string): string {
	if (!text) {
		return text;
	}

	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#91;/g, '[')
		.replace(/&#93;/g, ']')
		.replace(/&lsqb;/g, '[')
		.replace(/&rsqb;/g, ']')
		.replace(/&amp;/g, '&');
}
