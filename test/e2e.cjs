// End-to-end check in a real browser: the real server, the MCP App's view inside a test host that
// behaves like Claude (SDK AppBridge, the CSP the resource declares), and the website on its own.
// Run: node test/e2e.cjs [screenshot-dir]
const { chromium } = require("playwright-core");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const shots = process.argv[2] ?? os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api_delete = (id) => fetch(`http://127.0.0.1:3011/api/docs/${id}`, { method: "DELETE" });

(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const esbuild = await import("esbuild");

  // The app server. PUBLIC_ORIGIN is where the view's assets and API calls point; the test host is a
  // different origin (port 3012), so the view's requests really are cross-origin, as they are in Claude.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-e2e-"));
  const server = spawn("node", ["server.js"], { cwd: root, env: { ...process.env, DATA_DIR: dataDir, PORT: "3011", PUBLIC_ORIGIN: "http://127.0.0.1:3011" }, stdio: "inherit" });
  await sleep(900);
  const client = new Client({ name: "claude-stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3011/mcp")));
  const call = async (name, arguments_ = {}) => {
    const r = await client.callTool({ name, arguments: arguments_ });
    assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
    return r;
  };

  const bundle = await esbuild.build({ entryPoints: [path.join(root, "test/host/host.js")], bundle: true, format: "esm", write: false, platform: "browser", logLevel: "silent" });
  const hostJs = bundle.outputFiles[0].text;
  const hostHtml = fs.readFileSync(path.join(root, "test/host/index.html"), "utf8");
  const host = http.createServer(async (req, res) => {
    if (req.url === "/call") {
      let body = "";
      for await (const c of req) body += c;
      const { name, arguments: a } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(await client.callTool({ name, arguments: a })));
    }
    if (req.url === "/view") {
      const { contents } = await client.readResource({ uri: "ui://ghostwriter/v2/editor.html" });
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ text: contents[0].text, meta: contents[0]._meta }));
    }
    if (req.url === "/host.js") return res.setHeader("content-type", "text/javascript"), res.end(hostJs);
    res.setHeader("content-type", "text/html");
    res.end(hostHtml);
  });
  await new Promise((r) => host.listen(3012, "127.0.0.1", r));

  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const problems = [];
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource.*404/.test(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  let failed = false;
  try {
    // ---- 1. The MCP App inside a host ----
    await page.goto("http://127.0.0.1:3012/");
    await page.waitForFunction(() => window.__ready);
    const frame = page.frameLocator("#app");
    const sample = (await call("list_documents")).structuredContent.documents[0].id;

    // Claude opens the app with no document: the person sees the list, inline
    await page.evaluate(() => window.__openApp({}));
    await frame.locator(".doc-card", { hasText: "Weekend at the lake" }).waitFor({ timeout: 10000 });
    assert.deepEqual(problems, [], "the view loaded under the CSP it declares, with no errors: " + problems.join(" | "));
    console.log("ok  the view loads under its declared permissions, cross-origin, and shows the document list");
    const html = frame.locator("html");
    assert.equal(await html.getAttribute("data-display"), "inline");
    assert.equal(await frame.locator(".appbar").evaluate((el) => getComputedStyle(el).position), "static", "inline, the page does not size itself to the frame");
    assert.notEqual(await html.getAttribute("data-embedded"), null);
    await page.screenshot({ path: path.join(shots, "1-view-list.png") });
    console.log("ok  the page knows it is embedded, and inline");

    // open a document from the list; Claude's server tools edit it live
    await frame.locator(".doc-open", { hasText: "Weekend at the lake" }).click();
    const editor = frame.locator("#editor");
    await editor.getByText("Nobody checks email.").waitFor({ timeout: 8000 });
    await call("replace_text", { document_id: sample, heading: "Goals", block: 1, text: "Rest, swim, and cook one proper dinner. Phones stay in the car." });
    await editor.getByText("Phones stay in the car.").waitFor({ timeout: 10000 });
    console.log("ok  an edit through Claude's server tools shows up live in the open view");

    // the person types; it is saved (the page is read-only while an agent's edit is being written out)
    const editable = () => page.waitForFunction(() => document.querySelector("#app").contentDocument.querySelector("#editor").isContentEditable);
    await editable();
    await editor.getByText("Phones stay in the car.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Dogs get the front seat.", { delay: 15 });
    await sleep(2000);
    assert.match(JSON.stringify((await call("get_document", { document_id: sample })).structuredContent), /Dogs get the front seat\./);
    console.log("ok  the person's typing in the view is saved");

    // Claude is told which document is open
    await page.waitForFunction((id) => window.__log.context.some((c) => c.includes(id)), sample);
    console.log("ok  Claude is told which document is open");

    // Ask AI: offered in a host, sends one clear message with the document and selection, then
    // closes its box and leaves full screen so the chat is in view
    const ask = frame.locator("#ask-ai");
    await ask.waitFor({ timeout: 5000 });
    await page.evaluate(() => window.__bridge.setHostContext({ displayMode: "fullscreen" }));
    await ask.click();
    await frame.locator("#ask-text").fill("Tighten the goals section.");
    await frame.locator("#ask-send").click();
    await page.waitForFunction(() => window.__log.messages.length === 1);
    const sent = await page.evaluate(() => window.__log.messages[0]);
    assert.match(sent, new RegExp(sample), "the message names the document");
    assert.match(sent, /Tighten the goals section\./);
    await frame.locator("#ask-pop").waitFor({ state: "hidden", timeout: 5000 });
    console.log("ok  Ask AI sends one message naming the document, then closes its box");
    await page.waitForFunction(() => window.__log.display?.at(-1) === "inline", null, { timeout: 5000 });
    console.log("ok  after sending, the editor leaves full screen so the chat is in view");

    // app tools: the page's own tools, offered to the host
    const listed = (await page.evaluate(() => window.__bridge.listTools({}))).tools;
    const names = listed.map((t) => t.name);
    for (const n of ["editor_get_document", "editor_replace_text", "editor_get_selection", "editor_replace_selection", "editor_insert_nodes"]) assert.ok(names.includes(n), n);
    assert.ok(names.every((n) => n.startsWith("editor_")));
    console.log(`ok  the view offers the host ${names.length} app tools, including the selection tools`);

    const read = await page.evaluate(() => window.__bridge.callTool({ name: "editor_get_document", arguments: {} }));
    assert.match(read.content[0].text, /Dogs get the front seat\./, "the app tool reads what is on screen, including the person's typing");
    console.log("ok  an app tool reads the document as the person sees it");

    // an app tool edit happens in the page itself: immediate, animated by the page, and then saved
    await page.evaluate(() => window.__bridge.callTool({ name: "editor_replace_text", arguments: { heading: "Goals", block: 1, text: "Rest, swim, and cook one proper dinner. Edited by an app tool." } }));
    await editor.getByText("Edited by an app tool.").waitFor({ timeout: 6000 });
    await sleep(2500);
    assert.match(JSON.stringify((await call("get_document", { document_id: sample })).structuredContent), /Edited by an app tool\./);
    console.log("ok  an app tool edit happens in the open page and is saved to the server");

    // selection: the thing only the page can see
    await editable();
    await editor.getByText("Rest, swim").first().click({ clickCount: 3 });
    await sleep(300);
    const sel = await page.evaluate(() => window.__bridge.callTool({ name: "editor_get_selection", arguments: {} }));
    assert.match(sel.content[0].text, /Rest, swim/);
    console.log("ok  Claude can read what the person has selected");
    await page.waitForFunction(() => window.__log.context.some((c) => c.includes("selected") && c.includes("Rest, swim")));

    // open_document with an id navigates the already-open view
    const other = (await call("create_document", { title: "Made by Claude" })).structuredContent.id;
    await page.evaluate((id) => window.__openApp({ document_id: id }), other);
    await frame.locator("#docname").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#app").contentDocument.querySelector("#docname")?.value === "Made by Claude");
    console.log("ok  open_document with an id opens that document in the view");

    // expand to the side panel
    await frame.locator("#expand").click();
    await page.waitForFunction(() => document.querySelector("#app").contentDocument.documentElement.dataset.display === "fullscreen");
    const barPosition = () => frame.locator(".appbar").evaluate((el) => getComputedStyle(el).position);
    assert.equal(await barPosition(), "sticky", "in the side panel the app bar sticks to the frame, as in the full site");
    assert.equal(await frame.locator("#expand").isHidden(), true, "no expand button once expanded");
    await page.screenshot({ path: path.join(shots, "2-view-expanded.png") });
    console.log("ok  Expand moves the view to the side panel, and the page switches to its full layout");

    // back to the list: editor tools say what to do instead of acting on nothing
    await page.evaluate(() => window.__openApp({}));
    await frame.locator(".doc-card").first().waitFor();
    const none = await page.evaluate(() => window.__bridge.callTool({ name: "editor_replace_text", arguments: { id: "n1", text: "x" } }));
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /open_document/);
    await page.waitForFunction(() => window.__log.context.some((c) => c.includes("list of documents")));
    console.log("ok  with no document open, editor tools explain how to open one, and Claude is told it is the list");
    assert.deepEqual(problems, [], "no console errors during the whole session: " + problems.join(" | "));
    await api_delete(other);

    // ---- 2. The web app: home, create, rename, copy, remove, search, and two editors ----
    const SITE = "http://127.0.0.1:3011/";
    const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const site = await ctx2.newPage();
    site.on("pageerror", (e) => console.log("[site pageerror]", e.message));
    const card = (p, name) => p.locator(".doc-card", { has: p.locator(".doc-name", { hasText: name }) });
    const serverTitles = async () => (await call("list_documents")).structuredContent.documents.map((d) => d.title);
    const docId = async (title) => (await call("list_documents")).structuredContent.documents.find((d) => d.title === title)?.id;

    // no key screen: the site opens straight on the list of documents
    await site.goto(SITE);
    await site.locator("#start-demo").waitFor({ timeout: 8000 });
    assert.equal(await site.locator("#gate").count(), 0, "there is no key screen");
    await card(site, "Weekend at the lake").waitFor();
    await site.screenshot({ path: path.join(shots, "4-home.png") });
    console.log("ok  the site opens straight on the list of documents, with no key");

    // create a blank document and write in it
    await site.locator("#new-blank").click();
    await site.locator("#editor-screen").waitFor({ state: "visible" });
    await site.keyboard.type("Trip notes", { delay: 20 });
    await site.keyboard.press("Enter");
    await site.keyboard.type("Pack the car on Friday.", { delay: 20 });
    await sleep(1800);
    if (!(await serverTitles()).includes("Trip notes")) {
      await site.screenshot({ path: path.join(shots, "fail-title.png") });
      console.log("titles on server:", JSON.stringify(await serverTitles()), "| editor shows:", JSON.stringify((await site.locator("#editor").innerText()).slice(0, 120)), "| hash:", new URL(site.url()).hash);
    }
    assert.ok((await serverTitles()).includes("Trip notes"), "title saved");
    const tripId = await docId("Trip notes");
    assert.match(JSON.stringify((await call("get_document", { document_id: tripId })).structuredContent), /Pack the car on Friday\./);
    assert.equal(await site.locator("#docname").inputValue(), "Trip notes");
    console.log("ok  a new blank document opens ready to type in, and is saved");

    // rename from the app bar
    await site.locator("#docname").fill("Trip to the coast");
    await sleep(1500);
    assert.ok((await serverTitles()).includes("Trip to the coast"));
    await site.locator("#editor .blk-title", { hasText: "Trip to the coast" }).waitFor();
    console.log("ok  renaming in the app bar renames the document and its title line");

    // back to home through the logo
    await site.locator(".brand").click();
    await card(site, "Trip to the coast").waitFor();
    console.log("ok  the logo goes back to the home screen, which lists the document");

    // rename, copy, remove and undo from the card menu
    await card(site, "Trip to the coast").locator(".doc-more").click();
    await site.getByRole("menuitem", { name: "Rename" }).click();
    await site.locator(".doc-rename").fill("Coast trip");
    await site.keyboard.press("Enter");
    await card(site, "Coast trip").waitFor();
    assert.ok((await serverTitles()).includes("Coast trip"));
    console.log("ok  rename from the card menu");

    await card(site, "Coast trip").locator(".doc-more").click();
    await site.getByRole("menuitem", { name: "Make a copy" }).click();
    await card(site, "Copy of Coast trip").waitFor();
    console.log("ok  make a copy");

    await card(site, "Copy of Coast trip").locator(".doc-more").click();
    await site.getByRole("menuitem", { name: "Remove" }).click();
    await card(site, "Copy of Coast trip").waitFor({ state: "detached" });
    await site.locator("#snack-undo").click();
    await card(site, "Copy of Coast trip").waitFor();
    console.log("ok  remove, then Undo brings it back");
    await card(site, "Copy of Coast trip").locator(".doc-more").click();
    await site.getByRole("menuitem", { name: "Remove" }).click();
    await card(site, "Copy of Coast trip").waitFor({ state: "detached" });
    assert.ok(!(await serverTitles()).includes("Copy of Coast trip"));

    // search and layout
    await site.locator("#search").fill("coast");
    await card(site, "Weekend at the lake").waitFor({ state: "detached" });
    assert.equal(await site.locator(".doc-card").count(), 1);
    await site.locator("#search").fill("zzzz");
    await site.locator(".docs-empty", { hasText: "No documents match" }).waitFor();
    await site.locator("#search").fill("");
    await site.locator("#view-list").click();
    await site.locator(".docs.as-list").waitFor();
    await site.screenshot({ path: path.join(shots, "5-home-list.png") });
    await site.locator("#view-grid").click();
    console.log("ok  search narrows the list, and the list layout works");

    // a document made elsewhere shows up on an open home screen
    const made = (await call("create_document", { title: "Made by Claude" })).structuredContent;
    await card(site, "Made by Claude").waitFor({ timeout: 8000 });
    console.log("ok  a document made elsewhere appears on the open home screen");

    // two editors on one document
    await card(site, "Coast trip").locator(".doc-open").click();
    await site.locator("#editor").getByText("Pack the car on Friday.").waitFor();
    const second = await ctx2.newPage();
    second.on("pageerror", (e) => console.log("[second pageerror]", e.message));
    await second.goto(SITE + "#/d/" + tripId);
    await second.locator("#editor").getByText("Pack the car on Friday.").waitFor({ timeout: 8000 });

    // an edit in one appears in the other, and the other's cursor is undisturbed
    await site.locator("#editor").getByText("Pack the car on Friday.").click();
    await site.keyboard.press("End");
    await site.keyboard.type(" Bring snacks.", { delay: 15 });
    await second.locator("#editor").getByText("Bring snacks.").waitFor({ timeout: 8000 });
    console.log("ok  typing in one editor shows up in the other");

    // both type at the same moment, in different places: both edits survive in both editors
    await site.locator("#editor .blk-title").click();
    await site.keyboard.press("End");
    await second.locator("#editor").getByText("Pack the car on Friday.").click();
    await second.keyboard.press("End");
    await Promise.all([site.keyboard.type(" (draft)", { delay: 25 }), second.keyboard.type(" Charge phones.", { delay: 25 })]);
    await sleep(3500);
    for (const [name, p] of [["first", site], ["second", second]]) {
      const text = await p.locator("#editor").innerText();
      assert.match(text, /\(draft\)/, `${name} editor lost the title edit`);
      assert.match(text, /Charge phones\./, `${name} editor lost the paragraph edit`);
      assert.match(text, /Bring snacks\./, `${name} editor lost the earlier edit`);
    }
    const merged = JSON.stringify((await call("get_document", { document_id: tripId })).structuredContent);
    assert.match(merged, /\(draft\)/);
    assert.match(merged, /Charge phones\./);
    console.log("ok  two editors typing at once in different places keep both edits, everywhere");

    // the cursor stays where it was when the other editor's change arrives
    await second.locator("#editor").getByText("Charge phones.").click();
    await second.keyboard.press("End");
    await call("set_title", { document_id: tripId, title: "Trip to the coast, v2" });
    await second.locator("#editor .blk-title", { hasText: "v2" }).waitFor({ timeout: 8000 });
    await second.waitForFunction(() => document.querySelector("#editor").isContentEditable); // the page is read-only while an agent writes
    await second.keyboard.type("!", { delay: 15 });
    await sleep(1500);
    const body = await second.locator("#editor .blk-paragraph").first().innerText();
    assert.match(body, /Charge phones\.!/, "typing continued at the cursor after the change arrived: " + body);
    assert.doesNotMatch(await second.locator("#editor .blk-title").innerText(), /!/, "the keystroke did not land in the title");
    console.log("ok  another editor's change arrives without moving the person's cursor");
    await site.screenshot({ path: path.join(shots, "6-editor.png") });

    // deleting a document closes it in the editors that have it open
    await fetch(`http://127.0.0.1:3011/api/docs/${tripId}`, { method: "DELETE" });
    await second.locator("#snack-text", { hasText: "was deleted" }).waitFor({ timeout: 8000 });
    await second.locator("#home").waitFor({ state: "visible" });
    console.log("ok  a document deleted elsewhere returns an open editor to the home screen");
    await api_delete(made.id);

    // a phone-width home screen
    await second.setViewportSize({ width: 420, height: 800 });
    await second.locator(".doc-card").first().waitFor();
    await second.screenshot({ path: path.join(shots, "7-home-narrow.png") });
    console.log("ok  the home screen renders at phone width");

    // the demo runs on its own document, never on yours
    await second.setViewportSize({ width: 1300, height: 800 });
    const before = (await serverTitles()).length;
    await second.locator("#start-demo").click();
    await second.locator("#editor").waitFor();
    await sleep(600);
    assert.equal((await serverTitles()).length, before + 1);
    assert.ok((await serverTitles()).includes("Demo: Weekend at the lake"));
    console.log("ok  Watch a demo makes its own document");
  } catch (e) {
    failed = true;
    console.log("FAIL", e.message);
    await page.screenshot({ path: path.join(shots, "fail.png") });
  }
  await browser.close();
  host.close();
  await client.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})();
