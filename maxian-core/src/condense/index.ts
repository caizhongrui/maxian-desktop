/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/condense/index.ts
// Simplified version for Phase 1 - Full implementation requires ApiHandler integration

import { ApiMessage } from '../task-persistence/apiMessages.js';

export const N_MESSAGES_TO_KEEP = 3;
export const MIN_CONDENSE_THRESHOLD = 5; // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100; // Maximum percentage of context window to trigger condensing

export type SummarizeResponse = {
	messages: ApiMessage[]; // The messages after summarization
	summary: string; // The summary text; empty string for no summary
	cost: number; // The cost of the summarization operation
	newContextTokens?: number; // The number of tokens in the context for the next API request
	error?: string; // Populated iff the operation fails: error message shown to the user on failure
};

/**
 * Summarizes the conversation messages using an LLM call
 *
 * NOTE: This is a placeholder implementation for Phase 1.
 * Full implementation requires ApiHandler and will be completed in Phase 2.
 *
 * @param messages - The conversation messages
 * @param apiHandler - The API handler to use for token counting (not used in Phase 1)
 * @param systemPrompt - The system prompt for API requests
 * @param taskId - The task ID for the conversation, used for telemetry
 * @param prevContextTokens - The number of tokens currently in the context
 * @param isAutomaticTrigger - Whether the summarization is triggered automatically
 * @param customCondensingPrompt - Optional custom prompt to use for condensing
 * @param condensingApiHandler - Optional specific API handler to use for condensing
 * @returns The result of the summarization operation
 */
export async function summarizeConversation(
	messages: ApiMessage[],
	apiHandler: any,
	systemPrompt: string,
	taskId: string,
	prevContextTokens: number,
	isAutomaticTrigger?: boolean,
	customCondensingPrompt?: string,
	condensingApiHandler?: any,
): Promise<SummarizeResponse> {
	// Phase 1: Return error indicating feature not yet implemented
	const error = 'Context condensing requires full ApiHandler integration (Phase 2)';
	return {
		messages,
		summary: '',
		cost: 0,
		error,
	};
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary);

	if (lastSummaryIndexReverse === -1) {
		return messages;
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1;
	const messagesSinceSummary = messages.slice(lastSummaryIndex);

	// Ensure the first message is a user message (required by some APIs like Bedrock)
	if (messagesSinceSummary.length > 0 && messagesSinceSummary[0].role !== 'user') {
		// Get the original first message (should always be a user message with the task)
		const originalFirstMessage = messages[0];
		if (originalFirstMessage && originalFirstMessage.role === 'user') {
			return [originalFirstMessage, ...messagesSinceSummary];
		} else {
			// Fallback to generic message if no original first message exists
			const userMessage: ApiMessage = {
				role: 'user',
				content: 'Please continue from the following summary:',
				ts: messages[0]?.ts ? messages[0].ts - 1 : Date.now(),
			};
			return [userMessage, ...messagesSinceSummary];
		}
	}

	return messagesSinceSummary;
}
