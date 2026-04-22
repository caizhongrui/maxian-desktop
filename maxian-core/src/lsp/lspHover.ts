/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * LSP Hover 集成
 *
 * 功能：
 * - 获取符号的类型信息
 * - 获取函数/方法的签名
 * - 获取文档注释
 * - 帮助AI理解代码定义
 */

// @ts-ignore — IDE side uses createDecorator via VSCode IoC
export const ILspHoverService = (null as any) // createDecorator<ILspHoverService>('lspHoverService');

/**
 * Hover内容信息
 */
export interface HoverContent {
	/** 内容文本（Markdown格式） */
	value: string;
	/** 是否为可信内容 */
	isTrusted?: boolean;
	/** 是否支持命令 */
	supportHtml?: boolean;
}

/**
 * 位置范围
 */
export interface HoverRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

/**
 * Hover信息
 */
export interface HoverInfo {
	/** Hover内容列表 */
	contents: HoverContent[];
	/** Hover范围 */
	range?: HoverRange;
}

/**
 * LSP Hover 服务接口
 */
export interface ILspHoverService {
	readonly _serviceBrand: undefined;

	/**
	 * 获取指定位置的Hover信息
	 * @param filePath 文件路径
	 * @param line 行号（从1开始）
	 * @param column 列号（从1开始）
	 */
	getHover(filePath: string, line: number, column: number): Promise<HoverInfo | null>;
}

/**
 * 格式化Hover内容为文本
 * @param hover Hover信息
 * @param filePath 文件路径
 * @param line 行号
 * @param column 列号
 */
export function formatHoverInfo(
	hover: HoverInfo,
	filePath: string,
	line: number,
	column: number
): string {
	const lines: string[] = [
		`<hover_info path="${filePath}" line="${line}" column="${column}">`,
	];

	// 添加所有内容
	for (const content of hover.contents) {
		// 移除Markdown代码块标记，提取纯文本
		let text = content.value;

		// 处理Markdown代码块
		const codeBlockMatch = text.match(/^```(\w+)?\n([\s\S]*?)\n```$/);
		if (codeBlockMatch) {
			const language = codeBlockMatch[1] || '';
			const code = codeBlockMatch[2];
			lines.push(`\`\`\`${language}`);
			lines.push(code);
			lines.push('```');
		} else {
			lines.push(text);
		}

		lines.push('');
	}

	// 如果有范围信息，添加范围说明
	if (hover.range) {
		const r = hover.range;
		if (r.startLine === r.endLine && r.startColumn === r.endColumn) {
			lines.push(`位置: 第 ${r.startLine} 行，第 ${r.startColumn} 列`);
		} else if (r.startLine === r.endLine) {
			lines.push(`范围: 第 ${r.startLine} 行，第 ${r.startColumn}-${r.endColumn} 列`);
		} else {
			lines.push(`范围: 第 ${r.startLine} 行第 ${r.startColumn} 列 - 第 ${r.endLine} 行第 ${r.endColumn} 列`);
		}
	}

	lines.push('</hover_info>');

	return lines.join('\n');
}

/**
 * LSP Hover 处理器
 */
export class LspHoverHandler {
	constructor(private service?: ILspHoverService) {}

	/**
	 * 设置 LSP 服务
	 */
	setService(service: ILspHoverService): void {
		this.service = service;
	}

	/**
	 * 获取Hover信息
	 * @param filePath 文件路径
	 * @param line 行号（从1开始）
	 * @param column 列号（从1开始）
	 */
	async getHover(filePath: string, line: number, column: number): Promise<string> {
		if (!this.service) {
			console.log('[LspHover] 服务未初始化');
			return '<error>LSP Hover 服务未初始化</error>';
		}

		try {
			const hover = await this.service.getHover(filePath, line, column);

			if (!hover || hover.contents.length === 0) {
				return `<no_hover_info>
文件: ${filePath}
位置: 第 ${line} 行，第 ${column} 列

此位置没有可用的类型信息或文档。
可能原因：
- 位置不在任何符号上
- 语言服务器尚未完成分析
- 文件类型不支持Hover功能
</no_hover_info>`;
			}

			return formatHoverInfo(hover, filePath, line, column);
		} catch (error) {
			console.warn(`[LspHover] 获取Hover信息失败: ${filePath}:${line}:${column}`, error);
			return `<error>获取Hover信息失败: ${error instanceof Error ? error.message : String(error)}</error>`;
		}
	}
}

/**
 * 全局 LSP Hover 处理器实例
 */
export const globalLspHoverHandler = new LspHoverHandler();

/**
 * 便捷函数：获取Hover信息
 */
export async function getHoverInfo(filePath: string, line: number, column: number): Promise<string> {
	return globalLspHoverHandler.getHover(filePath, line, column);
}
