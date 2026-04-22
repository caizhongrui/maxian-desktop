/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * LSP 诊断集成
 * 参考 OpenCode tool/write.ts:81-98 实现
 *
 * 功能：
 * - 编辑后自动获取 LSP 诊断
 * - 有错误时提示修复
 * - 将诊断信息格式化返回给 AI
 */

// @ts-ignore — IDE side uses createDecorator via VSCode IoC
export const ILspDiagnosticsService = (null as any) // createDecorator<ILspDiagnosticsService>('lspDiagnosticsService');

/**
 * 诊断严重程度
 */
export enum DiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

/**
 * 诊断位置
 */
export interface DiagnosticRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

/**
 * 诊断信息
 */
export interface Diagnostic {
	/** 诊断范围 */
	range: DiagnosticRange;
	/** 诊断消息 */
	message: string;
	/** 严重程度 */
	severity: DiagnosticSeverity;
	/** 来源（如 TypeScript、ESLint 等） */
	source?: string;
	/** 错误代码 */
	code?: string | number;
}

function getDiagnosticFingerprint(diagnostic: Diagnostic): string {
	const code = diagnostic.code !== undefined ? String(diagnostic.code) : '';
	const source = diagnostic.source ?? '';
	const message = diagnostic.message.trim();
	const range = [
		diagnostic.range.startLine,
		diagnostic.range.startColumn,
		diagnostic.range.endLine,
		diagnostic.range.endColumn,
	].join(':');
	return `${diagnostic.severity}|${source}|${code}|${range}|${message}`;
}

function normalizeDiagnosticFileKey(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, '/');
}

function diffDiagnostics(baseline: Diagnostic[], current: Diagnostic[]): Diagnostic[] {
	if (baseline.length === 0) {
		return current;
	}

	const baselineSet = new Set(baseline.map(getDiagnosticFingerprint));
	return current.filter(diagnostic => !baselineSet.has(getDiagnosticFingerprint(diagnostic)));
}

/**
 * 文件诊断结果
 */
export interface FileDiagnostics {
	/** 文件路径 */
	filePath: string;
	/** 诊断列表 */
	diagnostics: Diagnostic[];
	/** 错误数量 */
	errorCount: number;
	/** 警告数量 */
	warningCount: number;
}

/**
 * LSP 诊断配置
 */
export const LSP_DIAGNOSTICS_CONFIG = {
	/** 获取诊断的等待时间（毫秒） */
	WAIT_TIME_MS: 500,

	/** 最大诊断数量 */
	MAX_DIAGNOSTICS: 50,

	/** 是否包含警告 */
	INCLUDE_WARNINGS: true,

	/** 是否包含提示 */
	INCLUDE_HINTS: false,

	/**
	 * P1优化：对齐 OpenCode write.ts MAX_PROJECT_DIAGNOSTICS_FILES
	 * 编辑后额外展示的其他文件诊断数量上限（显示受影响的关联文件错误）
	 */
	MAX_PROJECT_DIAGNOSTICS_FILES: 5,
};

/**
 * LSP 诊断服务接口
 * 这个接口需要由具体的 IDE 实现提供
 */
export interface ILspDiagnosticsService {
	readonly _serviceBrand: undefined;

	/**
	 * 触发文件的诊断更新
	 * @param filePath 文件路径
	 * @param forceRefresh 是否强制刷新
	 */
	touchFile(filePath: string, forceRefresh?: boolean): Promise<void>;

	/**
	 * 获取文件的诊断信息
	 * @param filePath 文件路径
	 */
	getDiagnostics(filePath: string): Promise<Diagnostic[]>;

	/**
	 * 获取所有打开文件的诊断信息
	 */
	getAllDiagnostics(): Promise<Map<string, Diagnostic[]>>;
}

/**
 * 获取严重程度的名称
 */
export function getSeverityName(severity: DiagnosticSeverity): string {
	switch (severity) {
		case DiagnosticSeverity.Error:
			return '错误';
		case DiagnosticSeverity.Warning:
			return '警告';
		case DiagnosticSeverity.Information:
			return '信息';
		case DiagnosticSeverity.Hint:
			return '提示';
		default:
			return '未知';
	}
}

/**
 * 获取严重程度的图标
 */
export function getSeverityIcon(severity: DiagnosticSeverity): string {
	switch (severity) {
		case DiagnosticSeverity.Error:
			return '❌';
		case DiagnosticSeverity.Warning:
			return '⚠️';
		case DiagnosticSeverity.Information:
			return 'ℹ️';
		case DiagnosticSeverity.Hint:
			return '💡';
		default:
			return '•';
	}
}

/**
 * 过滤诊断信息
 * @param diagnostics 诊断列表
 * @param config 配置
 */
export function filterDiagnostics(
	diagnostics: Diagnostic[],
	config: typeof LSP_DIAGNOSTICS_CONFIG = LSP_DIAGNOSTICS_CONFIG
): Diagnostic[] {
	return diagnostics.filter(d => {
		if (d.severity === DiagnosticSeverity.Error) return true;
		if (d.severity === DiagnosticSeverity.Warning && config.INCLUDE_WARNINGS) return true;
		if (d.severity === DiagnosticSeverity.Hint && config.INCLUDE_HINTS) return true;
		if (d.severity === DiagnosticSeverity.Information && config.INCLUDE_WARNINGS) return true;
		return false;
	}).slice(0, config.MAX_DIAGNOSTICS);
}

/**
 * 格式化诊断信息为文本
 * @param filePath 文件路径
 * @param diagnostics 诊断列表
 */
export function formatDiagnostics(filePath: string, diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) {
		return '';
	}

	const filtered = filterDiagnostics(diagnostics);
	const errorCount = filtered.filter(d => d.severity === DiagnosticSeverity.Error).length;
	const warningCount = filtered.filter(d => d.severity === DiagnosticSeverity.Warning).length;

	const lines: string[] = [
		`<file_diagnostics path="${filePath}">`,
	];

	if (errorCount > 0 || warningCount > 0) {
		lines.push(`此文件存在问题：${errorCount} 个错误，${warningCount} 个警告`);
		lines.push('');
	}

	for (const d of filtered) {
		const icon = getSeverityIcon(d.severity);
		const source = d.source ? `[${d.source}]` : '';
		const code = d.code ? `(${d.code})` : '';
		const location = `第 ${d.range.startLine} 行，第 ${d.range.startColumn} 列`;

		lines.push(`${icon} ${location} ${source}${code}`);
		lines.push(`   ${d.message}`);
		lines.push('');
	}

	if (errorCount > 0) {
		lines.push('请修复以上错误后继续。');
	}

	lines.push('</file_diagnostics>');

	return lines.join('\n');
}

/**
 * 统计诊断信息
 * @param diagnostics 诊断列表
 */
export function countDiagnostics(diagnostics: Diagnostic[]): {
	errors: number;
	warnings: number;
	info: number;
	hints: number;
	total: number;
} {
	let errors = 0;
	let warnings = 0;
	let info = 0;
	let hints = 0;

	for (const d of diagnostics) {
		switch (d.severity) {
			case DiagnosticSeverity.Error:
				errors++;
				break;
			case DiagnosticSeverity.Warning:
				warnings++;
				break;
			case DiagnosticSeverity.Information:
				info++;
				break;
			case DiagnosticSeverity.Hint:
				hints++;
				break;
		}
	}

	return {
		errors,
		warnings,
		info,
		hints,
		total: diagnostics.length,
	};
}

/**
 * 检查是否有错误
 * @param diagnostics 诊断列表
 */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === DiagnosticSeverity.Error);
}

/**
 * 创建诊断附加信息
 * 用于在编辑操作后附加到响应中
 * @param filePath 文件路径
 * @param diagnostics 诊断列表
 */
export function createDiagnosticsAppendix(filePath: string, diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) {
		return '';
	}

	const filtered = filterDiagnostics(diagnostics);
	if (filtered.length === 0) {
		return '';
	}

	const hasError = hasErrors(filtered);
	const formatted = formatDiagnostics(filePath, filtered);

	if (hasError) {
		return `\n\n${formatted}\n\n⚠️ 此文件存在错误，请检查并修复。`;
	} else {
		return `\n\n${formatted}`;
	}
}

export function createDiagnosticsDeltaAppendix(filePath: string, diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) {
		return '';
	}

	const filtered = filterDiagnostics(diagnostics);
	if (filtered.length === 0) {
		return '';
	}

	const errorCount = filtered.filter(d => d.severity === DiagnosticSeverity.Error).length;
	const warningCount = filtered.filter(d => d.severity === DiagnosticSeverity.Warning).length;
	const lines: string[] = [
		'',
		'',
		`<diagnostic_delta path="${filePath}">`,
		`本次修改新增问题：${errorCount} 个错误，${warningCount} 个警告`,
		'',
	];

	for (const diagnostic of filtered) {
		const icon = getSeverityIcon(diagnostic.severity);
		const source = diagnostic.source ? `[${diagnostic.source}]` : '';
		const code = diagnostic.code ? `(${diagnostic.code})` : '';
		const location = `第 ${diagnostic.range.startLine} 行，第 ${diagnostic.range.startColumn} 列`;
		lines.push(`${icon} ${location} ${source}${code}`);
		lines.push(`   ${diagnostic.message}`);
		lines.push('');
	}

	if (errorCount > 0) {
		lines.push('仅需处理本次修改引入的阻塞错误；不要为了清空历史诊断而偏离当前任务。');
	}

	lines.push('</diagnostic_delta>');
	return lines.join('\n');
}

/**
 * LSP 诊断处理器
 * 用于在文件编辑后获取并处理诊断信息
 */
export class LspDiagnosticsHandler {
	private readonly emittedDeltaFingerprints = new Map<string, Set<string>>();

	constructor(private service?: ILspDiagnosticsService) {}

	/**
	 * 设置 LSP 服务
	 */
	setService(service: ILspDiagnosticsService): void {
		this.service = service;
	}

	/**
	 * 在文件编辑后获取诊断
	 * P1优化：对齐 OpenCode write.ts — 同时显示当前文件 + 项目其他文件的诊断错误
	 * @param filePath 文件路径
	 * @returns 格式化的诊断信息，如果没有服务或没有诊断则返回空字符串
	 */
	async captureDiagnosticsBaseline(filePath: string): Promise<Diagnostic[]> {
		if (!this.service) {
			return [];
		}

		try {
			this.emittedDeltaFingerprints.delete(normalizeDiagnosticFileKey(filePath));
			await this.service.touchFile(filePath, true);
			await new Promise(resolve => setTimeout(resolve, LSP_DIAGNOSTICS_CONFIG.WAIT_TIME_MS));
			return await this.service.getDiagnostics(filePath);
		} catch (error) {
			console.warn(`[LspDiagnostics] 捕获诊断基线失败: ${filePath}`, error);
			return [];
		}
	}

	async getDiagnosticsAfterEdit(filePath: string, baseline: Diagnostic[] = []): Promise<string> {
		if (!this.service) {
			return '';
		}

		try {
			// 触发文件更新
			await this.service.touchFile(filePath, true);

			// 等待诊断更新
			await new Promise(resolve => setTimeout(resolve, LSP_DIAGNOSTICS_CONFIG.WAIT_TIME_MS));

			// 获取当前文件的诊断，并且只返回相对 baseline 的新增项
			const diagnostics = await this.service.getDiagnostics(filePath);
			const deltaDiagnostics = diffDiagnostics(baseline, diagnostics);
			if (deltaDiagnostics.length === 0) {
				return '';
			}

			const fileKey = normalizeDiagnosticFileKey(filePath);
			const emittedSet = this.emittedDeltaFingerprints.get(fileKey) ?? new Set<string>();
			const unseenDelta = deltaDiagnostics.filter(diagnostic => {
				const fingerprint = getDiagnosticFingerprint(diagnostic);
				if (emittedSet.has(fingerprint)) {
					return false;
				}
				emittedSet.add(fingerprint);
				return true;
			});
			this.emittedDeltaFingerprints.set(fileKey, emittedSet);

			// 自动回灌只关注新增的阻塞错误，普通 warning 交给显式 lsp_diagnostics 查询，
			// 避免模型被同一文件的非阻塞提示反复拉回去做小补丁。
			const blockingDelta = unseenDelta.filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error);
			if (blockingDelta.length === 0) {
				return '';
			}

			return createDiagnosticsDeltaAppendix(filePath, blockingDelta);
		} catch (error) {
			console.warn(`[LspDiagnostics] 获取诊断失败: ${filePath}`, error);
			return '';
		}
	}

	async getCurrentDiagnostics(filePath: string): Promise<string> {
		if (!this.service) {
			return '';
		}

		try {
			await this.service.touchFile(filePath, true);
			await new Promise(resolve => setTimeout(resolve, LSP_DIAGNOSTICS_CONFIG.WAIT_TIME_MS));
			const diagnostics = await this.service.getDiagnostics(filePath);
			return createDiagnosticsAppendix(filePath, diagnostics);
		} catch (error) {
			console.warn(`[LspDiagnostics] 获取当前诊断失败: ${filePath}`, error);
			return '';
		}
	}

	clearDiagnosticHistory(filePath?: string): void {
		if (filePath) {
			this.emittedDeltaFingerprints.delete(normalizeDiagnosticFileKey(filePath));
			return;
		}
		this.emittedDeltaFingerprints.clear();
	}

	/**
	 * 获取文件诊断结果
	 * @param filePath 文件路径
	 */
	async getFileDiagnostics(filePath: string): Promise<FileDiagnostics | null> {
		if (!this.service) {
			return null;
		}

		try {
			const diagnostics = await this.service.getDiagnostics(filePath);
			const counts = countDiagnostics(diagnostics);

			return {
				filePath,
				diagnostics,
				errorCount: counts.errors,
				warningCount: counts.warnings,
			};
		} catch (error) {
			console.warn(`[LspDiagnostics] 获取诊断失败: ${filePath}`, error);
			return null;
		}
	}
}

/**
 * 全局 LSP 诊断处理器实例
 */
export const globalLspDiagnosticsHandler = new LspDiagnosticsHandler();

/**
 * 便捷函数：在文件编辑后获取诊断
 */
export async function getDiagnosticsAfterEdit(filePath: string, baseline: Diagnostic[] = []): Promise<string> {
	return globalLspDiagnosticsHandler.getDiagnosticsAfterEdit(filePath, baseline);
}

export async function captureDiagnosticsBaseline(filePath: string): Promise<Diagnostic[]> {
	return globalLspDiagnosticsHandler.captureDiagnosticsBaseline(filePath);
}

export async function getCurrentDiagnostics(filePath: string): Promise<string> {
	return globalLspDiagnosticsHandler.getCurrentDiagnostics(filePath);
}
