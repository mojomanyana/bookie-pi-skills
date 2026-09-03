const privateKeyMarkers = [
  "PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "DSA PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "PGP PRIVATE KEY BLOCK",
].map((label) => `-----BEGIN ${label}-----`);

const knownCredentialPatterns = [
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?:$|[^A-Za-z0-9_])/,
  /(?:^|[^A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}(?:$|[^A-Za-z0-9-])/,
  /(?:^|[^A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}(?:$|[^A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?:$|[^A-Za-z0-9_-])/,
] as const;

const credentialUri = /[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s/:@]+:[^\s/@]+@/;

const textAssignment =
  /(?:^|[\s{[(,;])(?:\*\*|__)?["'`]?([A-Za-z][A-Za-z0-9_.-]*)(?:\s*\([^\r\n)]+\))?["'`]?\s*(?:(?:\*\*|__)\s*(?:=|:)|(?:=|:)\s*(?:\*\*|__)?)\s*(?:"([^"\r\n]+)"?|'([^'\r\n]+)'?|`([^`\r\n]+)`?|(\$\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|\[[^\]\r\n]+\]|<[^>\r\n]+>|[^\s"'`,;}\])]+))/g;

const credentialKeys = new Set([
  "password",
  "passwords",
  "passwd",
  "pwd",
  "secret",
  "secrets",
  "secretkey",
  "apikey",
  "apikeys",
  "accesskey",
  "accesstoken",
  "authtoken",
  "bearer",
  "bearertoken",
  "clientsecret",
  "privatekey",
  "token",
  "tokens",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "awssessiontoken",
  "databaseurl",
  "connectionstring",
  "credential",
  "credentials",
]);

const credentialWords = new Set([
  "credential",
  "credentials",
  "password",
  "passwords",
  "passwd",
  "pwd",
  "secret",
  "secrets",
  "token",
  "tokens",
  "bearer",
]);

const credentialWordPairs = new Set([
  "api:key",
  "private:key",
  "access:key",
  "auth:key",
  "database:url",
  "connection:string",
]);

const placeholderValues = new Set([
  "redacted",
  "masked",
  "placeholder",
  "example",
  "sample",
  "changeme",
  "change-me",
  "not-a-secret",
  "notasecret",
  "dummy",
  "fake",
  "none",
  "null",
  "undefined",
]);

function normalizedCredentialKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isCredentialKey(key: string): boolean {
  if (credentialKeys.has(normalizedCredentialKey(key))) return true;
  const words = key
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  if (words.some((word) => credentialWords.has(word))) return true;
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (credentialWordPairs.has(`${words[index]}:${words[index + 1]}`)) {
      return true;
    }
  }
  return false;
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return true;
  if (/^(?:\*+|x+|-+|\$\{[^}]+\}|\{\{[^}]+\}\})$/.test(normalized)) {
    return true;
  }
  const anglePlaceholder =
    normalized.startsWith("<") &&
    normalized.endsWith(">") &&
    !normalized.slice(1, -1).includes("<") &&
    !normalized.slice(1, -1).includes(">");
  const squarePlaceholder =
    normalized.startsWith("[") &&
    normalized.endsWith("]") &&
    !normalized.slice(1, -1).includes("[") &&
    !normalized.slice(1, -1).includes("]");
  if (anglePlaceholder || squarePlaceholder) {
    const label = normalized.slice(1, -1);
    if (
      placeholderValues.has(label) ||
      /^(?:password|secret|token|api[-_ ]?key)$/.test(label) ||
      /^your[-_ ](?:password|secret|token|api[-_ ]?key)$/.test(label)
    ) {
      return true;
    }
  }
  return placeholderValues.has(normalized);
}

function hasKnownCredentialSignature(value: string): boolean {
  return (
    privateKeyMarkers.some((marker) => value.includes(marker)) ||
    knownCredentialPatterns.some((pattern) => pattern.test(value)) ||
    credentialUri.test(value)
  );
}

function looksLikeCredentialValue(value: string): boolean {
  return !isPlaceholder(value);
}

function hasCredentialAssignment(value: string): boolean {
  textAssignment.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = textAssignment.exec(value)) !== null) {
    const key = match[1];
    const assigned = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (
      key !== undefined &&
      assigned !== undefined &&
      isCredentialKey(key) &&
      looksLikeCredentialValue(assigned)
    ) {
      return true;
    }
  }
  return false;
}

function stringContainsSecret(value: string): boolean {
  return hasKnownCredentialSignature(value) || hasCredentialAssignment(value);
}

export function containsDetectedSecret(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly key?: string }> = [
    { value },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (typeof current.value === "string") {
      if (
        stringContainsSecret(current.value) ||
        (current.key !== undefined &&
          isCredentialKey(current.key) &&
          looksLikeCredentialValue(current.value))
      ) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({
          value: item,
          ...(current.key === undefined ? {} : { key: current.key }),
        });
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const inheritedKey =
      current.key !== undefined && isCredentialKey(current.key)
        ? current.key
        : undefined;
    for (const [key, child] of Object.entries(current.value)) {
      if (stringContainsSecret(key)) return true;
      pending.push({
        value: child,
        key: isCredentialKey(key) ? key : (inheritedKey ?? key),
      });
    }
  }
  return false;
}
