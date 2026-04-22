/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Types Barrel Export
 *
 *  同名冲突处理：
 *  - `ToolProgressStatus` 冲突 → toolTypes 里改名为 ToolProgressLevel
 *  - `ToolGroup` / `ToolGroupConfig` / `TOOL_GROUPS` / `ALWAYS_AVAILABLE_TOOLS`
 *    在 toolTypes（基础工具组）与 modeTypes（模式权限组）中语义不同，
 *    modeTypes 用 `Mode*` 前缀区分
 *--------------------------------------------------------------------------------------------*/

// 工具相关
export {
	toolParamNames,
	toolNames,
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
} from './toolTypes.js';

export type {
	ToolResponse,
	ToolProgressLevel,
	ToolParamName,
	ToolName,
	TextContent,
	ToolUse,
	ExecuteCommandToolUse,
	ReadFileToolUse,
	WriteToFileToolUse,
	InsertCodeBlockToolUse,
	CodebaseSearchToolUse,
	SearchFilesToolUse,
	ListFilesToolUse,
	ListCodeDefinitionNamesToolUse,
	AskFollowupQuestionToolUse,
	AttemptCompletionToolUse,
	NewTaskToolUse,
	ApplyDiffToolUse,
	EditFileToolUse,
	GlobToolUse,
	LspHoverToolUse,
	LspToolUse,
	LspDiagnosticsToolUse,
	LspDefinitionToolUse,
	LspReferencesToolUse,
	LspTypeDefinitionToolUse,
	PrReviewToolUse,
	GenerateTestsToolUse,
	ToolGroup,
	ToolGroupConfig,
} from './toolTypes.js';

// 任务相关
export * from './taskTypes.js';

// 模式相关（用 Mode* 前缀区分）
export {
	MODE_TOOL_GROUPS,
	MODE_ALWAYS_AVAILABLE_TOOLS,
	DEFAULT_MODE,
	DEFAULT_MODES,
	getModeBySlug,
	getAllModes,
	getGroupName,
	getGroupOptions,
	getToolsForMode,
	isToolAllowedForMode,
} from './modeTypes.js';

export type {
	ModeToolGroup,
	ModeToolGroupConfig,
	GroupOptions,
	GroupEntry,
	ModeConfig,
	Mode,
} from './modeTypes.js';

// Skills 相关
export {
	SkillCategory,
} from './skillTypes.js';

export type {
	ISkill,
	ISkillMetadata,
	ISkillFilter,
	ISkillLoadOptions,
	ISkillActivationContext,
} from './skillTypes.js';
