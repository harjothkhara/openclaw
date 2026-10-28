// Fork-only proof helper. No production imports or test seams.
function run(argv) {
  var pid = Number(argv[0]),
    action = argv[1],
    diagnostic = argv[2] === "diagnostic";
  if (
    !Number.isInteger(pid) ||
    pid <= 1 ||
    ["snapshot", "click"].indexOf(action) < 0 ||
    argv.length > 3 ||
    (argv.length === 3 && (!diagnostic || action !== "snapshot"))
  )
    throw Error("Invalid AX invocation");
  var nodes = 0,
    windowCount = 0,
    started = Date.now(),
    stage = "start";
  function progress(next, detail) {
    stage = next;
    if (diagnostic)
      console.log(
        JSON.stringify({
          kind: "ax-progress",
          pid: pid,
          action: action,
          stage: stage,
          nodes: nodes,
          windows: windowCount,
          elapsedMs: Date.now() - started,
          detail: detail || null,
        }),
      ); // osascript writes console output to stderr, not the JSON result.
  }
  function notReady(reason) {
    progress(reason);
    return JSON.stringify({
      pid: pid,
      ready: false,
      reason: reason,
      nodes: nodes,
      windows: windowCount,
      elapsedMs: Date.now() - started,
    });
  }
  try {
    progress("system-events");
    var se = Application("System Events");
    progress("process-lookup");
    var matches = se.processes.whose({ unixId: pid })();
    if (matches.length === 0 && action === "snapshot") return notReady("process-not-found");
    if (matches.length !== 1) throw Error("Expected one process for the owned PID");
    var proc = matches[0];
    progress("activate-owned-process");
    proc.frontmost = true;
    progress("window-list");
    var buttons = [],
      rows = [],
      windows = proc.windows();
    windowCount = windows.length;
    if (!windows.length && action === "snapshot") return notReady("no-owned-window");
    if (!windows.length) throw Error("Owned app has no AX window");
    function attrs(e) {
      progress("attribute-list");
      return e.attributes().map(function (a, i) {
        progress("attribute-name", i);
        return a.name();
      });
    }
    function value(e, names, key) {
      if (names.indexOf(key) < 0) return null;
      progress("attribute-value", key);
      return e.attributes.byName(key).value(); // Advertised-but-unreadable is fatal.
    }
    function walk(e, depth, selected) {
      if (++nodes > 2500 || depth > 30) throw Error("Incomplete AX traversal");
      var names = attrs(e),
        role = value(e, names, "AXRole");
      if (typeof role !== "string") throw Error("Missing AX role");
      if (role === "AXWebArea") return; // Never descend into a web document.
      var id = value(e, names, "AXIdentifier");
      if (id === "chat-new-thread")
        buttons.push({ element: e, enabled: value(e, names, "AXEnabled") });
      if (role === "AXRow" && value(e, names, "AXSelected") === true) {
        selected = [];
        rows.push(selected);
      }
      if (selected)
        ["AXTitle", "AXDescription", "AXValue", "AXIdentifier"].forEach(function (key) {
          var v = value(e, names, key);
          if (typeof v === "string" && v.length) {
            if (v.length > 500) throw Error("Unexpectedly large selected-row content");
            selected.push(v);
          }
        });
      var children = value(e, names, "AXChildren");
      if (children !== null) {
        if (!Array.isArray(children)) throw Error("Invalid AX children");
        children.forEach(function (c) {
          walk(c, depth + 1, selected);
        });
      }
    }
    windows.forEach(function (w) {
      walk(w, 0, null);
    });
    if (buttons.length > 1 || (action === "click" && buttons.length !== 1))
      throw Error("New Thread selector is not unique: " + buttons.length);
    var out = {
      pid: pid,
      ready: buttons.length === 1,
      complete: true,
      nodes: nodes,
      windows: windows.length,
      buttonCount: buttons.length,
      enabled: buttons.length ? buttons[0].enabled : null,
      selection: rows,
      elapsedMs: Date.now() - started,
    };
    if (!out.ready) out.reason = "native-control-not-found";
    if (action === "click") {
      if (out.enabled !== true || proc.frontmost() !== true)
        throw Error("Button is not enabled/frontmost");
      var target = buttons[0].element;
      var actions = target.actions().map(function (a) {
        return a.name();
      });
      if (actions.indexOf("AXPress") < 0) throw Error("Native New Thread does not expose AXPress");
      out.pressedAt = Date.now();
      target.actions.byName("AXPress").perform();
      out.returnedAt = Date.now();
      out.clicked = true;
    }
    progress("complete");
    return JSON.stringify(out);
  } catch (error) {
    var failedAt = stage;
    progress("failed", failedAt);
    throw error;
  }
}
