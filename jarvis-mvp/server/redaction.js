const SENSITIVE_KEY_PATTERN = /([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)["']?[^"',\s}]+/gi;
const OPENAI_KEY_PATTERN = /sk-[A-Za-z0-9_-]{12,}/g;
const GITHUB_TOKEN_PATTERN = /gh[opsu]_[A-Za-z0-9_]{12,}/g;
const ENV_PATH_PATTERN = /(?:[A-Za-z]:)?[^\s"'`]*\.env(?:\.[A-Za-z0-9_-]+)?/g;

export function redactText(value) {
  return String(value)
    .replace(SENSITIVE_KEY_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_OPENAI_KEY]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED_GITHUB_TOKEN]")
    .replace(ENV_PATH_PATTERN, "[REDACTED_ENV_PATH]");
}

export function redactObject(value) {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? "[REDACTED]" : redactObject(item)
  ]));
}

function isSensitiveKey(key) {
  return /(?:key|token|secret|password)/i.test(key);
}
