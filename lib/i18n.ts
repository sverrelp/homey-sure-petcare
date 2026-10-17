/** The part of `this.homey` that translates texts. */
interface Translator {
  __: (key: string, tokens?: object) => string;
}

/**
 * Translate a text and fill in its `{{token}}` placeholders.
 *
 * `homey.__` on the app side only replaces `__token__` placeholders. The locale files use `{{token}}`,
 * so the placeholders that are still in the text are filled in here. A token with no value becomes empty.
 */
export function translate(
  homey: Translator,
  key: string,
  tokens: Record<string, string | number | null | undefined> = {},
): string {
  const text = String(homey.__(key, tokens));
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const value = tokens[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export default translate;
