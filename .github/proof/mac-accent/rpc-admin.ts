// Proof-only client for the disposable Gateway. Each call is a separate
// authenticated operator, including the external approval resolver.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, method, paramsArg, timeoutArg] = process.argv.slice(2);
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_REPOSITORY !== "harjothkhara/openclaw"
) {
  throw new Error("Disposable hosted proof runner required");
}
if (!repoArg || !method || !paramsArg || !timeoutArg) {
  throw new Error("Expected repo, method, params, timeout");
}
const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
const timeoutMs = Number(timeoutArg);
if (!Number.isInteger(port) || port < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error("Invalid proof Gateway port or timeout");
}

const source = pathToFileURL(path.join(path.resolve(repoArg), "src/gateway/call.ts")).href;
const { callGateway } = await import(source);
let receipt: { connId: string; scopes: string[] } | undefined;
const result = await callGateway({
  method,
  params: JSON.parse(paramsArg),
  url: `ws://127.0.0.1:${port}`,
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  deviceIdentity: null,
  scopes: ["operator.admin"],
  clientName: "cli",
  mode: "cli",
  sharedStateMode: "read-only",
  timeoutMs,
  onHelloOk: (hello) => {
    receipt = {
      connId: hello.server.connId,
      scopes: hello.auth.scopes,
    };
  },
});
if (!receipt || !receipt.scopes.includes("operator.admin")) {
  throw new Error("Isolated Gateway did not grant proof admin scope");
}
process.stdout.write(JSON.stringify({ result, receipt }) + "\n");
