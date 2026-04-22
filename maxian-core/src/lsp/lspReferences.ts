/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * LSP References 集成
 *
 * 功能：
 * - 查找符号的所有引用位置
 * - 支持跨文件引用查找
 * - 帮助AI理解代码影响范围
 * - 重构时确保修改完整
 */

// @ts-ignore — IDE side uses createDecorator via VSCode IoC
export const ILspReferencesService = (null as any) // createDecorator<ILspReferencesService>('lspReferencesService');

/**
 * 引用位置信息
 */
export interface ReferenceLocation {
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
 * 引用查询结果
 */
export interface ReferencesResult {
	/** 查询的符号 */
	symbol: string;
	/** 查询位置 */
	queryLocation: {
		filePath: string;
		line: number;
		column: number;
	};
	/** 找到的引用位置列表 */
	references: ReferenceLocation[];
	/** 按文件分组的引用 */
	referencesByFile: Map<string, ReferenceLocation[]>;
}

/**
 * LSP References 服务接口
 */
export interface ILspReferencesService {
	readonly _serviceBrand: undefined;

	/**
	 * 获取符号的所有引用
	 * @param filePath 文件路径
	 * @param line 行号（从1开始）
	 * @param column 列号（从1开始）
	 * @param includeDeclaration 是否包含声明位置（默认true）
	 */
	getReferences(filePath: string, line: number, column: number, includeDeclaration?: boolean): Promise<ReferencesResult | null>;
}

/**
 * 格式化引用结果为文本
 */
export function formatReferencesResult(result: ReferencesResult): string {
	const lines: string[] = [
		`<references_result>`,
		`符号: ${result.symbol}`,
		`查询位置: ${result.queryLocation.filePath}:${result.queryLocation.line}:${result.queryLocation.column}`,
		``,
	];

	if (result.references.length === 0) {
		lines.push('❌ 未找到引用');
		lines.push('');
		lines.push('可能原因：');
		lines.push('- 此符号未被使用');
		lines.push('- 语言服务器尚未完成索引');
		lines.push('- 光标位置不在有效符号上');
	} else {
		lines.push(`✅ 找到 ${result.references.length} 个引用，分布在 ${result.referencesByFile.size} 个文件中：`);
		lines.push('');

		// 按文件分组显示
		for (const [filePath, refs] of result.referencesByFile.entries()) {
			lines.push(`📁 ${filePath} (${refs.length} 个引用)`);

			refs.forEach((ref, index) => {
				lines.push(`   ${index + 1}. 第 ${ref.range.startLine} 行，第 ${ref.range.startColumn} 列`);
			});

			lines.push('');
		}

		// 总结
		lines.push('💡 使用提示：');
		lines.push('- 修改此符号前，请检查所有引用位置');
		lines.push('- 重命名时，确保所有引用都已更新');
		lines.push('- 删除时，先处理所有引用');
	}

	lines.push('</references_result>');

	return lines.join('\n');
}

/**
 * LSP References 处理器
 */
export class LspReferencesHandler {
	constructor(private service?: ILspReferencesService) {}

	/**
	 * 设置 LSP 服务
	 */
	setService(service: ILspReferencesService): void {
		this.service = service;
	}

	/**
	 * 获取引用位置
	 */
	async getReferences(filePath: string, line: number, column: number, includeDeclaration: boolean = true): Promise<string> {
		if (!this.service) {
			console.log('[LspReferences] 服务未初始化');
			return '<error>LSP References 服务未初始化</error>';
		}

		try {
			const result = await this.service.getReferences(filePath, line, column, includeDeclaration);

			if (!result) {
				return `<no_references>
文件: ${filePath}
位置: 第 ${line} 行，第 ${column} 列

未找到引用。
</no_references>`;
			}

			return formatReferencesResult(result);
		} catch (error) {
			console.warn(`[LspReferences] 获取引用失败: ${filePath}:${line}:${column}`, error);
			return `<error>获取引用失败: ${error instanceof Error ? error.message : String(error)}</error>`;
		}
	}
}

/**
 * 全局 LSP References 处理器实例
 */
export const globalLspReferencesHandler = new LspReferencesHandler();

/**
 * 便捷函数：获取引用位置
 */
export async function getReferences(filePath: string, line: number, column: number, includeDeclaration: boolean = true): Promise<string> {
	return globalLspReferencesHandler.getReferences(filePath, line, column, includeDeclaration);
}
