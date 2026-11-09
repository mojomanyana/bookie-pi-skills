import assert from "node:assert/strict";
import test from "node:test";
import { isDeliveryUrl, mentionsDeliveryUrl } from "../dist/delivery-url.js";

const guide = "https://web.dev/learn/css";

test("accepts a clean publisher URL and declines unsuitable addresses without rewriting the link", () => {
  for (const url of [
    guide,
    "https://www.w3.org/WAI/tutorials/",
    "https://web.dev",
    "https://developer.chrome.com/docs/accessibility",
    "https://x.example.com/a-developers-guide-to-tokens",
  ]) {
    assert.equal(isDeliveryUrl(url), true, url);
  }
  for (const url of [
    null,
    1,
    "",
    "http://web.dev/learn",
    " https://web.dev/learn",
    "https://localhost/doc",
    "https://weK.dev/guide",
    "https://invite.example.com/x1",
    "https://web.dev/private/plan",
    "https://svc.internal/doc",
    "https://wiki.home.arpa/doc",
    "https://127.0.0.1/doc",
    "https://2130706433/doc",
    "https://[::1]/doc",
    "https://u:p@web.dev/learn",
    "https://web.dev:443/learn",
    guide + "?key=value",
    guide + "#secret",
    "https://web.dev/invite/abc123",
    "https://web.dev/sharing/token/abc",
    "https://web.dev/ab3e251f25464bb6aaaa88911c8a6368",
    "https://web.dev/abc/../guide",
    "https://web.dev/%2Finvite/A",
    "https://web.dev/.private",
    "https://web.dev/learn\\@internal",
    "https://web.dev/learn\n",
    "https://web.dev/" + "x".repeat(2100),
  ]) {
    assert.equal(isDeliveryUrl(url), false, String(url));
  }
});

test("recognizes the exact destination of a visible bare, Markdown or reference link", () => {
  for (const text of [
    guide,
    "Visit " + guide + ".",
    "Course (" + guide + ").",
    "<" + guide + ">",
    "[Read the guide](" + guide + ")",
    "[Read the guide](<" + guide + '> "From the publisher")',
    "[Learn][guide].\n\n[guide]: " + guide,
  ]) {
    assert.equal(mentionsDeliveryUrl(text, guide), true, text);
  }
  for (const text of [
    guide + "-advanced",
    guide + "/extra",
    guide + "/extra?q=x",
    guide + "?code=1",
    guide + "#other",
    "https://redirect.example.org/?target=" + guide,
    "[" + guide + "](https://example.org/other)",
    "[" + guide + "][guide]\n\n[guide]: https://example.org/other",
    "[unused]: " + guide,
    "![diagram](" + guide + ")",
    "<!-- " + guide + " -->",
    '<a href="https://other.example.org">' + guide + "</a>",
    "`" + guide + "`",
    "```\n" + guide + "\n```",
    "x".repeat(66000) + " " + guide,
    "* ".repeat(1500) + guide,
  ]) {
    assert.equal(mentionsDeliveryUrl(text, guide), false, text.slice(0, 150));
  }
});
