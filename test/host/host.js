// A minimal MCP Apps host for testing, built on the SDK's own AppBridge. It behaves like Claude where
// it matters here: the view is loaded from the server's ui:// resource, runs under the CSP that
// resource declares (so a missing origin fails the way it would in Claude), tool calls go to the MCP
// server, and it answers display-mode, size and context messages.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const rpc = async (name, args) => (await fetch("/call", { method: "POST", body: JSON.stringify({ name, arguments: args ?? {} }) })).json();
const iframe = document.getElementById("app");
const log = { context: [], calls: [], sizes: [], messages: [], display: [], csp: "" };
window.__log = log;

let displayMode = "inline";
const hostContext = () => ({
  theme: "light",
  displayMode,
  availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: displayMode === "fullscreen" ? { width: 760, height: 700 } : { width: 760, maxHeight: 900 },
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  platform: "web",
});

const bridge = new AppBridge(null, { name: "test-host", version: "0" }, { serverTools: {}, updateModelContext: { text: {} }, message: {} }, { hostContext: hostContext() });
window.__bridge = bridge;
bridge.oncalltool = async (p) => {
  log.calls.push(p.name);
  return rpc(p.name, p.arguments);
};
bridge.onupdatemodelcontext = async (p) => {
  log.context.push(JSON.stringify(p));
  return {};
};
bridge.onmessage = async (p) => {
  log.messages.push(JSON.stringify(p));
  return {};
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayMode = mode === "fullscreen" ? "fullscreen" : "inline";
  log.display.push(displayMode);
  iframe.style.height = displayMode === "fullscreen" ? "700px" : "";
  bridge.setHostContext(hostContext());
  return { mode: displayMode };
};
bridge.onsizechange = ({ height }) => {
  log.sizes.push(height);
  if (height && displayMode === "inline") iframe.style.height = height + "px";
};

/** The CSP a host builds from what the resource declares (MCP Apps spec: restrictive default). */
function cspFor(csp = {}) {
  const list = (a) => (a ?? []).join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${list(csp.resourceDomains)}`,
    `style-src 'self' 'unsafe-inline' ${list(csp.resourceDomains)}`,
    `connect-src ${list(csp.connectDomains) || "'none'"}`,
    `img-src data: ${list(csp.resourceDomains)}`,
    `font-src ${list(csp.resourceDomains)}`,
    "media-src data:",
    `frame-src ${list(csp.frameDomains) || "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

bridge.oninitialized = () => {
  window.__initialized = true;
};

const view = await (await fetch("/view")).json();
log.csp = cspFor(view.meta?.ui?.csp);
window.__viewMeta = view.meta;
iframe.srcdoc = view.text.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${log.csp}">`);
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));

/** What Claude does when it calls a tool that has a view: run it, then hand the result to the view. */
window.__openApp = async (args) => {
  const result = await rpc("open_document", args);
  await bridge.sendToolInput({ arguments: args ?? {} });
  await bridge.sendToolResult(result);
  return result;
};
window.__ready = true;
