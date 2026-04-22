/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/sliding-window/index.ts
// Complete implementation

import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from '../condense/index.js';
import { ApiMessage } from '../task-persistence/apiMessages.js';
import { estimateTokensFromChars } from '../utils/tokenEstimate.js';

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1;

/**
 * Default maximum tokens for Anthropic models
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * NOTE: This is a placeholder for Phase 1. Full implementation requires ApiHandler.
 * For now, we use a simple estimation based on content length.
 *
 * @param content - The content to count tokens for
 * @param apiHandler - The API handler to use for token counting (not used in Phase 1)
 * @returns A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<any>,
	apiHandler?: any,
): Promise<number> {
	if (!content || content.length === 0) {
		return 0;
	}

	// Simple estimation: ~4 characters per token (rough approximation)
	let totalChars = 0;
	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') {
			totalChars += block.text.length;
		} else if (typeof block === 'string') {
			totalChars += block.length;
		}
	}

	return estimateTokensFromChars(totalChars);
}

/**
 * Truncates a conversation by removing a fraction of the messages.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is removed.
 *
 * @param messages - The conversation messages
 * @param fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to remove
 * @param taskId - The task ID for the conversation, used for telemetry
 * @returns The truncated conversation messages
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): ApiMessage[] {
	// TODO: Add telemetry in Phase 2
	// TelemetryService.instance.captureSlidingWindowTruncation(taskId)

	const truncatedMessages = [messages[0]];
	const rawMessagesToRemove = Math.floor((messages.length - 1) * fracToRemove);
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2);
	const remainingMessages = messages.slice(messagesToRemove + 1);
	truncatedMessages.push(...remainingMessages);

	return truncatedMessages;
}

/**
 * Options for truncating conversation history
 */
export type TruncateOptions = {
	messages: ApiMessage[];
	totalTokens: number;
	contextWindow: number;
	maxTokens?: number | null;
	apiHandler?: any;
	autoCondenseContext: boolean;
	autoCondenseContextPercent: number;
	systemPrompt: string;
	taskId: string;
	customCondensingPrompt?: string;
	condensingApiHandler?: any;
	profileThresholds: Record<string, number>;
	currentProfileId: string;
};

export type TruncateResponse = SummarizeResponse & { prevContextTokens: number };

/**
 * Conditionally truncates the conversation messages if the total token count
 * exceeds the model's limit, considering the size of incoming content.
 *
 * @param options - The options for truncation
 * @returns The original or truncated conversation messages
 */
export async function truncateConversationIfNeeded({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	condensingApiHandler,
	profileThresholds,
	currentProfileId,
}: TruncateOptions): Promise<TruncateResponse> {
	let error: string | undefined;
	let cost = 0;

	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS;

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1];
	const lastMessageContent = lastMessage.content;
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: 'text', text: lastMessageContent as string }], apiHandler);

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens;

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens;

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent;
	const profileThreshold = profileThresholds[currentProfileId];
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent;
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold;
		} else {
			// Invalid threshold value, fall back to global setting
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			);
			effectiveThreshold = autoCondenseContextPercent;
		}
	}

	if (autoCondenseContext) {
		const contextPercent = (100 * prevContextTokens) / contextWindow;
		if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the context
			const result = await summarizeConversation(
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				prevContextTokens,
				true, // automatic trigger
				customCondensingPrompt,
				condensingApiHandler,
			);
			if (result.error) {
				error = result.error;
				cost = result.cost;
			} else {
				return { ...result, prevContextTokens };
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		const truncatedMessages = truncateConversation(messages, 0.5, taskId);
		return { messages: truncatedMessages, prevContextTokens, summary: '', cost, error };
	}

	// No truncation or condensation needed
	return { messages, summary: '', cost, prevContextTokens, error };
}
