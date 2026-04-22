/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Utils Barrel Export
 *--------------------------------------------------------------------------------------------*/

export {
	DEFAULT_CHARS_PER_TOKEN,
	estimateTokensFromChars,
	estimateTokensFromText,
	estimateByteLength,
} from './tokenEstimate.js';

export { distance, similarity } from './levenshtein.js';

export {
	NORMALIZATION_MAPS,
	normalizeString,
	unescapeHtmlEntities,
} from './textNormalization.js';

export type { NormalizeOptions } from './textNormalization.js';

export {
	addLineNumbers,
	everyLineHasLineNumbers,
	stripLineNumbers,
} from './lineNumbers.js';

export { GlobalFileNames } from './globalFileNames.js';
export type { GlobalFileName } from './globalFileNames.js';
