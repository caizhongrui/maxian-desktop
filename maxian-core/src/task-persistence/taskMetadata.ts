/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/task-persistence/taskMetadata.ts
// Complete implementation

import NodeCache from 'node-cache';
import getFolderSize from 'get-folder-size';
import type { ClineMessage, HistoryItem } from '../types/taskTypes.js';
import { combineApiRequests } from '../shared/combineApiRequests.js';
import { combineCommandSequences } from '../shared/combineCommandSequences.js';
import { getApiMetrics } from '../shared/getApiMetrics.js';
import { findLastIndex } from '../shared/array.js';
import { getTaskDirectoryPath } from '../utils/storage.js';
import { t } from '../i18n/index.js';

const taskSizeCache = new NodeCache({ stdTTL: 30, checkperiod: 5 * 60 });

export type TaskMetadataOptions = {
	taskId: string;
	rootTaskId?: string;
	parentTaskId?: string;
	taskNumber: number;
	messages: ClineMessage[];
	globalStoragePath: string;
	workspace: string;
	mode?: string;
};

export async function taskMetadata({
	taskId: id,
	rootTaskId,
	parentTaskId,
	taskNumber,
	messages,
	globalStoragePath,
	workspace,
	mode,
}: TaskMetadataOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, id);

	// Determine message availability upfront
	const hasMessages = messages && messages.length > 0;

	// Pre-calculate all values based on availability
	let timestamp: number;
	let tokenUsage: ReturnType<typeof getApiMetrics>;
	let taskDirSize: number;
	let taskMessage: ClineMessage | undefined;

	if (!hasMessages) {
		// Handle no messages case
		timestamp = Date.now();
		tokenUsage = {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		};
		taskDirSize = 0;
	} else {
		// Handle messages case
		taskMessage = messages[0]; // First message is always the task say.

		const lastRelevantMessage =
			messages[findLastIndex(messages, (m) => !(m.type === 'ask' && (m.ask === 'resume_task' || m.ask === 'resume_completed_task')))] ||
			taskMessage;

		timestamp = (lastRelevantMessage as any).ts || Date.now();

		tokenUsage = getApiMetrics(combineApiRequests(combineCommandSequences(messages.slice(1))));

		// Get task directory size
		const cachedSize = taskSizeCache.get<number>(taskDir);

		if (cachedSize === undefined) {
			try {
				taskDirSize = await getFolderSize.loose(taskDir);
				taskSizeCache.set<number>(taskDir, taskDirSize);
			} catch (error) {
				taskDirSize = 0;
			}
		} else {
			taskDirSize = cachedSize;
		}
	}

	// Create historyItem once with pre-calculated values.
	const historyItem: HistoryItem & {
		rootTaskId?: string;
		parentTaskId?: string;
		number?: number;
		ts?: number;
		tokensIn?: number;
		tokensOut?: number;
		cacheWrites?: number;
		cacheReads?: number;
		totalCost?: number;
		size?: number;
		workspace?: string;
		mode?: string;
	} = {
		id,
		taskId: id,
		rootTaskId,
		parentTaskId,
		number: taskNumber,
		ts: timestamp,
		timestamp,
		task: hasMessages
			? taskMessage!.text?.trim() || t('tasks.incomplete', { taskNumber })
			: t('tasks.no_messages', { taskNumber }),
		status: hasMessages ? 'PROCESSING' as any : 'IDLE' as any,
		tokensIn: tokenUsage.totalTokensIn,
		tokensOut: tokenUsage.totalTokensOut,
		cacheWrites: tokenUsage.totalCacheWrites,
		cacheReads: tokenUsage.totalCacheReads,
		totalCost: tokenUsage.totalCost,
		size: taskDirSize,
		workspace,
		mode,
	};

	return { historyItem, tokenUsage };
}
