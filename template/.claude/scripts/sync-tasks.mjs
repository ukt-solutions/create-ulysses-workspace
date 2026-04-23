// Mirror TodoWrite ↔ session.md ## Tasks section.
// Round-trips a flat task list across chats by persisting it on the session branch.

const IRREGULARS = {
  // Pre-built map for verbs whose gerund isn't a clean suffix transform.
  // Add entries as needed; the rule of thumb is "if the test catches it, fix here".
};

export function toActiveForm(content) {
  const trimmed = content.trim();
  const firstSpace = trimmed.indexOf(' ');
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace);

  const lower = verb.toLowerCase();
  if (IRREGULARS[lower]) return IRREGULARS[lower] + rest;

  let gerund;
  if (verb.endsWith('e') && !verb.endsWith('ee')) {
    gerund = verb.slice(0, -1) + 'ing';
  } else if (
    verb.length >= 3 &&
    /[aeiou]/.test(verb[verb.length - 2]) &&
    !/[aeiouwxy]/.test(verb[verb.length - 1])
  ) {
    // CVC pattern → double the final consonant (Run → Running)
    // Skip when ending in w/x/y (Show → Showing, Fix → Fixing).
    gerund = verb + verb[verb.length - 1] + 'ing';
  } else {
    gerund = verb + 'ing';
  }

  return gerund + rest;
}
