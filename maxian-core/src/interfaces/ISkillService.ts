/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Skill Service Abstraction
 *
 *  为 skillTool 设计的最小接口，以便 IDE 的 VSCode 版 ISkillService
 *  无需改动即可作为实现传入。
 *--------------------------------------------------------------------------------------------*/

import type { ISkill, ISkillFilter } from '../types/skillTypes.js';

/**
 * Skill 服务的最小抽象接口。
 *
 * 工具层（skillTool）只需要 `get` 和 `search` 两个方法；
 * 完整 Skill 管理功能（初始化、重扫、事件）由具体实现自行提供。
 */
export interface ISkillService {
	/** 获取指定 Skill */
	get(slug: string): ISkill | undefined | Promise<ISkill | undefined>;

	/** 过滤搜索 */
	search(filter: ISkillFilter): ISkill[] | Promise<ISkill[]>;
}
