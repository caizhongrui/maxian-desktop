/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Complete implementation of Kilocode's presentAssistantMessage
// Phase 3 Implementation - Real tool execution with full functionality

import type { Task } from '../task/Task.js';
import type { AssistantMessageContent } from './parseAssistantMessage.js';
import type { ToolName, ToolResponse } from '../types/toolTypes.js';
import type { ClineAsk } from '../types/taskTypes.js';

// Import tool implementations
import { readFileTool } from '../tools/readFileTool.js';
import { writeToFileTool } from '../tools/writeToFileTool.js';
import { listFilesTool } from '../tools/listFilesTool.js';
import { searchFilesTool } from '../tools/searchFilesTool.js';
import { executeCommandTool } from '../tools/executeCommandTool.js';
import { ensureFollowupOptions } from '../tools/toolExecutionProtocol.js';

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response
 * - Displays text content to the user
 * - Executes tool use requests (Phase 3: full implementation)
 * - Manages the flow of conversation
 *
 * Phase 3 Implementation Notes:
 * - Text content is fully implemented
 * - All tools are fully integrated with real implementations
 * - Complete error handling and user approval flows
 */
export async function presentAssistantMessage(task: Task): Promise<void> {
	if (task.abort) {
		throw new Error(`[presentAssistantMessage] task ${task.taskId}.${task.instanceId} aborted`);
	}

	// Locking mechanism to prevent concurrent execution
	if (task.presentAssistantMessageLocked) {
		task.presentAssistantMessageHasPendingUpdates = true;
		return;
	}

	task.presentAssistantMessageLocked = true;
	task.presentAssistantMessageHasPendingUpdates = false;

	// Check if we've processed all content blocks
	if (task.currentStreamingContentIndex >= task.assistantMessageContent.length) {
		// If streaming is finished and we're out of bounds, we're ready for next request
		if (task.didCompleteReadingStream) {
			task.userMessageContentReady = true;
		}

		task.presentAssistantMessageLocked = false;
		return;
	}

	// Get current content block (create copy to avoid race conditions)
	const block = JSON.parse(JSON.stringify(task.assistantMessageContent[task.currentStreamingContentIndex]));

	try {
		switch (block.type) {
			case 'text': {
				await handleTextBlock(task, block);
				break;
			}

			case 'tool_use': {
				await handleToolUseBlock(task, block);
				break;
			}

			default:
				console.warn(`[presentAssistantMessage] Unknown block type: ${(block as any).type}`);
				break;
		}
	} catch (error) {
		console.error('[presentAssistantMessage] Error processing block:', error);
		// On error, mark as ready to continue to avoid getting stuck
		task.userMessageContentReady = true;
	} finally {
		task.presentAssistantMessageLocked = false;

		// If there are pending updates, recursively call again
		if (task.presentAssistantMessageHasPendingUpdates) {
			await presentAssistantMessage(task);
		}
	}
}

/**
 * Handle text content block
 */
async function handleTextBlock(task: Task, block: AssistantMessageContent & { type: 'text' }): Promise<void> {
	if (task.didRejectTool || task.didAlreadyUseTool) {
		// Move to next block
		task.currentStreamingContentIndex++;
		return;
	}

	let content = block.content || '';

	// Remove thinking tags
	content = content.replace(/<thinking>\s?/g, '');
	content = content.replace(/\s?<\/thinking>/g, '');

	// Remove partial XML tags at the end
	const lastOpenBracketIndex = content.lastIndexOf('<');
	if (lastOpenBracketIndex !== -1) {
		const possibleTag = content.slice(lastOpenBracketIndex);
		const hasCloseBracket = possibleTag.includes('>');

		if (!hasCloseBracket) {
			let tagContent: string;
			if (possibleTag.startsWith('</')) {
				tagContent = possibleTag.slice(2).trim();
			} else {
				tagContent = possibleTag.slice(1).trim();
			}

			const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent);
			const isOpeningOrClosing = possibleTag === '<' || possibleTag === '</';

			if (isLikelyTagName || isOpeningOrClosing) {
				content = content.slice(0, lastOpenBracketIndex);
			}
		}
	}

	// Send text to user if not partial or if streaming is complete
	if (!block.partial || task.didCompleteReadingStream) {
		if (content.trim()) {
			await task.say('text', content, undefined, block.partial);
		}

		// Move to next block if complete
		if (!block.partial) {
			task.currentStreamingContentIndex++;
		}
	}
}

/**
 * Handle tool use block
 * Phase 3: Full implementation with real tool execution
 */
async function handleToolUseBlock(task: Task, block: AssistantMessageContent & { type: 'tool_use' }): Promise<void> {
	// Helper: Get tool description for logging
	const getToolDescription = (): string => {
		switch (block.name) {
			case 'execute_command':
				return `[${block.name} for '${block.params.command}']`;
			case 'read_file':
				return `[${block.name} for '${block.params.path}']`;
			case 'write_to_file':
				return `[${block.name} for '${block.params.path}']`;
			case 'list_files':
				return `[${block.name} for '${block.params.path || '.'}']`;
			case 'search_files':
				return `[${block.name} for '${block.params.regex}']`;
			case 'attempt_completion':
				return `[${block.name}]`;
			case 'ask_followup_question':
				return `[${block.name} for '${block.params.question}']`;
			default:
				return `[${block.name}]`;
		}
	};

	// Helper: Push tool result with proper format
	const pushToolResultWithToolUseId = (...items: Array<{ type: 'text'; text: string }>) => {
		if (block.toolUseId) {
			task.userMessageContent.push({
				type: 'tool_result',
				tool_use_id: block.toolUseId,
				content: items,
			});
		} else {
			task.userMessageContent.push(...items);
		}
	};

	// Helper: Push tool result
	const pushToolResult = (content: ToolResponse) => {
		const items: Array<{ type: 'text'; text: string }> = [];
		items.push({ type: 'text', text: `${getToolDescription()} Result:` });

		if (typeof content === 'string') {
			items.push({ type: 'text', text: content || '(tool did not return anything)' });
		} else {
			// content is already an array of text/image blocks
			items.push(...(content as Array<{ type: 'text'; text: string }>));
		}

		pushToolResultWithToolUseId(...items);

		// Once a tool result has been collected, ignore all other tool uses
		task.didAlreadyUseTool = true;
	};

	// Helper: Ask for user approval
	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
	): Promise<boolean> => {
		const { response, text, images } = await task.ask(type, partialMessage, false, undefined, false);

		if (response !== 'yesButtonTapped') {
			// User denied or provided feedback
			if (text) {
				await task.say('user_feedback', text, images);
				pushToolResult(`Tool denied with feedback: ${text}`);
			} else {
				pushToolResult('Tool denied by user');
			}
			task.didRejectTool = true;
			return false;
		}

		// User approved
		if (text) {
			await task.say('user_feedback', text, images);
			pushToolResult(`Tool approved with feedback: ${text}`);
		}

		return true;
	};

	// Helper: Handle errors
	const handleError = async (action: string, error: Error) => {
		const errorString = `Error ${action}: ${error.message}`;
		await task.say('error', `Error ${action}:\n${error.message}`);
		pushToolResult(`Error: ${errorString}`);
	};

	// Check if we should skip this tool
	if (task.didRejectTool) {
		// Ignore any tool content after user has rejected tool once
		if (!block.partial) {
			pushToolResultWithToolUseId({
				type: 'text',
				text: `Skipping tool ${getToolDescription()} due to user rejecting a previous tool.`,
			});
		} else {
			pushToolResultWithToolUseId({
				type: 'text',
				text: `Tool ${getToolDescription()} was interrupted and not executed due to user rejecting a previous tool.`,
			});
		}
		task.currentStreamingContentIndex++;
		return;
	}

	if (task.didAlreadyUseTool) {
		// Ignore any content after a tool has already been used
		pushToolResultWithToolUseId({
			type: 'text',
			text: `Tool [${block.name}] was not executed because a tool has already been used in this message. Only one tool may be used per message.`,
		});
		task.currentStreamingContentIndex++;
		return;
	}

	// Only record tool usage for complete (non-partial) blocks
	if (!block.partial) {
		task.recordToolUsage(block.name as ToolName);
	}

	const toolName = block.name;
	const params = block.params || {};

	console.log(`[handleToolUseBlock] Executing tool: ${toolName}`, params);

	// Execute the tool based on its name
	try {
		switch (toolName) {
			case 'attempt_completion': {
				// Task completion tool - always allowed
				const result = params.result || 'Task completed';
				await task.say('tool', getToolDescription(), undefined, false, { tool: toolName });
				pushToolResult(result);
				break;
			}

			case 'ask_followup_question': {
				// Ask user a question
				const question = params.question || '';
				const options = ensureFollowupOptions((params as any).options);
				const askExtra = options.length > 0 ? {
					metadata: {
						kiloCode: { options }
					}
				} : undefined;
				await task.say('tool', getToolDescription(), undefined, false, { tool: toolName });

				const { response, text, images } = await task.ask('followup', question, undefined, undefined, undefined, askExtra);

				if (response === 'messageResponse') {
					await task.say('user_feedback', text, images);
					pushToolResult(text || 'No response provided');
				} else {
					pushToolResult('User declined to answer');
				}
				break;
			}

			case 'execute_command': {
				// Execute a command - requires approval
				const command = params.command || '';
				const cwd = params.cwd;

				const toolMessage = `Command: ${command}${cwd ? `\nCWD: ${cwd}` : ''}`;
				await task.say('tool', toolMessage, undefined, false, { tool: toolName });

				if (await askApproval('command', `Execute command: ${command}?`)) {
					try {
						const result = await executeCommandTool(task, params);
						pushToolResult(result);
					} catch (error) {
						await handleError('executing command', error as Error);
					}
				}
				break;
			}

			case 'read_file': {
				// Read a file
				await task.say('tool', getToolDescription(), undefined, false, { tool: toolName });

				try {
					const result = await readFileTool(task, params);
					pushToolResult(result);
				} catch (error) {
					await handleError('reading file', error as Error);
				}
				break;
			}

			case 'write_to_file': {
				// Write to a file - requires approval
				const path = params.path || '';
				const content = params.content || '';

				const toolMessage = `Path: ${path}\nContent: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`;
				await task.say('tool', toolMessage, undefined, false, { tool: toolName });

				if (await askApproval('tool', `Write to file: ${path}?`)) {
					try {
						const result = await writeToFileTool(task, params);
						pushToolResult(result);
					} catch (error) {
						await handleError('writing file', error as Error);
					}
				}
				break;
			}

			case 'list_files': {
				// List files in directory
				await task.say('tool', getToolDescription(), undefined, false, { tool: toolName });

				try {
					const result = await listFilesTool(task, params);
					pushToolResult(result);
				} catch (error) {
					await handleError('listing files', error as Error);
				}
				break;
			}

			case 'search_files': {
				// Search files with regex
				await task.say('tool', getToolDescription(), undefined, false, { tool: toolName });

				try {
					const result = await searchFilesTool(task, params);
					pushToolResult(result);
				} catch (error) {
					await handleError('searching files', error as Error);
				}
				break;
			}

			default: {
				// Unknown tool
				console.warn(`[handleToolUseBlock] Unknown tool: ${toolName}`);
				pushToolResult(`Unknown tool: ${toolName} (not yet implemented)`);
				break;
			}
		}
	} catch (error) {
		await handleError(`executing ${toolName}`, error as Error);
	}

	// Move to next block
	task.currentStreamingContentIndex++;

	// Mark user content as ready
	task.userMessageContentReady = true;
}
