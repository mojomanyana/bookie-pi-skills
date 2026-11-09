export function wrapUntrustedSource(value: string): string {
  const lines: string[] = [];
  for (const originalLine of value.split("\n")) {
    const inertLine = Array.from(originalLine, (character) => {
      const code = character.charCodeAt(0);
      const unsafe =
        code <= 0x09 ||
        (code >= 0x0b && code <= 0x1f) ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return unsafe ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    }).join("");
    if (inertLine.length === 0) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < inertLine.length; offset += 1_000) {
      lines.push(inertLine.slice(offset, offset + 1_000));
    }
  }
  return lines.join("\n");
}
