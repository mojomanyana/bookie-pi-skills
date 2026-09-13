export const secretPlaceholdersV1 = Object.freeze({
  structured: Object.freeze({ api_key: "not-a-secret" }),
  body: [
    "password=${PASSWORD}",
    "api_token=<redacted>",
    "secret=[REDACTED]",
    "",
  ].join("\n"),
});

export const secretDetectionV1 = Object.freeze([
  {
    name: "private key",
    value: ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
    placement: "body",
  },
  {
    name: "AWS access key",
    value: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    placement: "field",
  },
  {
    name: "GitHub token",
    value: ["ghp_", "1234567890abcdefghijABCDE"].join(""),
    placement: "field",
  },
  {
    name: "OpenAI token",
    value: ["sk-", "1234567890abcdefghijklmnopqrstuv"].join(""),
    placement: "field",
  },
  {
    name: "Slack token",
    value: ["xoxb-", "1234567890-abcdefghijkl"].join(""),
    placement: "field",
  },
  {
    name: "Stripe token",
    value: ["sk_live_", "1234567890abcdefghijkl"].join(""),
    placement: "field",
  },
  {
    name: "Google API key",
    value: `AIza${"A".repeat(35)}`,
    placement: "field",
  },
  {
    name: "credential URI",
    value: ["postgres", "//bookie", "S3cretPass@localhost/db"].join(":"),
    placement: "field",
  },
  {
    name: "256-byte credential URI password",
    value: ["postgres", "//bookie", `${"a".repeat(256)}@localhost/db`].join(
      ":",
    ),
    placement: "field",
  },
  {
    name: "257-byte credential URI password",
    value: ["postgres", "//bookie", `${"a".repeat(257)}@localhost/db`].join(
      ":",
    ),
    placement: "field",
  },
  {
    name: "structured secret",
    key: "aws_secret_access_key",
    value: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE", "KEY"].join(""),
    placement: "structured",
  },
  {
    name: "credential container",
    key: "credentials",
    value: "alice:CorrectHorseBatteryStaple1!",
    placement: "structured",
  },
  {
    name: "qualified password",
    key: "db_password",
    value: "CorrectHorseBatteryStaple1!",
    placement: "structured",
  },
  {
    name: "camel-case client secret",
    key: "prodClientSecret",
    value: "CorrectHorseBatteryStaple1!",
    placement: "structured",
  },
  {
    name: "API token",
    key: "api_token",
    value: "CorrectHorseBatteryStaple1!",
    placement: "structured",
  },
  {
    name: "low-entropy password",
    key: "password",
    value: "password",
    placement: "structured",
  },
  {
    name: "bracketed password",
    key: "password",
    value: "[CorrectHorseBatteryStaple1!]",
    placement: "structured",
  },
  {
    name: "angle-bracketed password",
    key: "password",
    value: "<CorrectHorseBatteryStaple1!>",
    placement: "structured",
  },
  {
    name: "nested credential field",
    key: "api_key",
    value: "CorrectHorseBatteryStaple1!",
    placement: "nested",
  },
  {
    name: "body assignment",
    value: ['password = "', 'CorrectHorseBatteryStaple1!"'].join(""),
    placement: "body",
  },
  {
    name: "256-byte quoted assignment",
    value: `password = "${"a".repeat(256)}"`,
    placement: "body",
  },
  {
    name: "257-byte quoted assignment",
    value: `password = "${"a".repeat(257)}"`,
    placement: "body",
  },
  {
    name: "qualified body token",
    value: ["api_", "token = CorrectHorseBatteryStaple1!"].join(""),
    placement: "body",
  },
  {
    name: "quoted assignment key",
    value: ["'api_", "key': 'CorrectHorseBatteryStaple1!'"].join(""),
    placement: "body",
  },
  {
    name: "JSON assignment",
    value: ['{"pass', 'word":"CorrectHorseBatteryStaple1!"}'].join(""),
    placement: "body",
  },
  {
    name: "low-entropy body assignment",
    value: ["pass", "word: pineapple"].join(""),
    placement: "body",
  },
  {
    name: "emphasized Markdown assignment",
    value: ["**Pass", "word:** CorrectHorseBatteryStaple1!"].join(""),
    placement: "body",
  },
  {
    name: "qualified Markdown assignment",
    value: ["Pass", "word (production): CorrectHorseBatteryStaple1!"].join(""),
    placement: "body",
  },
]);

export function secretCaseResourceText(secretCase) {
  if (
    secretCase.placement === "structured" ||
    secretCase.placement === "nested"
  ) {
    return `${secretCase.key}: ${secretCase.value}`;
  }
  return secretCase.value;
}

export function applySecretCase(frontmatter, secretCase) {
  delete frontmatter.export_probe;
  if (secretCase.placement === "field") {
    frontmatter.export_probe = { note: secretCase.value };
  } else if (secretCase.placement === "structured") {
    frontmatter.export_probe = { [secretCase.key]: secretCase.value };
  } else if (secretCase.placement === "nested") {
    frontmatter.export_probe = {
      [secretCase.key]: { value: secretCase.value },
    };
  }
  return frontmatter;
}
