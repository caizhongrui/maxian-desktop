/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/shared/combineApiRequests.ts
// Complete implementation

import type { ClineMessage } from '../types/taskTypes.js';

/**
 * Combines API request start and finish messages in an array of ClineMessages.
 *
 * This function looks for pairs of 'api_req_started' and 'api_req_finished' messages.
 * When it finds a pair, it combines them into a single 'api_req_started' message.
 * The JSON data in the text fields of both messages are merged.
 */
export function combineApiRequests(messages: ClineMessage[]): ClineMessage[] {
	if (messages.length === 0) {
		return [];
	}

	if (messages.length === 1) {
		return messages;
	}

	let isMergeNecessary = false;

	for (const msg of messages) {
		if (msg.type === 'say' && (msg.say === 'api_req_started' || msg.say === 'api_req_finished')) {
			isMergeNecessary = true;
			break;
		}
	}

	if (!isMergeNecessary) {
		return messages;
	}

	const result: ClineMessage[] = [];
	const startedIndices: number[] = [];

	for (const message of messages) {
		if (message.type !== 'say' || (message.say !== 'api_req_started' && message.say !== 'api_req_finished')) {
			result.push(message);
			continue;
		}

		if (message.say === 'api_req_started') {
			// Add to result and track the index.
			result.push(message);
			startedIndices.push(result.length - 1);
			continue;
		}

		// Find the most recent api_req_started that hasn't been combined.
		const startIndex = startedIndices.length > 0 ? startedIndices.pop() : undefined;

		if (startIndex !== undefined) {
			const startMessage = result[startIndex];
			let startData = {};
			let finishData = {};

			try {
				if (startMessage.text) {
					startData = JSON.parse(startMessage.text);
				}
			} catch (e) { }

			try {
				if (message.text) {
					finishData = JSON.parse(message.text);
				}
			} catch (e) { }

			result[startIndex] = { ...startMessage, text: JSON.stringify({ ...startData, ...finishData }) };
		}
	}

	return result;
}
