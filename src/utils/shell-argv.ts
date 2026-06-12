// Shell argv helpers quote and parse shell-style argument strings.
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

// POSIX double quotes only consume the backslash before a small escape set;
// preserving other backslashes keeps command-risk analysis byte-faithful.
function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

/** Splits a shell-like argv string into tokens, returning null for unterminated quotes or escapes. */
export function splitShellArgs(raw: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  // Quoted-empty words ("" / '') must survive as empty argv entries, so word
  // starts are tracked explicitly instead of inferred from buf.length.
  let wordActive = false;

  const pushToken = () => {
    if (wordActive || buf.length > 0) {
      tokens.push(buf);
      buf = "";
      wordActive = false;
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      // Inside double quotes, only POSIX-recognized escapes consume the backslash.
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      wordActive = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      wordActive = true;
      continue;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word; keep
    // inline hashes inside tokens (including after a quoted-empty word) so
    // URLs/fragments and post-quote text are not truncated.
    if (ch === "#" && buf.length === 0 && !wordActive) {
      break;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}
