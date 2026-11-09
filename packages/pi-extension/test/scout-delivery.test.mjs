import assert from "node:assert/strict";
import test from "node:test";
import { scoutDeliveryUrls } from "../dist/scout-delivery.js";

const url = "https://web.dev/learn";
const alternate = "https://example.org/unrelated";
const sha = "a".repeat(64);
function worker() {
  const source = { id: "course", locator: url, sha256: sha, title: "Course" };
  const citation = { sourceId: "course", locator: url, sha256: sha };
  // Deliberately omit any accessible raw body. Bookie may take locators only.
  Object.defineProperty(source, "text", {
    get: () => assert.fail("read source body"),
  });
  Object.defineProperty(citation, "quote", {
    get: () => assert.fail("read private quote"),
  });
  return {
    result: {
      type: "result",
      version: 1,
      status: "complete",
      requestId: "fixture",
      brief: {
        version: 1,
        findings: [{ status: "supported", citations: [citation, citation] }],
      },
      sources: [source, { id: "other", locator: alternate, sha256: sha }],
    },
    briefReference: { kind: "private-ref" },
  };
}

test("Scout delivery candidates are unique cited public source locators, without reading bodies", () => {
  assert.deepEqual(scoutDeliveryUrls(worker()), [url]);
});

test("withheld and incomplete worker results, malformed structure and excessive arrays yield no delivery candidates", () => {
  for (const edit of [
    (d) => {
      d.outputWithheld = true;
    },
    (d) => {
      d.result.status = "failed";
    },
    (d) => {
      d.result.version = 2;
    },
    (d) => {
      d.result.type = "progress";
    },
    (d) => {
      d.result.brief.version = 2;
    },
    (d) => {
      d.result.sources = Array(65).fill(d.result.sources[0]);
    },
    (d) => {
      d.result.brief.findings = Array(21).fill(d.result.brief.findings[0]);
    },
    (d) => {
      d.result.brief.findings[0].citations = Array(5).fill(
        d.result.brief.findings[0].citations[0],
      );
    },
  ]) {
    const data = worker();
    edit(data);
    assert.deepEqual(scoutDeliveryUrls(data), []);
  }
  for (const value of [null, { result: null }, { result: "text" }]) {
    assert.deepEqual(scoutDeliveryUrls(value), []);
  }
});

test("Scout citation identity ties the ID, exact locator and source snapshot hash together", () => {
  for (const patch of [
    { sourceId: "missing" },
    { locator: alternate },
    { sha256: "b".repeat(64) },
    { sourceId: undefined },
    { sha256: undefined },
    { sha256: "not-a-digest" },
  ]) {
    const data = worker();
    Object.assign(data.result.brief.findings[0].citations[0], patch);
    assert.deepEqual(scoutDeliveryUrls(data), []);
  }
  const ambiguous = worker();
  ambiguous.result.sources.push({
    id: "course",
    locator: alternate,
    sha256: sha,
  });
  assert.deepEqual(scoutDeliveryUrls(ambiguous), []);
});

test("private and local locators cannot become handoffs even with matching source identity", () => {
  for (const locator of [
    "file:///home/example/private",
    "https://localhost/a",
    "https://user:password@example.org/course",
    "search:exa:private phrase",
  ]) {
    const data = worker();
    data.result.sources[0].locator = locator;
    data.result.brief.findings[0].citations[0].locator = locator;
    assert.deepEqual(scoutDeliveryUrls(data), []);
  }
});
