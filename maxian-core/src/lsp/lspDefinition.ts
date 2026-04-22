/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * LSP Definition 集成
 *
 * 功能：
 * - 跳转到符号定义位置
 * - 查找函数、类、变量的声明位置
 * - 支持跨文件定义查找
 * - 帮助AI理解代码结构
 */

// @ts-ignore — IDE side uses createDecorator via VSCode IoC
export const ILspDefinitionService = (null as any) // createDecorator<ILspDefinitionService>('lspDefinitionService');

/**
 * 定义位置信息
 */
export interface DefinitionLocation {
	/** 文件URI */
	uri: string;
	/** 范围 */
	range: {
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	};
}

/**
 * 定义查询结果
 */
export interface DefinitionResult {
	/** 查询的符号 */
	symbol: string;
	/** 查询位置 */
	queryLocation: {
		filePath: string;
		line: number;
		column: number;
	};
	/** 找到的定义位置列表 */
	definitions: DefinitionLocation[];
}

/**
 * LSP Definition 服务接口
 */
export interface ILspDefinitionService {
	readonly _serviceBrand: undefined;

	/**
	 * 获取符号定义位置
	 * @param filePath 文件路径
	 * @param line 行号（从1开始）
	 * @param column 列号（从1开始）
	 */
	getDefinition(filePath: string, line: number, column: number): Promise<DefinitionResult | null>;
}

/**
 * 格式化定义结果为文本
 */
export function formatDefinitionResult(result: DefinitionResult): string {
	const lines: string[] = [
		`<definition_result>`,
		`符号: ${result.symbol}`,
		`查询位置: ${result.queryLocation.filePath}:${result.queryLocation.line}:${result.queryLocation.column}`,
		``,
	];

	if (result.definitions.length === 0) {
		lines.push('❌ 未找到定义位置');
		lines.push('');
		lines.push('可能原因：');
		lines.push('- 符号是内置类型或外部库定义');
		lines.push('- 语言服务器尚未完成索引');
		lines.push('- 光标位置不在有效符号上');
	} else if (result.definitions.length === 1) {
		const def = result.definitions[0];
		lines.push('✅ 找到定义位置：');
		lines.push('');
		lines.push(`文件: ${def.uri}`);
		lines.push(`位置: 第 ${def.range.startLine} 行，第 ${def.range.startColumn} 列`);

		if (def.range.startLine !== def.range.endLine || def.range.startColumn !== def.range.endColumn) {
			lines.push(`范围: 第 ${def.range.startLine} 行第 ${def.range.startColumn} 列 - 第 ${def.range.endLine} 行第 ${def.range.endColumn} 列`);
		}
	} else {
		lines.push(`✅ 找到 ${result.definitions.length} 个定义位置：`);
		lines.push('');

		result.definitions.forEach((def, index) => {
			lines.push(`${index + 1}. ${def.uri}`);
			lines.push(`   位置: 第 ${def.range.startLine} 行，第 ${def.range.startColumn} 列`);
			lines.push('');
		});
	}

	lines.push('</definition_result>');

	return lines.join('\n');
}

/**
 * LSP Definition 处理器
 */
export class LspDefinitionHandler {
	constructor(private service?: ILspDefinitionService) {}

	/**
	 * 设置 LSP 服务
	 */
	setService(service: ILspDefinitionService): void {
		this.service = service;
	}

	/**
	 * 获取定义位置
	 */
	async getDefinition(filePath: string, line: number, column: number): Promise<string> {
		if (!this.service) {
			console.log('[LspDefinition] 服务未初始化');
			return '<error>LSP Definition 服务未初始化</error>';
		}

		try {
			const result = await this.service.getDefinition(filePath, line, column);

			if (!result) {
				return `<no_definition>
文件: ${filePath}
位置: 第 ${line} 行，第 ${column} 列

未找到定义位置。
</no_definition>`;
			}

			return formatDefinitionResult(result);
		} catch (error) {
			console.warn(`[LspDefinition] 获取定义失败: ${filePath}:${line}:${column}`, error);
			return `<error>获取定义失败: ${error instanceof Error ? error.message : String(error)}</error>`;
		}
	}
}

/**
 * 全局 LSP Definition 处理器实例
 */
export const globalLspDefinitionHandler = new LspDefinitionHandler();

/**
 * 便捷函数：获取定义位置
 */
export async function getDefinition(filePath: string, line: number, column: number): Promise<string> {
	return globalLspDefinitionHandler.getDefinition(filePath, line, column);
}
