/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/checkpoints/index.ts
// Phase 3: Complete Git integration implementation

export {
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
	checkpointList,
} from './checkpointGit.js';

/**
 * Gets or initializes the checkpoint service for a task
 * Phase 3: Not needed with direct Git integration
 */
export async function getCheckpointService(task: any, { interval = 250 }: { interval?: number } = {}): Promise<any | undefined> {
	return undefined;
}
