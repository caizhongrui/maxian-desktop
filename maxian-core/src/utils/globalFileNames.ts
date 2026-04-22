/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Global File Names
 *
 *  统一约定的本地文件名常量。
 *--------------------------------------------------------------------------------------------*/

export const GlobalFileNames = {
	apiConversationHistory: 'api_conversation_history.json',
	uiMessages: 'ui_messages.json',
	mcpSettings: 'mcp_settings.json',
	customModes: 'custom_modes.yaml',
	taskMetadata: 'task_metadata.json',
	maxianRules: '.maxian/rules',
	workflows: '.maxian/workflows',
	/** 会话历史（Solo 模式） */
	sessions: '.maxian/sessions.json',
	/** 跨会话自动记忆 */
	autoMemory: '.maxian/memory/auto-memory.md',
	/** 指引/steering 目录 */
	steering: '.maxian/steering',
} as const;

export type GlobalFileName = typeof GlobalFileNames[keyof typeof GlobalFileNames];
