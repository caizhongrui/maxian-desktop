/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/shared/array.ts
// Complete implementation

/**
 * Finds the index of the last element in the array that matches the predicate
 * @param array Array to search
 * @param predicate Function to test each element
 * @returns Index of the last matching element, or -1 if not found
 */
export function findLastIndex<T>(array: T[], predicate: (value: T, index: number, obj: T[]) => boolean): number {
	for (let i = array.length - 1; i >= 0; i--) {
		if (predicate(array[i], i, array)) {
			return i;
		}
	}
	return -1;
}
