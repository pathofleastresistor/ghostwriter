// The debug menu's log, report and Add to Claude link.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { note, list, clear, formatReport, claudeInstallLink, connectorUrl, reachableFromClaude } from "../../site/debuglog.js";

describe("the log", () => {
  it("keeps the newest 200 lines", () => {
    clear();
    for (let i = 0; i < 250; i++) note("app", `line ${i}`);
    assert.equal(list().length, 200);
    assert.equal(list().at(-1).text, "line 249");
    assert.equal(list()[0].text, "line 50");
  });

  it("cuts a very long line, and the report lists sections and the latest lines", () => {
    clear();
    note("api", "x".repeat(1000));
    assert.equal(list()[0].text.length, 400);
    const report = formatReport({ Page: { mode: "browser tab" } });
    assert.match(report, /\[Page\]\nmode: browser tab/);
    assert.match(report, /\[log: last 1 of 1\]/);
  });
});

describe("Add to Claude", () => {
  it("the connector is the site's origin plus /mcp, however the origin is written", () => {
    assert.equal(connectorUrl("https://ghostwriter.example"), "https://ghostwriter.example/mcp");
    assert.equal(connectorUrl("https://ghostwriter.example/"), "https://ghostwriter.example/mcp");
  });

  it("builds the documented install link, percent-encoded", () => {
    const link = claudeInstallLink("https://mcp.example.com/mcp", "Ghostwriter");
    assert.equal(link, "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Ghostwriter&connectorUrl=https%3A%2F%2Fmcp.example.com%2Fmcp");
    assert.doesNotMatch(claudeInstallLink("https://a.example/mcp", "My app"), /\+/);
  });

  it("only offers a link Claude can reach: https", () => {
    assert.ok(reachableFromClaude("https://ghostwriter.example/mcp"));
    assert.ok(!reachableFromClaude("http://127.0.0.1:3010/mcp"));
    assert.ok(!reachableFromClaude("javascript:alert(1)"));
  });
});
