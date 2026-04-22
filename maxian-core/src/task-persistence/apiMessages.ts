/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/task-persistence/apiMessages.ts
// Adapted for tianhe-zhikai-ide: complete implementation with generic API message types

import { safeWriteJson, getTaskDirectoryPath } from '../utils/storage.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileExistsAtPath } from '../utils/fsUtils.js';
import { GlobalFileNames } from '../utils/globalFileNames.js';

/**
 * Generic API message type compatible with various LLM APIs
 * Based on Anthropic MessageParam format
 */
export interface ApiMessageContent {
	type: 'text' | 'image';
	text?: string;
	source?: {
		type: 'base64';
		media_type: string;
		data: string;
	};
}

export interface ApiMessage {
	role: 'user' | 'assistant';
	content: string | ApiMessageContent[];
	ts?: number;
	isSummary?: boolean;
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string;
	globalStoragePath: string;
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId);
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory);

	if (await fileExistsAtPath(filePath)) {
		const fileContent = await fs.readFile(filePath, 'utf8');
		try {
			const parsedData = JSON.parse(fileContent);
			if (Array.isArray(parsedData) && parsedData.length === 0) {
				console.error(
					`[Maxian-Debug] readApiMessages: Found API conversation history file, but it's empty (parsed as []). TaskId: ${taskId}, Path: ${filePath}`,
				);
			}
			return parsedData;
		} catch (error) {
			console.error(
				`[Maxian-Debug] readApiMessages: Error parsing API conversation history file. TaskId: ${taskId}, Path: ${filePath}, Error: ${error}`,
			);
			throw error;
		}
	} else {
		// Check for legacy file name
		const oldPath = path.join(taskDir, 'claude_messages.json');

		if (await fileExistsAtPath(oldPath)) {
			const fileContent = await fs.readFile(oldPath, 'utf8');
			try {
				const parsedData = JSON.parse(fileContent);
				if (Array.isArray(parsedData) && parsedData.length === 0) {
					console.error(
						`[Maxian-Debug] readApiMessages: Found OLD API conversation history file (claude_messages.json), but it's empty (parsed as []). TaskId: ${taskId}, Path: ${oldPath}`,
					);
				}
				await fs.unlink(oldPath);
				return parsedData;
			} catch (error) {
				console.error(
					`[Maxian-Debug] readApiMessages: Error parsing OLD API conversation history file (claude_messages.json). TaskId: ${taskId}, Path: ${oldPath}, Error: ${error}`,
				);
				// DO NOT unlink oldPath if parsing failed, throw error instead.
				throw error;
			}
		}
	}

	// If we reach here, neither the new nor the old history file was found.
	console.error(
		`[Maxian-Debug] readApiMessages: API conversation history file not found for taskId: ${taskId}. Expected at: ${filePath}`,
	);
	return [];
}

export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
}: {
	messages: ApiMessage[];
	taskId: string;
	globalStoragePath: string;
}) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId);
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory);
	await safeWriteJson(filePath, messages);
}
