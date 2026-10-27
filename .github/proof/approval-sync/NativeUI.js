// Proof-only external System Events UI observer. Never loaded into OpenClaw.
// Run through the hosted image's pregranted /usr/bin/osascript, not a new AX binary.
ObjC.import("Foundation");
var systemEvents = Application("System Events");
var markers = ["active", "blocker", "queued", "sentinel"].map(function (name) {
  return "approval-proof-" + name;
});

function emit(value) {
  var data = $(JSON.stringify(value) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function attribute(element, name) {
  var value = element.attributes.byName(name);
  return value.exists() ? value.value() : null;
}

function descendants(element, depth, budget) {
  if (depth >= 24 || budget.left <= 0) {
    throw new Error("Incomplete accessibility tree");
  }
  budget.left -= 1;
  var result = [element];
  var children = element.uiElements();
  children.forEach(function (child) {
    result = result.concat(descendants(child, depth + 1, budget));
  });
  return result;
}

function text(nodes) {
  var values = [];
  nodes.forEach(function (node) {
    ["AXTitle", "AXDescription", "AXValue"].forEach(function (name) {
      var value = attribute(node, name);
      if (typeof value === "string") values.push(value);
    });
  });
  return values;
}

function snapshot(app) {
  // An inaccessible AXWindows request is an error, never evidence of no panel.
  var windows = app.windows();
  var visible = [];
  var approvals = 0;
  windows.forEach(function (window) {
    var title = attribute(window, "AXTitle");
    if (title === null) throw new Error("Window title unavailable");
    if (title !== "OpenClaw Command Approval") return;
    approvals += 1;
    var content = text(descendants(window, 0, { left: 5000 })).join(" ");
    markers.forEach(function (marker) {
      if (content.indexOf(marker) >= 0 && visible.indexOf(marker) < 0) {
        visible.push(marker);
      }
    });
  });
  return {
    ts: Date.now(),
    kind: "native-ui",
    markers: visible.sort(),
    approvalWindows: approvals,
  };
}

function run(args) {
  var mode = args[0];
  if (mode === "preflight") {
    var finder = systemEvents.applicationProcesses.byName("Finder");
    if (!finder.exists()) {
      throw new Error("SETUP BLOCKED: no logged-in Finder GUI session");
    }
    finder.windows();
    return "Existing System Events GUI automation access available";
  }

  var pid = Number(args[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Expected watch PID or press PID MARKER BUTTON");
  }
  var app = systemEvents.applicationProcesses.whose({ unixId: pid })[0];

  if (mode === "watch") {
    var startupDeadline = Date.now() + 30000;
    while (!app.exists() && Date.now() < startupDeadline) {
      $.NSThread.sleepForTimeInterval(0.1);
    }
    if (!app.exists()) {
      throw new Error("Native app process did not appear in System Events");
    }
    var last = null;
    var lastEmission = 0;
    var lastError = 0;
    while (app.exists()) {
      try {
        var state = snapshot(app);
        var key = JSON.stringify([state.markers, state.approvalWindows]);
        if (key !== last || Date.now() - lastEmission >= 500) {
          emit(state);
          last = key;
          lastEmission = Date.now();
        }
      } catch (error) {
        // An incomplete read must never become evidence that a panel disappeared.
        // Keep the observer alive and let the parent fail if valid frames stop.
        if (Date.now() - lastError >= 5000) {
          var message = $("AX snapshot failed: " + String(error) + "\n").dataUsingEncoding(
            $.NSUTF8StringEncoding,
          );
          $.NSFileHandle.fileHandleWithStandardError.writeData(message);
          lastError = Date.now();
        }
      }
      $.NSThread.sleepForTimeInterval(0.05);
    }
    return;
  }

  if (mode === "press" && args.length === 4) {
    var marker = args[2];
    var title = args[3];
    if (title !== "Allow Once" || marker !== "approval-proof-sentinel") {
      throw new Error("Only the synthetic sentinel's Allow Once shortcut is supported");
    }
    var matches = [];
    app.windows().forEach(function (window) {
      if (attribute(window, "AXTitle") !== "OpenClaw Command Approval") return;
      var nodes = descendants(window, 0, { left: 5000 });
      if (
        text(nodes).some(function (value) {
          return value.indexOf(marker) >= 0;
        })
      ) {
        matches.push(window);
      }
    });
    if (matches.length !== 1) {
      throw new Error("Expected one native sentinel approval window, found " + matches.length);
    }
    app.frontmost = true;
    var raise = matches[0].actions.byName("AXRaise");
    if (!raise.exists()) throw new Error("Native approval window cannot be raised");
    raise.perform();

    // System Events sends keys to the frontmost window, so fail closed unless
    // a fresh focused-window read still identifies this exact synthetic request.
    var focused = app.windows().filter(function (window) {
      return attribute(window, "AXFocused") === true;
    });
    if (
      !app.frontmost() ||
      focused.length !== 1 ||
      attribute(focused[0], "AXTitle") !== "OpenClaw Command Approval" ||
      !text(descendants(focused[0], 0, { left: 5000 })).some(function (value) {
        return value.indexOf(marker) >= 0;
      })
    ) {
      throw new Error("Synthetic approval panel is not the focused frontmost window");
    }
    systemEvents.keyCode(36, { using: ["command down"] });
    return "Sent native Command-Return for " + marker + " in focused app PID " + pid;
  }

  throw new Error("Expected preflight, watch PID, or press PID MARKER BUTTON");
}
