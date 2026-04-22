/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAllModes, type ModeConfig } from '../../types/modeTypes.js';

/**
 * 获取模式section
 * 与Kilocode完全一致的格式
 */
export function getModesSection(): string {
	const allModes = getAllModes();

	let modesContent = `====

MODES

- 这些是当前可用的模式：
${allModes
		.map((mode: ModeConfig) => {
			let description: string;
			if (mode.whenToUse && mode.whenToUse.trim() !== '') {
				// 使用whenToUse作为主要描述，缩进后续行以提高可读性
				description = mode.whenToUse.replace(/\n/g, '\n    ');
			} else {
				// 如果whenToUse不可用，回退到roleDefinition的第一句话
				description = mode.roleDefinition.split('。')[0];
			}
			return `  * "${mode.name}" 模式 (${mode.slug}) - ${description}`;
		})
		.join('\n')}`;

	// 注意：暂不支持自定义模式创建，后续可添加
	// modesContent += `\n如果用户要求你为此项目创建或编辑新模式，你应该告知用户当前不支持此功能。`;

	return modesContent;
}
