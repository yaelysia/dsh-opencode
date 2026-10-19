import { failure } from './errors.js';

// DSH dsh-v0.2.1-rc.2 title providers frame { seq, text } human messages in JSON.
// Keep matching exact: user content inside the JSON is data, not another frame.
const GENERATE = 'Generate the session title from this JSON array of human messages:';
const UPDATE = 'Update the session title from this JSON object:';
const FRAME_TITLE = /^(?:Generate|Update) the session title from/u;
const MAX_CHARACTERS = 40;

function invalidInput() {
  // Do not echo a malformed request: it can contain private conversation text.
  return failure('Unsupported or malformed DSH session-title input', 'INVALID_TITLE_INPUT');
}

function parseFrame(input, prefix) {
  try { return JSON.parse(input.slice(prefix.length)); }
  catch { throw invalidInput(); }
}

function firstHumanText(messages) {
  if (!Array.isArray(messages) || messages.some(row => !row || typeof row.text !== 'string')) {
    throw invalidInput();
  }
  return messages.find(row => row.text.trim())?.text ?? '';
}

function excerpt(text) {
  const line = text.replace(/\s+/gu, ' ').trim();
  return Array.from(line).slice(0, MAX_CHARACTERS).join('') || 'New conversation';
}

/**
 * Produce a local first-message label, not a model-generated summary.
 * Only call this for purpose=session-title. Other chat requests are untouched.
 * @param {string} input Text from the title provider's user-role request.
 * @returns {string} Human text excerpt or an existing title for update requests.
 */
export function localSessionTitle(input) {
  const text = input.trim();
  if (text.startsWith(GENERATE)) {
    return excerpt(firstHumanText(parseFrame(text, GENERATE)));
  }
  if (text.startsWith(UPDATE)) {
    const frame = parseFrame(text, UPDATE);
    if (!frame || Array.isArray(frame) || typeof frame.currentTitle !== 'string') throw invalidInput();
    const first = firstHumanText(frame.messages);
    const current = frame.currentTitle.trim();
    // Keep good titles stable. Recover labels polluted by the 0.1.2 frame bug
    // when the host next requests an update; never write to the session store.
    if (current && !FRAME_TITLE.test(current)) return current;
    return excerpt(first);
  }
  // A changed/malformed frame must not become another instructional title.
  if (FRAME_TITLE.test(text)) throw invalidInput();
  return excerpt(text); // Compatibility with callers that send unframed text.
}
