/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export { getRulesSection } from './rules.js';
export { getSystemInfoSection, type SystemInfo } from './systemInfo.js';
export { getObjectiveSection } from './objective.js';
export { getToolUseGuidelinesSection } from './toolUseGuidelines.js';
export { getMarkdownFormattingSection } from './markdownFormatting.js';
export { getToolUseSection } from './toolUse.js';
export { getModesSection } from './modes.js';
export { getGitSafetyProtocolSection } from './gitSafetyProtocol.js';
export { getToolDecisionTreeSection } from './toolDecisionTree.js';

// 已移除的 sections（内容合并或删除）：
// - getCapabilitiesSection（Claude从tools[]已知自己的能力）
// - getExplorationStrategySection（合并到toolUseGuidelines）
