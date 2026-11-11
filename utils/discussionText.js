export const DISCUSSION_JSON_LIMIT = '128kb';
export const DISCUSSION_CODE_UNITS_PER_CHARACTER = 32;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function discussionTextLength(text) {
    let count = 0;
    for (const _ of segmenter.segment(text)) count++;
    return count;
}
export function discussionLengthValid(text, limit = 1000) {
    return typeof text === 'string' && text.length <= limit * DISCUSSION_CODE_UNITS_PER_CHARACTER
        && text.isWellFormed() && discussionTextLength(text) <= limit;
}
