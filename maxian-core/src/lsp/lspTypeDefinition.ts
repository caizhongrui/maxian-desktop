/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * LSP Type Definition 集成
 *
 * 功能：
 * - 跳转到类型定义位置
 * - 查看变量的类型声明
 * - 理解接口和类的定义
 * - 帮助AI理解类型系统
 */

// @ts-ignore — IDE side uses createDecorator via VSCode IoC
export const ILspTypeDefinitionService = (null as any) // createDecorator<ILspTypeDefinitionService>('lspTypeDefinitionService');

/**
 * 类型定义位置信息
 */
export interface TypeDefinitionLocation {
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
 * 类型定义查询结果
 */
export interface TypeDefinitionResult {
	/** 查询的符号 */
	symbol: string;
	/** 查询位置 */
	queryLocation: {
		filePath: string;
		line: number;
		column: number;
	};
	/** 找到的类型定义位置列表 */
	typeDefinitions: TypeDefinitionLocation[];
}

/**
 * LSP Type Definition 服务接口
 */
export interface ILspTypeDefinitionService {
	readonly _serviceBrand: undefined;

	/**
	 * 获取类型定义位置
	 * @param filePath 文件路径
	 * @param line 行号（从1开始）
	 * @param column 列号（从1开始）
	 */
	getTypeDefinition(filePath: string, line: number, column: number): Promise<TypeDefinitionResult | null>;
}

/**
 * 格式化类型定义结果为文本
 */
export function formatTypeDefinitionResult(result: TypeDefinitionResult): string {
	const lines: string[] = [
		`<type_definition_result>`,
		`符号: ${result.symbol}`,
		`查询位置: ${result.queryLocation.filePath}:${result.queryLocation.line}:${result.queryLocation.column}`,
		``,
	];

	if (result.typeDefinitions.length === 0) {
		lines.push('❌ 未找到类型定义');
		lines.push('');
		lines.push('可能原因：');
		lines.push('- 符号是基本类型（string、number等）');
		lines.push('- 类型定义在外部库中');
		lines.push('- 语言服务器尚未完成索引');
		lines.push('- 光标位置不在有效符号上');
	} else if (result.typeDefinitions.length === 1) {
		const def = result.typeDefinitions[0];
		lines.push('✅ 找到类型定义：');
		lines.push('');
		lines.push(`文件: ${def.uri}`);
		lines.push(`位置: 第 ${def.range.startLine} 行，第 ${def.range.startColumn} 列`);

		if (def.range.startLine !== def.range.endLine || def.range.startColumn !== def.range.endColumn) {
			lines.push(`范围: 第 ${def.range.startLine} 行第 ${def.range.startColumn} 列 - 第 ${def.range.endLine} 行第 ${def.range.endColumn} 列`);
		}

		lines.push('');
		lines.push('💡 提示：可以使用 read_file 工具查看完整的类型定义');
	} else {
		lines.push(`✅ 找到 ${result.typeDefinitions.length} 个类型定义：`);
		lines.push('');

		result.typeDefinitions.forEach((def, index) => {
			lines.push(`${index + 1}. ${def.uri}`);
			lines.push(`   位置: 第 ${def.range.startLine} 行，第 ${def.range.startColumn} 列`);
			lines.push('');
		});

		lines.push('💡 提示：多个定义可能是类型继承或接口合并');
	}

	lines.push('</type_definition_result>');

	return lines.join('\n');
}

/**
 * LSP Type Definition 处理器
 */
export class LspTypeDefinitionHandler {
	constructor(private service?: ILspTypeDefinitionService) {}

	/**
	 * 设置 LSP 服务
	 */
	setService(service: ILspTypeDefinitionService): void {
		this.service = service;
	}

	/**
	 * 获取类型定义位置
	 */
	async getTypeDefinition(filePath: string, line: number, column: number): Promise<string> {
		if (!this.service) {
			console.log('[LspTypeDefinition] 服务未初始化');
			return '<error>LSP Type Definition 服务未初始化</error>';
		}

		try {
			const result = await this.service.getTypeDefinition(filePath, line, column);

			if (!result) {
				return `<no_type_definition>
文件: ${filePath}
位置: 第 ${line} 行，第 ${column} 列

未找到类型定义。
</no_type_definition>`;
			}

			return formatTypeDefinitionResult(result);
		} catch (error) {
			console.warn(`[LspTypeDefinition] 获取类型定义失败: ${filePath}:${line}:${column}`, error);
			return `<error>获取类型定义失败: ${error instanceof Error ? error.message : String(error)}</error>`;
		}
	}
}

/**
 * 全局 LSP Type Definition 处理器实例
 */
export const globalLspTypeDefinitionHandler = new LspTypeDefinitionHandler();

/**
 * 便捷函数：获取类型定义位置
 */
export async function getTypeDefinition(filePath: string, line: number, column: number): Promise<string> {
	return globalLspTypeDefinitionHandler.getTypeDefinition(filePath, line, column);
}
