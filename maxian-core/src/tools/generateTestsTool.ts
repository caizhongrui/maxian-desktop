/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 测试代码生成工具
 *
 * 分析指定源文件，返回文件内容和元信息，供Agent生成对应的测试代码。
 * 工具本身负责读取文件、检测语言、推导测试路径，Agent根据返回内容调用write_to_file生成测试。
 */

import * as path from 'node:path';
import type { ToolResponse } from '../types/toolTypes.js';

/** 文件最大读取大小（1MB） */
const MAX_FILE_SIZE = 1 * 1024 * 1024;

/**
 * 文件系统操作回调（由调用方提供，避免在 browser 上下文中直接使用 Node.js fs 模块）
 */
export interface FileSystemOps {
	exists(filePath: string): Promise<boolean>;
	stat(filePath: string): Promise<{ size: number; isDirectory: boolean }>;
	readText(filePath: string): Promise<string>;
	readdir(dirPath: string): Promise<string[]>;
}

/**
 * 支持的语言信息
 */
interface LanguageInfo {
	language: string;
	defaultFramework: string;
	testFileExtension: string;
	testFileSuffix: string;
}

/** 扩展名到语言信息的映射 */
const EXTENSION_TO_LANGUAGE: Record<string, LanguageInfo> = {
	'.java': {
		language: 'Java',
		defaultFramework: 'junit5',
		testFileExtension: '.java',
		testFileSuffix: 'Test',
	},
	'.kt': {
		language: 'Kotlin',
		defaultFramework: 'junit5',
		testFileExtension: '.kt',
		testFileSuffix: 'Test',
	},
	'.ts': {
		language: 'TypeScript',
		defaultFramework: 'jest',
		testFileExtension: '.test.ts',
		testFileSuffix: '',
	},
	'.tsx': {
		language: 'TypeScript (React)',
		defaultFramework: 'jest',
		testFileExtension: '.test.tsx',
		testFileSuffix: '',
	},
	'.js': {
		language: 'JavaScript',
		defaultFramework: 'jest',
		testFileExtension: '.test.js',
		testFileSuffix: '',
	},
	'.jsx': {
		language: 'JavaScript (React)',
		defaultFramework: 'jest',
		testFileExtension: '.test.jsx',
		testFileSuffix: '',
	},
	'.mjs': {
		language: 'JavaScript (ESM)',
		defaultFramework: 'jest',
		testFileExtension: '.test.mjs',
		testFileSuffix: '',
	},
	'.py': {
		language: 'Python',
		defaultFramework: 'pytest',
		testFileExtension: '.py',
		testFileSuffix: '',
	},
	'.go': {
		language: 'Go',
		defaultFramework: 'go_test',
		testFileExtension: '_test.go',
		testFileSuffix: '',
	},
	'.cs': {
		language: 'C#',
		defaultFramework: 'xunit',
		testFileExtension: '.cs',
		testFileSuffix: 'Tests',
	},
	'.cpp': {
		language: 'C++',
		defaultFramework: 'googletest',
		testFileExtension: '_test.cpp',
		testFileSuffix: '',
	},
	'.c': {
		language: 'C',
		defaultFramework: 'unity',
		testFileExtension: '_test.c',
		testFileSuffix: '',
	},
	'.rb': {
		language: 'Ruby',
		defaultFramework: 'rspec',
		testFileExtension: '_spec.rb',
		testFileSuffix: '',
	},
	'.php': {
		language: 'PHP',
		defaultFramework: 'phpunit',
		testFileExtension: 'Test.php',
		testFileSuffix: '',
	},
	'.swift': {
		language: 'Swift',
		defaultFramework: 'xctest',
		testFileExtension: 'Tests.swift',
		testFileSuffix: '',
	},
	'.rs': {
		language: 'Rust',
		defaultFramework: 'rust_test',
		testFileExtension: '.rs',
		testFileSuffix: '',
	},
};

/**
 * 检测文件语言
 */
function detectLanguage(filePath: string): LanguageInfo {
	const ext = path.extname(filePath).toLowerCase();
	return EXTENSION_TO_LANGUAGE[ext] || {
		language: 'Unknown',
		defaultFramework: 'unknown',
		testFileExtension: '.test' + ext,
		testFileSuffix: '',
	};
}

/**
 * 推导Java/Maven项目的测试文件路径
 * src/main/java/com/example/Foo.java → src/test/java/com/example/FooTest.java
 */
function inferJavaTestPath(absolutePath: string, relativePath: string, baseName: string, langInfo: LanguageInfo): string {
	// Maven标准项目结构
	const mavenSrcPattern = /^(.*?)src[/\\]main[/\\]java[/\\](.*)$/;
	const match = relativePath.replace(/\\/g, '/').match(mavenSrcPattern);
	if (match) {
		const prefix = match[1];
		const suffix = match[2]; // com/example/Foo.java
		const suffixWithoutExt = suffix.replace(/\.java$/, '');
		return `${prefix}src/test/java/${suffixWithoutExt}${langInfo.testFileSuffix}.java`;
	}

	// Gradle标准项目结构（同Maven）
	const gradleSrcPattern = /^(.*?)src[/\\]main[/\\]kotlin[/\\](.*)$/;
	const gradleMatch = relativePath.replace(/\\/g, '/').match(gradleSrcPattern);
	if (gradleMatch) {
		const prefix = gradleMatch[1];
		const suffix = gradleMatch[2];
		const suffixWithoutExt = suffix.replace(/\.kt$/, '');
		return `${prefix}src/test/kotlin/${suffixWithoutExt}${langInfo.testFileSuffix}.kt`;
	}

	// 默认：在同目录下，文件名加Test后缀
	const dir = path.dirname(relativePath);
	const nameWithoutExt = path.basename(relativePath, path.extname(relativePath));
	return path.join(dir, `${nameWithoutExt}${langInfo.testFileSuffix}.java`).replace(/\\/g, '/');
}

/**
 * 推导Python测试文件路径
 */
async function inferPythonTestPath(relativePath: string, workspacePath: string, fsOps: FileSystemOps): Promise<string> {
	const dir = path.dirname(relativePath);
	const baseName = path.basename(relativePath, '.py');

	// 检查是否有顶层tests/目录
	const testsDir = path.join(workspacePath, 'tests');
	if (await fsOps.exists(testsDir)) {
		const relativeDir = dir === '.' ? '' : dir.replace(/^src[/\\]?/, '');
		if (relativeDir) {
			return `tests/${relativeDir}/test_${baseName}.py`.replace(/\\/g, '/');
		}
		return `tests/test_${baseName}.py`;
	}

	// 在同目录下创建test_前缀的文件
	return path.join(dir, `test_${baseName}.py`).replace(/\\/g, '/');
}

/**
 * 推导TypeScript/JavaScript测试文件路径
 */
async function inferJsTestPath(relativePath: string, workspacePath: string, langInfo: LanguageInfo, fsOps: FileSystemOps): Promise<string> {
	const dir = path.dirname(relativePath);
	const ext = path.extname(relativePath);
	const baseName = path.basename(relativePath, ext);

	// 检查是否有__tests__目录
	const testsDir = path.join(workspacePath, '__tests__');
	if (await fsOps.exists(testsDir)) {
		return `__tests__/${baseName}${langInfo.testFileExtension}`;
	}

	// spec目录检查
	const specDir = path.join(workspacePath, 'spec');
	if (await fsOps.exists(specDir)) {
		return `spec/${baseName}.spec${ext}`;
	}

	// 在同目录下创建.test.ts后缀的文件
	return path.join(dir, `${baseName}${langInfo.testFileExtension}`).replace(/\\/g, '/');
}

/**
 * 推导Go测试文件路径
 */
function inferGoTestPath(relativePath: string): string {
	const dir = path.dirname(relativePath);
	const baseName = path.basename(relativePath, '.go');
	return path.join(dir, `${baseName}_test.go`).replace(/\\/g, '/');
}

/**
 * 推导测试文件输出路径
 */
async function inferTestOutputPath(
	relativePath: string,
	absolutePath: string,
	workspacePath: string,
	langInfo: LanguageInfo,
	language: string,
	fsOps: FileSystemOps
): Promise<string> {
	switch (language) {
		case 'Java':
			return inferJavaTestPath(absolutePath, relativePath, path.basename(relativePath, '.java'), langInfo);
		case 'Kotlin':
			return inferJavaTestPath(absolutePath, relativePath, path.basename(relativePath, '.kt'), langInfo);
		case 'Python':
			return inferPythonTestPath(relativePath, workspacePath, fsOps);
		case 'Go':
			return inferGoTestPath(relativePath);
		case 'TypeScript':
		case 'TypeScript (React)':
		case 'JavaScript':
		case 'JavaScript (React)':
		case 'JavaScript (ESM)':
			return inferJsTestPath(relativePath, workspacePath, langInfo, fsOps);
		default: {
			// 通用推导：在同目录下加测试后缀
			const dir = path.dirname(relativePath);
			const ext = path.extname(relativePath);
			const baseName = path.basename(relativePath, ext);
			return path.join(dir, `${baseName}${langInfo.testFileSuffix}${langInfo.testFileExtension}`).replace(/\\/g, '/');
		}
	}
}

/**
 * 解析测试框架的描述
 */
function getFrameworkDescription(framework: string): string {
	const descriptions: Record<string, string> = {
		'junit5': 'JUnit 5 (Jupiter) - Java/Kotlin单元测试框架',
		'jest': 'Jest - JavaScript/TypeScript测试框架（@jest, describe/it/expect）',
		'pytest': 'pytest - Python测试框架（def test_xxx）',
		'go_test': 'Go内置测试框架（testing包，func TestXxx）',
		'xunit': 'xUnit.net - C#测试框架',
		'googletest': 'Google Test - C++测试框架',
		'unity': 'Unity - C语言测试框架',
		'rspec': 'RSpec - Ruby BDD测试框架',
		'phpunit': 'PHPUnit - PHP测试框架',
		'xctest': 'XCTest - Swift/Objective-C测试框架',
		'rust_test': 'Rust内置测试框架（#[test]属性）',
	};
	return descriptions[framework] || framework;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 测试生成工具主函数
 *
 * @param workspacePath 工作区根目录路径
 * @param params 工具参数
 * @param fsOps 文件系统操作回调（由调用方提供，避免在 browser 上下文中直接使用 Node.js fs 模块）
 * @returns 格式化的分析结果，供Agent生成测试代码
 */
export async function generateTestsTool(
	workspacePath: string,
	params: {
		target_file: string;
		test_framework?: string;
		output_path?: string;
	},
	fsOps: FileSystemOps
): Promise<ToolResponse> {
	const targetFile = params.target_file;
	if (!targetFile) {
		return 'Error: target_file 参数必填，请指定要生成测试的源文件路径。';
	}

	// 解析绝对路径
	const absolutePath = path.isAbsolute(targetFile)
		? targetFile
		: path.resolve(workspacePath, targetFile);

	// 计算相对路径（用于显示和推导）
	const relativePath = path.isAbsolute(targetFile)
		? path.relative(workspacePath, absolutePath)
		: targetFile;

	// 检查文件是否存在
	if (!await fsOps.exists(absolutePath)) {
		// 尝试模糊匹配
		const parentDir = path.dirname(absolutePath);
		const targetName = path.basename(absolutePath).toLowerCase();
		if (await fsOps.exists(parentDir)) {
			try {
				const dirContents = await fsOps.readdir(parentDir);
				const minMatchLen = Math.max(3, Math.floor(targetName.length * 0.6));
				const suggestions = dirContents
					.filter(f => {
						const lf = f.toLowerCase();
						return lf.includes(targetName.substring(0, minMatchLen)) ||
							targetName.includes(lf.substring(0, Math.max(3, Math.floor(lf.length * 0.6))));
					})
					.slice(0, 5);
				if (suggestions.length > 0) {
					const parentRelDir = path.dirname(relativePath);
					const suggestionPaths = suggestions.map(f => path.join(parentRelDir, f).replace(/\\/g, '/'));
					return `Error: 文件不存在: ${targetFile}\n\n你是否想要这些文件？\n${suggestionPaths.map(p => `  - ${p}`).join('\n')}`;
				}
			} catch { /* ignore */ }
		}
		return `Error: 文件不存在: ${targetFile}`;
	}

	// 检查是否为目录
	let statResult: { size: number; isDirectory: boolean };
	try {
		statResult = await fsOps.stat(absolutePath);
	} catch (err: any) {
		return `Error: 无法获取文件信息: ${err.message}`;
	}

	if (statResult.isDirectory) {
		return `Error: ${targetFile} 是一个目录，请指定具体的源文件路径。`;
	}

	// 检查文件大小
	if (statResult.size > MAX_FILE_SIZE) {
		return `Error: 文件过大 (${formatFileSize(statResult.size)})，最大支持 ${formatFileSize(MAX_FILE_SIZE)}。\n\n请使用 read_file 工具配合 start_line/end_line 参数分段读取文件内容，然后手动指定测试需求。`;
	}

	// 检测语言
	const langInfo = detectLanguage(absolutePath);
	const language = langInfo.language;

	// 确定测试框架（优先使用用户指定）
	const testFramework = params.test_framework || langInfo.defaultFramework;

	// 推导测试文件输出路径（优先使用用户指定）
	const outputPath = params.output_path
		|| await inferTestOutputPath(relativePath, absolutePath, workspacePath, langInfo, language, fsOps);

	// 读取源文件内容
	let fileContent: string;
	try {
		fileContent = await fsOps.readText(absolutePath);
	} catch (err: any) {
		return `Error: 读取文件失败: ${err.message}`;
	}

	const lineCount = fileContent.split('\n').length;

	// 检查测试文件是否已存在
	const testFileAbsPath = path.isAbsolute(outputPath)
		? outputPath
		: path.resolve(workspacePath, outputPath);
	const testFileExists = await fsOps.exists(testFileAbsPath);

	// 构建输出
	const lines: string[] = [
		'## 测试生成分析',
		'',
		`### 目标文件: ${relativePath.replace(/\\/g, '/')}`,
		`### 语言: ${language}`,
		`### 建议测试框架: ${testFramework} - ${getFrameworkDescription(testFramework)}`,
		`### 建议测试文件路径: ${outputPath.replace(/\\/g, '/')}`,
	];

	if (testFileExists) {
		lines.push(`### ⚠️ 注意: 测试文件已存在，生成新测试时请注意不要覆盖现有测试逻辑`);
	}

	lines.push(
		'',
		`### 文件信息`,
		`- 文件大小: ${formatFileSize(statResult.size)}`,
		`- 代码行数: ${lineCount} 行`,
		'',
		'### 源文件内容',
		'```' + getCodeBlockLanguage(language),
		fileContent,
		'```',
		'',
		'---',
		'',
		`请根据以上源文件内容，使用 ${testFramework} 框架，为该文件生成完整的单元测试代码。`,
		`生成完成后，使用 write_to_file 工具将测试代码写入: ${outputPath.replace(/\\/g, '/')}`,
	);

	return lines.join('\n');
}

/**
 * 获取代码块语言标识（用于语法高亮）
 */
function getCodeBlockLanguage(language: string): string {
	const mapping: Record<string, string> = {
		'Java': 'java',
		'Kotlin': 'kotlin',
		'TypeScript': 'typescript',
		'TypeScript (React)': 'tsx',
		'JavaScript': 'javascript',
		'JavaScript (React)': 'jsx',
		'JavaScript (ESM)': 'javascript',
		'Python': 'python',
		'Go': 'go',
		'C#': 'csharp',
		'C++': 'cpp',
		'C': 'c',
		'Ruby': 'ruby',
		'PHP': 'php',
		'Swift': 'swift',
		'Rust': 'rust',
	};
	return mapping[language] || '';
}
