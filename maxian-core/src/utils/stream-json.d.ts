/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Type declarations for stream-json modules
declare module 'stream-json/Disassembler' {
	import { Transform } from 'stream';

	interface Disassembler extends Transform {
		disassembler(): Disassembler;
	}

	const disassembler: Disassembler;
	export = disassembler;
}

declare module 'stream-json/Stringer' {
	import { Transform } from 'stream';

	interface Stringer extends Transform {
		stringer(): Stringer;
	}

	const stringer: Stringer;
	export = stringer;
}
