/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/task-persistence/index.ts
// Complete implementation

export { type ApiMessage, readApiMessages, saveApiMessages } from './apiMessages';
export { readTaskMessages, saveTaskMessages } from './taskMessages';
export { taskMetadata } from './taskMetadata';
