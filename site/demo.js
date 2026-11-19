// The "Watch a demo" button. It plays a scripted session of what a person's
// own agent does around a request: work out the intent, consult its memory, reach
// into connected services, run background tasks, then make real WebMCP calls on this
// page. The calls are real; the memory and services are simulated for the demo.

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// Nobody is watching a hidden tab, so don't wait on throttled timers.
const wait = (ms) => new Promise((r) => setTimeout(r, document.hidden ? 0 : calm() ? Math.min(ms, 200) : ms));

// One knob for the pace of the whole session.
const TEMPO = 1.6;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createDemo({ view, doc, tools }) {
  /* ------------------------------- the panel ------------------------------- */

  const panel = el("div", "agent");
  panel.hidden = true;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  const bar = el("div", "agent-bar");
  const dots = el("span", "agent-dots");
  const dot = (cls, label, fn) => {
    const b = el("button", "dot " + cls);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  dots.append(
    dot("dot-close", "Close", () => {
      panel.hidden = true; // the session carries on in the background
      pad();
    }),
    dot("dot-min", "Minimise", () => {
      panel.classList.add("compact");
      pad();
    }),
    dot("dot-max", "Expand", () => {
      panel.classList.remove("compact");
      pad();
    }),
  );
  bar.append(dots, el("span", "agent-title", "Your agent"));
  const head = el("div", "agent-head");
  const avatar = el("span", "agent-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>';
  const who = el("div", "agent-id");
  who.append(el("span", "agent-name", "Your agent"), el("span", "agent-sub", "Your own AI, working beside this page"));
  const state = el("span", "polr-chip polr-chip--info", "Working");
  head.append(avatar, who, state);
  const link = el("div", "agent-link");
  link.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
  link.append(el("span", "value", `Connected to ${location.host}`));
  const said = el("p", "agent-said");
  const steps = el("ol", "agent-steps");
  const note = el("p", "caption agent-note", "This is a demo. The memory and services here are made up. The edits to the page are real.");
  panel.append(bar, head, link, said, steps, note);
  document.body.append(panel);
  panel.addEventListener("click", () => {
    panel.classList.toggle("compact");
    pad();
  });

  /** On phones the panel is a bottom sheet. How much of the screen it covers, from the bottom. */
  function cover() {
    if (panel.hidden) return 0;
    const r = panel.getBoundingClientRect();
    return r.width > innerWidth * 0.7 ? Math.max(0, innerHeight - r.top) : 0;
  }
  // Let the page scroll far enough that its last lines clear the sheet.
  const pad = () => {
    document.body.style.paddingBottom = panel.hidden || !cover() ? "" : `${Math.round(cover()) + 16}px`;
  };

  const scroll = () => (steps.scrollTop = steps.scrollHeight);

  function addStep(tag, text, callName = "") {
    const li = el("li", "step run");
    const ico = el("span", "s-ico");
    ico.setAttribute("aria-hidden", "true");
    const body = el("div", "s-body");
    const t = el("span", "s-tag" + (callName ? " s-call" : ""), tag);
    const p = el("p", "s-text", text);
    const fn = callName ? el("p", "s-fn value", callName) : null;
    const out = el("p", "s-out value");
    out.hidden = true;
    body.append(t, p);
    if (fn) body.append(fn);
    body.append(out);
    li.append(ico, body);
    steps.append(li);
    scroll();
    return {
      done(newText) {
        li.classList.replace("run", "ok");
        if (newText) p.textContent = newText;
        scroll();
      },
      out(text) {
        out.textContent = text;
        out.hidden = false;
        scroll();
      },
    };
  }

  let sent = false;

  /** The agent hands its edit back to the site before the page changes. */
  async function sendToSite() {
    sent = true;
    link.classList.add("sending");
    const s = addStep("Sending", "Sending the change to the page…");
    await wait(1300 * TEMPO);
    s.done("Delivered. The page is updating.");
    link.classList.remove("sending");
    await wait(900);
  }

  async function runStep(spec, delay = 0) {
    if (delay) await wait(delay);
    const edits = spec.call && !/^get_/.test(spec.call);
    if (edits && !sent) await sendToSite();
    // Once the real edit starts, shrink the panel so the page behind it is visible.
    if (edits) panel.classList.add("compact");
    const s = addStep(spec.tag, spec.pending ?? spec.say ?? spec.call, spec.say ? spec.call : "");
    if (spec.run) {
      const summary = await spec.run();
      await wait(600);
      s.done();
      if (summary) s.out(summary);
    } else {
      await wait((spec.ms ?? 900) * TEMPO);
      s.done(spec.done);
    }
  }

  async function say(text) {
    said.textContent = "";
    await wait(500); // half a beat to settle in before the typing starts
    said.classList.add("typing");
    if (calm() || document.hidden) said.textContent = text;
    else
      for (let n = 1; n <= text.length; n++) {
        said.textContent = text.slice(0, n);
        await wait(38);
      }
    said.classList.remove("typing");
    await wait(1000);
  }

  const idle = async () => {
    while (view.locked || view.running || view.queue.length) await wait(150);
  };

  /** Run a real tool and return a one-line summary for the step. */
  const call = (name, args) => async () => {
    const r = await tools[name](args);
    return (r.content?.[0]?.text ?? "").split("\n")[0].slice(0, 150);
  };

  /* -------------------------------- scenarios ------------------------------- */

  const firstPara = () => doc.nodes.find((n) => n.type === "paragraph");
  const byText = (s) => doc.nodes.find((n) => n.type === "paragraph" && n.text.includes(s));
  const heading = (t) => doc.nodes.find((n) => n.type === "heading" && n.text === t);
  const listUnder = (t) => {
    const h = heading(t);
    return h ? doc.nodes[doc.nodes.indexOf(h) + 1] : null;
  };

  const scenarios = [
    // 0: the plan changes, so the schedule and everything that leaned on it has to change
    () => {
      const sch = listUnder("Schedule");
      if (!sch || sch.type !== "list" || !sch.items[0]?.text.includes("5:30")) return null;
      const intro = byText("driving up Friday");
      const notes = heading("Notes");
      return {
        ask: "Change of plans: we're leaving a day late because of the kids' school concert. Can you update the schedule?",
        outcome: "Updated the Schedule, the opening and Notes for a Saturday arrival, and drafted a message to the host for you to send.",
        steps: [
          { tag: "Understanding", pending: "Working out what you mean…", done: "Friday's drive moves to Saturday. Anything that depended on Friday needs a second look.", ms: 1000 },
          { par: [
            { tag: "Memory", pending: "Checking what I know about your trips…", done: "You don't like shopping after a long drive. Last time you picked up groceries on the way.", ms: 1300 },
            { tag: "Calendar", pending: "Checking your calendar…", done: "School concert is Friday at 4:30 pm. You're free to leave Saturday morning.", ms: 1700 },
            { tag: "Mail", pending: "Checking the cabin booking in your email…", done: "Check-in is open until 9 pm, so a Saturday arrival is fine.", ms: 1900 },
          ] },
          { tag: "Page", say: "Reading the Schedule section", call: "get_section(“Schedule”)", run: call("get_section", { heading: "Schedule" }) },
          { tag: "Thinking", pending: "Re-planning the weekend around a later start…", done: "Leaving at 9 am gets you there by 1 pm with the grocery stop on the way. Paddleboarding moves to the afternoon.", ms: 1600 },
          { tag: "Page", say: "Moving the drive to Saturday morning", call: "replace_text(Schedule › item 1, …)", run: call("replace_text", { heading: "Schedule", block: 1, item: 1, text: "Saturday: leave by 9 am, stop for groceries in Issaquah, arrive by 1 pm" }) },
          { tag: "Page", say: "Moving paddleboarding to the afternoon", call: "replace_text(Schedule › item 2, …)", run: call("replace_text", { heading: "Schedule", block: 1, item: 2, text: "Saturday afternoon: long lunch, paddleboards, nap" }) },
          ...(intro ? [
            { tag: "Thinking", pending: "Checking the rest of the page for Friday…", done: "The opening still says you're driving up Friday. Fixing that too.", ms: 1200 },
            { tag: "Page", say: "Updating the opening", call: `replace_text(${intro.id}, …)`, run: call("replace_text", { id: intro.id, text: intro.text.replace("Friday after work", "Saturday morning") }) },
          ] : []),
          { par: [
            { tag: "Page", say: "Adding a note about check-in", call: notes ? "insert_nodes(end of Notes, …)" : "insert_nodes(end, …)", run: call("insert_nodes", { position: notes ? "end_of_section" : "end", target: notes ? "Notes" : undefined, nodes: [{ type: "paragraph", text: "Arriving Saturday around 1 pm instead of Friday night. The host's check-in is open until 9 pm." }] }) },
            { tag: "Drafts", pending: "Writing a message to the cabin host…", done: "Draft ready: you'll arrive around 1 pm on Saturday. Waiting for you to send it.", ms: 1900 },
          ] },
        ],
      };
    },

    // 1: talk about "this", with a selection
    () => {
      const phrase = "Nobody checks email.";
      const leaf = [...document.querySelectorAll("#editor [data-id]")].find((e) => e.textContent.includes(phrase));
      if (!leaf) return null;
      return {
        before: async () => {
          const at = leaf.textContent.indexOf(phrase);
          view.setSelection(leaf, at, leaf, at + phrase.length);
          await wait(900);
        },
        ask: "Make this sentence more fun.",
        outcome: "Updated the Goals section. Rewrote one sentence to be more fun.",
        steps: [
          { tag: "Understanding", pending: "Working out what you mean…", done: "“This” is the sentence you have selected. Keep it short and playful.", ms: 1000 },
          { par: [
            { tag: "Memory", pending: "Checking what I know about your writing…", done: "You like short, plain sentences with a light touch. Nothing cutesy.", ms: 1300 },
            { tag: "Context", pending: "Reading the paragraph around it…", done: "The paragraph is about rest. The joke should be about leaving work behind.", ms: 1700 },
          ] },
          { tag: "Page", say: "Reading what you have selected", call: "get_selection()", run: call("get_selection", {}) },
          { tag: "Thinking", pending: "Drafting three options and picking one…", done: "Picked the version closest to your voice.", ms: 1300 },
          { tag: "Page", say: "Rewriting your selection", call: "replace_selection(“The inbox stays closed all weekend.”)", run: call("replace_selection", { text: "The inbox stays closed all weekend.", expected_text: phrase }) },
        ],
      };
    },

    // 1: tighten the opening
    () => {
      const p = firstPara();
      return {
        ask: "Tighten up the opening.",
        outcome: "Updated the opening. It is shorter and keeps every day and time.",
        steps: [
          { tag: "Understanding", pending: "Working out what you mean…", done: "Rewrite the first paragraph: shorter, same facts, same days.", ms: 1000 },
          { par: [
            { tag: "Memory", pending: "Checking what I know about your writing…", done: "You prefer plain wording and no filler.", ms: 1200 },
            { tag: "Calendar", pending: "Checking the dates against your calendar…", done: "The weekend ends Sunday at 4 pm. The dates in the text match.", ms: 1600 },
          ] },
          { tag: "Page", say: "Reading the whole document", call: "get_document()", run: call("get_document", {}) },
          { tag: "Thinking", pending: "Cutting words without losing any plans…", done: "Kept every day and time.", ms: 1100 },
          p
            ? { tag: "Page", say: "Rewriting the opening", call: `replace_text(${p.id}, …)`, run: call("replace_text", { id: p.id, text: "A quiet weekend at the lake: up for the weekend, home Sunday afternoon, nothing urgent in between." }) }
            : { tag: "Page", say: "Adding an opening", call: "insert_nodes(start, …)", run: call("insert_nodes", { position: "start", nodes: [{ type: "paragraph", text: "A quiet weekend at the lake." }] }) },
        ],
      };
    },

    // 2: weather and packing, with a follow-on note
    () => {
      const pack = listUnder("Packing");
      const notes = heading("Notes");
      return {
        ask: "Check the forecast and update the packing list.",
        outcome: "Updated Packing and Notes for Saturday's showers, and set a reminder for Friday.",
        steps: [
          { tag: "Understanding", pending: "Working out what you mean…", done: "Add what the weather calls for to Packing, and flag any plan it affects.", ms: 1000 },
          { par: [
            { tag: "Memory", pending: "Checking what I know about your trips…", done: "Last trip you forgot rain jackets.", ms: 1200 },
            { tag: "Weather", pending: "Looking up the lake forecast…", done: "Saturday 58°F, showers after 2 pm. Sunday clear, 63°F.", ms: 1800 },
            { tag: "Calendar", pending: "Checking what is planned Saturday…", done: "Saturday has outdoor plans, and the showers start after 2 pm.", ms: 1500 },
          ] },
          { tag: "Page", say: "Reading the Packing section", call: "get_section(“Packing”)", run: call("get_section", { heading: "Packing" }) },
          pack && pack.type === "list"
            ? { tag: "Page", say: "Adding two items to Packing", call: "insert_list_items(Packing, 2 items)", run: call("insert_list_items", { list_id: pack.id, items: ["Rain jackets", "Warm layer for the dock"] }) }
            : { tag: "Page", say: "Adding a packing list", call: "insert_nodes(end, list)", run: call("insert_nodes", { position: "end", nodes: [{ type: "list", items: ["Rain jackets", "Warm layer for the dock"] }] }) },
          { par: [
            { tag: "Page", say: "Adding a note about the forecast", call: notes ? "insert_nodes(end of Notes, …)" : "insert_nodes(end, …)", run: call("insert_nodes", { position: notes ? "end_of_section" : "end", target: notes ? "Notes" : undefined, nodes: [{ type: "paragraph", text: "Showers are forecast after 2 pm on Saturday, so plan outdoor time before then." }] }) },
            { tag: "Reminders", pending: "Setting a reminder for Friday afternoon…", done: "Reminder set for Fri 4 pm: pack rain jackets.", ms: 1700 },
          ] },
        ],
      };
    },

    // 3: open questions, with email context and a reminder
    () => ({
      ask: "At the bottom, add open questions and remind me to confirm check-in.",
      outcome: "Added an Open questions section at the end, and set a reminder for Thursday.",
      steps: [
        { tag: "Understanding", pending: "Working out what you mean…", done: "Add an Open questions section at the end, and set a reminder.", ms: 1000 },
        { par: [
          { tag: "Memory", pending: "Checking what I know about your writing…", done: "You like open questions as plain sentences, not a list.", ms: 1200 },
          { tag: "Mail", pending: "Searching your email for the cabin booking…", done: "Found “Your lakeside cabin is confirmed”. Check-in is 3 pm, parking is on the street.", ms: 1900 },
        ] },
        { tag: "Page", say: "Adding an Open questions section", call: "insert_nodes(end, heading + paragraph)", run: call("insert_nodes", { position: "end", nodes: [
          { type: "heading", level: 2, text: "Open questions" },
          { type: "paragraph", text: "Check-in is at 3 pm, per the host's email. Confirm where to park before Friday." },
        ] }) },
        { tag: "Reminders", pending: "Creating a reminder…", done: "Reminder set for Thu 6 pm: confirm check-in details.", ms: 1500 },
      ],
    }),
  ];

  /* --------------------------------- playing -------------------------------- */

  let next = 0;
  let busy = false;

  async function play() {
    if (busy || view.locked) return false;
    busy = true;
    let scenario = null;
    for (let tries = 0; tries < scenarios.length && !scenario; tries++) scenario = scenarios[next++ % scenarios.length]();
    if (!scenario) {
      busy = false;
      return false;
    }
    sent = false;
    panel.classList.remove("leaving");
    steps.replaceChildren();
    said.textContent = "";
    state.className = "polr-chip polr-chip--info";
    state.textContent = "Working";
    panel.classList.remove("compact");
    panel.hidden = false;
    pad();
    try {
      await scenario.before?.();
      await say(scenario.ask);
      for (const spec of scenario.steps) {
        if (spec.par) await Promise.all(spec.par.map((s, i) => runStep(s, i * 450)));
        else await runStep(spec);
        await wait(1100); // a beat between steps so each one can be read
        pad();
      }
      await idle();
      // The last line is the result, so a collapsed panel ends on what was done, not on a tool call.
      const fin = addStep("Done", scenario.outcome);
      fin.done();
      panel.querySelector(".step:last-child")?.classList.add("final");
      state.className = "polr-chip polr-chip--good";
      state.textContent = "Done";
      await wait(3500);
    } finally {
      panel.classList.add("leaving");
      await wait(480);
      panel.hidden = true;
      pad();
      busy = false;
    }
    return true;
  }

  return { play, cover, get busy() { return busy; } };
}
