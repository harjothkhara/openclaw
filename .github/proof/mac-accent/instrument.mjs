// Fork-only, identical passive observer for both app revisions. Never ships in the PR.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.join(
  path.resolve(process.argv[2]),
  "apps/macos/Sources/OpenClaw/WebChatSwiftUI.swift",
);
const before = await readFile(source, "utf8");
const anchor = ".onAppear { self.audioInputCatalog.start() }";
assert.equal(before.split(anchor).length, 2, "Expected one unchanged native-chat render anchor");
const observer = `.onAppear {
                self.audioInputCatalog.start()
                NSLog("MAC_ACCENT_PROOF accent=%@ native=%@", self.appState.effectiveAccentHex ?? "<nil>",
                      self.viewModel.usesWebConversation ? "false" : "true")
            }
            .onChange(of: self.appState.effectiveAccentHex) { _, accent in
                NSLog("MAC_ACCENT_PROOF accent=%@ native=%@", accent ?? "<nil>",
                      self.viewModel.usesWebConversation ? "false" : "true")
            }`;
await writeFile(source, before.replace(anchor, observer));
console.log("Instrumented native chat accent consumer at the same source anchor");
