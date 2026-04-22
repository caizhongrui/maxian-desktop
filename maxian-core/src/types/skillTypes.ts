/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Skill Types
 *
 *  Skills 是按需加载的专业领域知识，用于扩展 AI 的能力。
 *  纯类型，0 platform dependency.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 元数据。
 */
export interface ISkillMetadata {
	/** Skill 名称（用于显示） */
	readonly name: string;

	/** URL 友好标识（用于引用） */
	readonly slug: string;

	/** 简短描述（~50 字符） */
	readonly description: string;

	/** 分类 */
	readonly category: SkillCategory;

	/** 预估 Token 数 */
	readonly estimatedTokens: number;

	/** 版本号 */
	readonly version: string;

	/** 作者 */
	readonly author?: string;

	/** 标签 */
	readonly tags?: string[];

	/** 是否为官方 Skill */
	readonly official?: boolean;

	/** 创建时间 */
	readonly createdAt?: string;

	/** 更新时间 */
	readonly updatedAt?: string;
}

/**
 * Skill 分类。
 */
export enum SkillCategory {
	CodeQuality = 'code-quality',
	Development = 'development',
	Testing = 'testing',
	Debugging = 'debugging',
	Performance = 'performance',
	Security = 'security',
	Documentation = 'documentation',
	Architecture = 'architecture',
	ApiDesign = 'api-design',
	Other = 'other',
}

/**
 * Skill 完整定义。
 */
export interface ISkill extends ISkillMetadata {
	/** Skill 内容（Markdown 格式） */
	readonly content: string;

	/** Skill 文件路径 */
	readonly filePath: string;

	/** 示例文件路径 */
	examplePaths?: string[];

	/** 模板文件路径 */
	templatePaths?: string[];
}

/**
 * Skill 搜索过滤器。
 */
export interface ISkillFilter {
	category?: SkillCategory;
	tags?: string[];
	query?: string;
	officialOnly?: boolean;
}

/**
 * Skill 加载选项。
 */
export interface ISkillLoadOptions {
	includeExamples?: boolean;
	includeTemplates?: boolean;
	maxTokens?: number;
}

/**
 * Skill 激活上下文。
 */
export interface ISkillActivationContext {
	taskDescription?: string;
	relevantFiles?: string[];
	userPreferences?: Record<string, unknown>;
}
