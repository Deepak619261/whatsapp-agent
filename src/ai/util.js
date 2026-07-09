// Sanitize an API key read from .env.
//
// API keys never contain spaces, so if the value has trailing whitespace or
// extra text (a very common .env mistake — pasting the key AND a trailing
// comment/annotation on the same line), we take only the first token. This
// prevents a cryptic crash: provider SDKs put the key in an HTTP header, and a
// stray emoji/comment there throws "Cannot convert argument to a ByteString".
export function cleanKey(name, raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const token = trimmed.split(/\s/)[0];
  if (token !== trimmed) {
    console.warn(
      `⚠️  ${name} had extra text after the key — using only the first token. ` +
        `Clean up your .env so the line is just ${name}=<key> with nothing after it.`
    );
  }
  return token;
}
