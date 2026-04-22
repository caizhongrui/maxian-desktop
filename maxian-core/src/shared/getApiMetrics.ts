/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/shared/getApiMetrics.ts
// Complete implementation

import type { TokenUsage, ClineMessage } from '../types/taskTypes.js';
import { safeJsonParse } from './safeJsonParse.js';

export type ParsedApiReqStartedTextType = {
	tokensIn: number;
	tokensOut: number;
	cacheWrites: number;
	cacheReads: number;
	cost?: number; // Only present if combineApiRequests has been called
	apiProtocol?: 'anthropic' | 'openai';
};

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes 'condense_context' messages and 'api_req_started' messages that have been
 * combined with their corresponding 'api_req_finished' messages by the combineApiRequests function.
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 */
export function getApiMetrics(messages: ClineMessage[]) {
	const result: TokenUsage = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
		contextTokens: 0,
	};

	// Calculate running totals.
	messages.forEach((message) => {
		if (message.type === 'say' && message.say === 'api_req_started' && message.text) {
			try {
				const parsedText: ParsedApiReqStartedTextType = JSON.parse(message.text);
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = parsedText;

				if (typeof tokensIn === 'number') {
					result.totalTokensIn = (result.totalTokensIn || 0) + tokensIn;
				}

				if (typeof tokensOut === 'number') {
					result.totalTokensOut = (result.totalTokensOut || 0) + tokensOut;
				}

				if (typeof cacheWrites === 'number') {
					result.totalCacheWrites = (result.totalCacheWrites || 0) + cacheWrites;
				}

				if (typeof cacheReads === 'number') {
					result.totalCacheReads = (result.totalCacheReads || 0) + cacheReads;
				}

				if (typeof cost === 'number') {
					result.totalCost = (result.totalCost || 0) + cost;
				}
			} catch (error) {
				console.error('Error parsing JSON:', error);
			}
		} else if (message.type === 'say' && message.say === 'condense_context') {
			// Handle condense_context messages if they have contextCondense property
			const contextCondense = (message as any).contextCondense;
			result.totalCost = (result.totalCost || 0) + (contextCondense?.cost || 0);
		} else {
			// Handle tool messages with fastApplyResult
			if (message.type === 'ask' && message.ask === 'tool' && message.text) {
				const fastApplyResult = safeJsonParse<any>(message.text)?.fastApplyResult;
				result.totalTokensIn = (result.totalTokensIn || 0) + (fastApplyResult?.tokensIn || 0);
				result.totalTokensOut = (result.totalTokensOut || 0) + (fastApplyResult?.tokensOut || 0);
				result.totalCost = (result.totalCost || 0) + (fastApplyResult?.cost || 0);
			}
		}
	});

	// Calculate context tokens, from the last API request started or condense context message.
	result.contextTokens = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];

		if (message.type === 'say' && message.say === 'api_req_started' && message.text) {
			try {
				const parsedText: ParsedApiReqStartedTextType = JSON.parse(message.text);
				const { tokensIn, tokensOut } = parsedText;

				// Since tokensIn now stores TOTAL input tokens (including cache tokens),
				// we no longer need to add cacheWrites and cacheReads separately.
				// This applies to both Anthropic and OpenAI protocols.
				result.contextTokens = (tokensIn || 0) + (tokensOut || 0);
			} catch (error) {
				console.error('Error parsing JSON:', error);
				continue;
			}
		} else if (message.type === 'say' && message.say === 'condense_context') {
			const contextCondense = (message as any).contextCondense;
			result.contextTokens = contextCondense?.newContextTokens || 0;
		}
		if (result.contextTokens) {
			break;
		}
	}

	return result;
}

/**
 * Check if token usage has changed by comparing relevant properties.
 * @param current - Current token usage data
 * @param snapshot - Previous snapshot to compare against
 * @returns true if any relevant property has changed or snapshot is undefined
 */
export function hasTokenUsageChanged(current: TokenUsage, snapshot?: TokenUsage): boolean {
	if (!snapshot) {
		return true;
	}

	const keysToCompare: (keyof TokenUsage)[] = [
		'totalTokensIn',
		'totalTokensOut',
		'totalCacheWrites',
		'totalCacheReads',
		'totalCost',
		'contextTokens',
	];

	return keysToCompare.some((key) => current[key] !== snapshot[key]);
}
