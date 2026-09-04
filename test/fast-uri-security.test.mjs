import assert from "node:assert/strict";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

function uriResolver() {
  return new Ajv2020({ strict: true }).opts.uriResolver;
}

test("Ajv URI resolution rejects malformed bracketed IPv6 hosts", () => {
  const resolver = uriResolver();
  const malicious = "http://[::not-valid]/private";

  assert.equal(typeof resolver.parse(malicious).error, "string");
  assert.equal(resolver.normalize(malicious), malicious);
  assert.equal(resolver.parse("http://[::1]/private").error, undefined);
});

test("Ajv URI resolution does not double-decode encoded hostnames", () => {
  const resolver = uriResolver();
  const malicious = "http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/";

  assert.equal(resolver.normalize(malicious), malicious);
  assert.equal(
    resolver.normalize("http://example.com/"),
    "http://example.com/",
  );
});

test("Ajv URI resolution canonicalizes scheme-relative IDN hosts", () => {
  const resolver = uriResolver();
  const resolved = resolver.resolve(
    "https://example.test/base",
    "//täst.example/path",
  );

  assert.equal(resolved, resolver.normalize("https://täst.example/path"));
  assert.equal(resolved.includes("täst"), false);
});
