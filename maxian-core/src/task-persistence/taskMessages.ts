/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/task-persistence/taskMessages.ts
// Adapted for tianhe-zhikai-ide: complete implementation

import { safeWriteJson, getTaskDirectoryPath } from '../utils/storage.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileExistsAtPath } from '../utils/fsUtils.js';
import { GlobalFileNames } from '../utils/globalFileNames.js';
import type { ClineMessage } from '../types/taskTypes.js';

export type ReadTaskMessagesOptions = {
	taskId: string;
	globalStoragePath: string;
};

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId);
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages);
	const fileExists = await fileExistsAtPath(filePath);

	if (fileExists) {
		return JSON.parse(await fs.readFile(filePath, 'utf8'));
	}

	return [];
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[];
	taskId: string;
	globalStoragePath: string;
};

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId);
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages);
	await safeWriteJson(filePath, messages);
}
