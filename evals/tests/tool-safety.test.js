// Safety properties of the tool surface itself. No model involved: these are plain checks on what the tools
// declare and how they behave, so they run on every push.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "../runner/world.js";
import { LIMITS } from "../../site/model.js";

const fresh = () => makeWorld({ start: { selection: { id: "n3", text: "Nobody checks email." } } });
const READS = ["get_document", "get_section", "find_nodes", "get_selection", "get_view"];

// What each tool is called with in the checks below. A new tool fails the "has an example" test until it is added.
const EXAMPLE = {
  get_document: {},
  get_section: { heading: "Goals" },
  find_nodes: { query: "email" },
  get_selection: {},
  get_view: {},
  replace_selection: { text: "Phones stay in the car." },
  replace_text: { id: "n3", text: "A new line." },
  replace_nodes: { ids: ["n3"], nodes: [{ type: "paragraph", text: "One." }, { type: "list", items: ["a", "b"] }] },
  insert_nodes: { position: "end", nodes: [{ type: "paragraph", text: "Added." }] },
  insert_list_items: { list_id: "n5", items: ["Another item"] },
  delete_nodes: { ids: ["n10"] },
  set_title: { title: "A new title" },
};

const state = (w) => JSON.stringify(w.doc.serialize());
const call = (w, name, args) => w.tools.find((t) => t.name === name).run(args);
const text = (r) => r.content.map((c) => c.text).join("\n");

/** Every property name in an input schema, nested ones included. */
function propertyNames(schema, out = []) {
  for (const [k, v] of Object.entries(schema?.properties ?? {})) {
    out.push(k);
    propertyNames(v, out);
    if (v?.items) propertyNames(v.items, out);
  }
  return out;
}

/** Every string and array in a schema, so each can be checked for a ceiling. */
function unbounded(schema, path = "", out = []) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.type === "string" && !schema.enum && typeof schema.maxLength !== "number") out.push(`${path} (string)`);
  if (schema.type === "array" && typeof schema.maxItems !== "number") out.push(`${path} (array)`);
  for (const [k, v] of Object.entries(schema.properties ?? {})) unbounded(v, `${path}.${k}`, out);
  if (schema.items) unbounded(schema.items, `${path}[]`, out);
  return out;
}

describe("what the tools say about themselves is true", () => {
  const { tools } = fresh();

  it("every tool declares whether it is read-only, so a strict agent can classify it", () => {
    for (const t of tools) assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} must set readOnlyHint to true or false`);
  });

  it("every tool says it returns untrusted text and is not consequential", () => {
    for (const t of tools) {
      assert.equal(t.annotations.untrustedContentHint, true, `${t.name}: its results contain text people wrote`);
      assert.equal(t.annotations.consequentialHint, false, `${t.name}: nothing here reaches outside the page`);
    }
  });

  it("the deleting tool is marked destructive", () => {
    assert.equal(tools.find((t) => t.name === "delete_nodes").annotations.destructiveHint, true);
  });

  // Anthropic's connector directory needs a title on every tool and destructiveHint on every write.
  it("every tool has a title, and every write says whether it can overwrite or remove text", () => {
    for (const t of tools) {
      assert.ok(t.title, `${t.name} needs a title`);
      assert.equal(t.annotations.openWorldHint, false, `${t.name}: nothing here reaches outside the page`);
      if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, "boolean", `${t.name} must set destructiveHint`);
    }
    const adds = tools.filter((t) => t.annotations.destructiveHint === false).map((t) => t.name).sort();
    assert.deepEqual(adds, ["insert_list_items", "insert_nodes"], "only the tools that just add text are non-destructive");
  });

  it("every tool has an example here, so a new tool can't skip these checks", () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXAMPLE).sort());
  });

  it("the read-only ones are exactly the ones that read", () => {
    assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort(), [...READS].sort());
  });

  for (const [label, edited] of [["an unedited document", false], ["a document the person has been editing", true]]) {
    describe(`with ${label}`, () => {
      const setup = () => {
        const w = fresh();
        if (edited) {
          w.doc.nodes[0].text = "A line the person typed.";
          w.doc.userChanged();
        }
        return w;
      };

      it("a tool declared read-only changes nothing", async () => {
        for (const name of READS) {
          const w = setup();
          const before = state(w);
          const r = await call(w, name, EXAMPLE[name]);
          assert.ok(!r.isError, `${name}: ${text(r)}`);
          assert.equal(state(w), before, `${name} says it is read-only but changed the document`);
        }
      });

      it("a tool declared as changing things does change something", async () => {
        for (const name of Object.keys(EXAMPLE).filter((n) => !READS.includes(n))) {
          const w = setup();
          const before = state(w);
          const r = await call(w, name, EXAMPLE[name]);
          assert.ok(!r.isError, `${name}: ${text(r)}`);
          assert.notEqual(state(w), before, `${name} says it changes things but changed nothing`);
        }
      });
    });
  }

  it("a stale revision is refused and changes nothing", async () => {
    const w = fresh();
    const before = state(w);
    const r = await call(w, "replace_text", { id: "n3", text: "x", expected_revision: 99 });
    assert.equal(r.isError, true);
    assert.match(text(r), /changed since you read it/);
    assert.equal(state(w), before);
  });
});

describe("the tools don't ask for what they shouldn't, or hide what they do", () => {
  const { tools } = fresh();

  it("no parameter asks for contact, identity or payment details", () => {
    const risky = /(e-?mail|phone|address|ssn|password|passcode|card|cvv|birth|dob|passport|licen[sc]e)/i;
    for (const t of tools) assert.deepEqual(propertyNames(t.inputSchema).filter((n) => risky.test(n)), [], t.name);
  });

  it("no parameter asks for the person's own words, or for what they said to their agent", () => {
    const asks = /(^|_)(request|prompt|conversation|transcript|user_?message|message|history|context)(_|$)/i;
    for (const t of tools) assert.deepEqual(propertyNames(t.inputSchema).filter((n) => asks.test(n)), [], t.name);
  });

  it("no description asks the agent to repeat the person's words, to hide things, or to skip confirmation", () => {
    const bad = /(verbatim|in (their|the person'?s|the user'?s) own words|exact words|never tell|don'?t tell|do not tell|without telling|keep (this|it) secret|do not (mention|reveal)|without (asking|confirm)|no need to (ask|confirm)|skip (the )?confirmation)/i;
    for (const t of tools) {
      assert.equal(t.description.match(bad)?.[0], undefined, `${t.name}'s description`);
      assert.equal(JSON.stringify(t.inputSchema).match(bad)?.[0], undefined, `${t.name}'s input descriptions`);
    }
  });

  it("there is no tool that sends, shares, publishes, buys or reaches outside the page", () => {
    assert.deepEqual(tools.map((t) => t.name).filter((n) => /(send|e-?mail|mail|share|publish|post|export|upload|download|fetch|http|calendar|pay|purchase|buy|checkout|order|cart)/i.test(n)), []);
  });

  it("every string and list in every input schema has a ceiling", () => {
    for (const t of tools) assert.deepEqual(unbounded(t.inputSchema, t.name), []);
  });

  it("the ceilings the schemas advertise are the ones the tools enforce", async () => {
    const w = fresh();
    const r = await call(w, "replace_text", { id: "n3", text: "x".repeat(LIMITS.text + 1) });
    assert.equal(r.isError, true);
    const schema = w.tools.find((t) => t.name === "replace_text").inputSchema;
    assert.equal(schema.properties.text.maxLength, LIMITS.text);
  });
});

describe("hostile input doesn't get through", () => {
  const huge = "x".repeat(100_000);
  const refuses = async (name, args, pattern = /limit|must be/) => {
    const w = fresh();
    const before = state(w);
    const r = await call(w, name, args);
    assert.equal(r.isError, true, `${name} accepted ${JSON.stringify(args).slice(0, 60)}`);
    assert.match(text(r), pattern);
    assert.equal(state(w), before, `${name} changed the document while refusing`);
  };

  it("refuses a 100,000-character string in every free-text field, and changes nothing", async () => {
    await refuses("replace_text", { id: "n3", text: huge });
    await refuses("replace_text", { id: "i1", text: "y".repeat(LIMITS.item + 1) });
    await refuses("replace_selection", { text: huge });
    await refuses("set_title", { title: huge });
    await refuses("find_nodes", { query: huge });
    await refuses("get_section", { heading: huge });
    await refuses("insert_nodes", { position: "end", nodes: [{ type: "paragraph", text: huge }] });
    await refuses("insert_nodes", { position: "end", nodes: [{ type: "heading", text: "z".repeat(LIMITS.heading + 1) }] });
    await refuses("insert_nodes", { position: "end", nodes: [{ type: "list", items: [huge] }] });
    await refuses("insert_list_items", { list_id: "n5", items: [huge] });
    await refuses("replace_nodes", { ids: ["n3"], nodes: [{ type: "paragraph", text: huge }] });
  });

  it("refuses too many things in one call", async () => {
    await refuses("insert_nodes", { position: "end", nodes: Array.from({ length: LIMITS.nodes + 1 }, () => ({ type: "paragraph", text: "x" })) });
    await refuses("insert_list_items", { list_id: "n5", items: Array.from({ length: LIMITS.items + 1 }, () => "x") });
    await refuses("delete_nodes", { ids: Array.from({ length: LIMITS.ids + 1 }, (_, i) => `n${i}`) });
    await refuses("replace_nodes", { ids: Array.from({ length: LIMITS.ids + 1 }, (_, i) => `n${i}`), nodes: [{ type: "paragraph", text: "x" }] });
  });

  it("stops the document growing without end", async () => {
    const w = fresh();
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      const r = await call(w, "insert_nodes", { position: "end", nodes: Array.from({ length: LIMITS.nodes }, () => ({ type: "paragraph", text: "x" })) });
      refused = !!r.isError;
    }
    assert.ok(refused, "the document grew past its limit");
    assert.ok(w.doc.nodes.length <= LIMITS.docNodes);
  });

  it("keeps markup as plain text", async () => {
    const w = fresh();
    const markup = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await call(w, "replace_text", { id: "n3", text: markup });
    assert.equal(w.doc.locate("n3").node.text, markup);
  });

  it("treats made-up ids as not found, not as something to look up", async () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "../../etc/passwd", "", "n999"]) {
      const w = fresh();
      const before = state(w);
      for (const [name, args] of [["replace_text", { id, text: "x" }], ["delete_nodes", { ids: [id] }], ["insert_nodes", { position: "after", target: id, nodes: [{ type: "paragraph", text: "x" }] }]]) {
        const r = await call(w, name, args);
        assert.equal(r.isError, true, `${name} accepted id "${id}"`);
      }
      assert.equal(state(w), before);
    }
  });

  it("clamps heading levels, and rejects nonsense positions", async () => {
    const w = fresh();
    for (const level of [Number.NaN, -5, 0, 1e9, "7"]) {
      await call(w, "insert_nodes", { position: "end", nodes: [{ type: "heading", text: "h", level }] });
    }
    for (const n of w.doc.nodes.filter((n) => n.type === "heading")) assert.ok(n.level >= 1 && n.level <= 3, `level ${n.level}`);
    for (const block of [Number.NaN, -1, 0, 1.5, 1e9, "two"]) await refuses("replace_text", { heading: "Goals", block, text: "x" });
    await refuses("replace_text", { heading: "Schedule", block: 1, item: -3, text: "x" });
  });

  it("answers any garbage with an error result, never a crash", async () => {
    const garbage = [null, undefined, [], 5, "x", {}, { ids: "abc" }, { ids: [1, 2] }, { text: 5 }, { nodes: "x" }, { nodes: [null] }, { nodes: [{ type: "list", items: [[], {}] }] }, { items: {} }, { position: {} }, { id: {} }, { heading: [] }];
    for (const t of fresh().tools) {
      for (const g of garbage) {
        const w = fresh();
        const r = await call(w, t.name, g);
        assert.ok(Array.isArray(r.content), `${t.name}(${JSON.stringify(g)}) did not return a result`);
      }
    }
  });
});
