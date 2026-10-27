ObjC.import("Foundation");
var se = Application("System Events");

function attr(node, name) {
  var value = node.attributes.byName(name);
  return value.exists() ? value.value() : null;
}

function descendants(node, depth, budget) {
  if (depth > 24 || budget.left-- <= 0) throw new Error("Incomplete accessibility tree");
  var result = [node];
  node.uiElements().forEach(function (child) {
    result = result.concat(descendants(child, depth + 1, budget));
  });
  return result;
}

function run(args) {
  if (args[0] === "preflight") {
    var finder = se.applicationProcesses.byName("Finder");
    if (!finder.exists()) throw new Error("No logged-in GUI session");
    finder.windows();
    return "System Events access available";
  }
  var pid = Number(args[1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected app PID");
  var app = se.applicationProcesses.whose({ unixId: pid })[0];
  if (!app.exists()) throw new Error("App is absent from System Events");
  var windows = app.windows().filter(function (window) {
    return attr(window, "AXTitle") === "OpenClaw Chat";
  });
  if (windows.length !== 1)
    throw new Error("Expected one native OpenClaw Chat window; got " + windows.length);
  var window = windows[0];
  if (args[0] === "draft") {
    var areas = descendants(window, 0, { left: 5000 }).filter(function (node) {
      return attr(node, "AXRole") === "AXTextArea";
    });
    if (areas.length === 0) throw new Error("Chat composer text area not exposed");
    areas[areas.length - 1].value = "Accent proof draft; do not send";
  }
  var nodes = descendants(window, 0, { left: 5000 });
  var content = nodes
    .map(function (node) {
      return [attr(node, "AXTitle"), attr(node, "AXDescription"), attr(node, "AXValue")]
        .filter(function (value) {
          return typeof value === "string";
        })
        .join(" ");
    })
    .join(" ");
  return JSON.stringify({
    title: attr(window, "AXTitle"),
    draftVisible: content.indexOf("Accent proof draft") >= 0,
    nodes: nodes.length,
  });
}
