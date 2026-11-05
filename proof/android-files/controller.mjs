import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Fork-only controller. Run with pnpm exec tsx; no provider credentials are inherited by Gateway.
const [rootArg, manifestArg, outputArg] = process.argv.slice(2);
const BASE = '3fed691416b37f91b0db8dd77446f739e7bf92af';
const HEAD = '28328419c54b3ef02cde5cc956b32139b3a86721';
const TREE = '39a4fb9ed20cd067442ccf8ca1d957f85bd33bed';
const secrets = [];
const redact = (text) => secrets.reduce((s, secret) => secret ? s.split(secret).join('[REDACTED]') : s, String(text))
  .replace(/(?:https?|wss?):\/\/[^\s<>"']+/g, '[URL_REDACTED]');
async function run(bin, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120000);
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 67108864) child.kill('SIGKILL'); else out.push(chunk); });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); const value = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }; if (code === 0 || options.allowFailure) resolve(value); else reject(new Error('command failed: ' + path.basename(bin) + ' exit=' + code + ' ' + redact(value.stderr))); });
    child.stdin.end(options.input ?? undefined);
  });
}
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
async function main() {
  if (!rootArg || !manifestArg || !outputArg) throw new Error('usage: controller.mjs SOURCE_ROOT APK_MANIFEST OUTPUT_DIR');
  const root = path.resolve(rootArg); const output = path.resolve(outputArg);
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestArg, 'utf8'));
  if (manifest.baseline.sha !== BASE || manifest.candidate.sha !== HEAD || manifest.candidate.tree !== TREE) throw new Error('source identity mismatch');
  const require = createRequire(path.join(root, 'package.json'));
  const { WebSocket, WebSocketServer } = require('ws');
  const { createOpenClawTestInstance } = await import(pathToFileURL(path.join(root, 'test/helpers/openclaw-test-instance.ts')));
  const { prepareIOSReleaseGateway } = await import(pathToFileURL(path.join(root, 'scripts/lib/ios-release-gateway.ts')));
  const { callGateway } = await import(pathToFileURL(path.join(root, 'src/gateway/call.ts')));
  const work = await mkdtemp(path.join(tmpdir(), 'android-files-native-'));
  const workspace = path.join(work, 'workspace');
  await mkdir(path.join(workspace, 'retry-proof'), { recursive: true });
  for (let n = 0; n < 251; n++) await writeFile(path.join(workspace, 'retry-proof', 'file-' + String(n).padStart(3, '0') + '.txt'), 'Native Files proof\n');
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 45 * 60000);
  let instance;
  try {
    const gateway = await prepareIOSReleaseGateway({ targetSha: HEAD, selectionDir: path.join(work, 'selection'), installDir: path.join(work, 'gateway'), signal: abort.signal });
    const owned = new Set(['HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR']);
    const allow = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL']);
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => !owned.has(key) && !allow.has(key)).map((key) => [key, undefined]));
    instance = await createOpenClawTestInstance({ name: 'android-files-native', cwd: gateway.cwd, entrypoint: gateway.entrypoint,
      config: { gateway: { controlUi: { enabled: false } }, cron: { enabled: false }, agents: { defaults: { workspace } } },
      env: { ...cleared, OPENCLAW_TEST_MINIMAL_GATEWAY: '0', OPENCLAW_SKIP_CHANNELS: '0', OPENCLAW_SKIP_PROVIDERS: '0' }, signal: abort.signal });
    secrets.push(instance.gatewayToken, instance.hookToken);
    await instance.startGateway();
    const rpc = (method, params) => callGateway({ config: {}, configPath: instance.configPath, url: instance.url,
      token: instance.gatewayToken, ignoreEnvUrlOverride: true, deviceIdentity: null, sharedStateMode: 'read-only', method, params, signal: abort.signal, timeoutMs: 30000 });
    const listing = await rpc('agents.workspace.list', { agentId: 'main', path: 'retry-proof', limit: 500 });
    if (listing.totalEntries !== 251 || listing.entries.length !== 251) throw new Error('seeded child folder must contain exactly 251 entries');
    await writeFile(path.join(output, 'gateway-identity.json'), JSON.stringify(gateway.identity, null, 2));
    const adbBin = process.env.ADB ?? path.join(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT, 'platform-tools/adb');
    const adb = (args, options = {}) => run(adbBin, ['-s', process.env.ANDROID_SERIAL ?? 'emulator-5554', ...args], options);
    const app = 'ai.openclaw.app.debug';
    const evidence = [];
    for (const revision of ['baseline', 'candidate']) {
      const item = manifest[revision]; const dir = path.join(output, revision); await mkdir(dir, { recursive: true });
      if ((await run('git', ['rev-parse', 'HEAD'], { cwd: item.root })).stdout.toString().trim() !== item.sha) throw new Error('checkout HEAD changed');
      const proxy = await startFilesProxy({ gatewayUrl: instance.url, evidenceDir: dir, revision, WebSocket, WebSocketServer });
      let instrumentation;
      try {
        await adb(['shell', 'am', 'force-stop', app], { allowFailure: true });
        await adb(['install', '-r', '-t', item.apk], { timeout: 180000 });
        await adb(['install', '-r', '-t', item.testApk], { timeout: 180000 });
        await adb(['shell', 'pm', 'clear', app]);
        await adb(['reverse', 'tcp:' + proxy.port, 'tcp:' + proxy.port]);
        const setup = await rpc('device.pair.setupCode', { publicUrl: proxy.url, includeQr: false });
        if (!setup.setupCode?.trim()) throw new Error('Gateway did not issue setup code');
        secrets.push(setup.setupCode);
        await adb(['shell', 'run-as', app, 'mkdir', '-p', 'files']);
        await adb(['shell', 'run-as ' + app + " sh -c 'cat > files/native-files-setup-code'"], { input: setup.setupCode + '\n' });
        instrumentation = await adb(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'ai.openclaw.app.AndroidFilesRetryProof#normalAppFilesRetry',
          '-e', 'expectedStaleError', String(revision === 'baseline'), '-e', 'proxyPort', String(proxy.port), '-e', 'proofRevision', revision,
          '-e', 'expectedSourceSha', item.sha, app + '.test/androidx.test.runner.AndroidJUnitRunner'], { timeout: 480000, allowFailure: true });
        await writeFile(path.join(dir, 'instrumentation.txt'), redact(instrumentation.stdout.toString() + instrumentation.stderr));
        const archive = await adb(['exec-out', 'run-as', app, 'tar', '-C', 'files/native-files-proof', '-cf', '-', '.'], { allowFailure: true });
        if (archive.code === 0) {
          const tar = path.join(dir, 'device-evidence.tar'); await writeFile(tar, archive.stdout);
          await run('tar', ['-xf', tar, '-C', dir]); await rm(tar);
        }
        if (!/OK \(1 test\)/.test(instrumentation.stdout.toString()) || /FAILURES!!!|INSTRUMENTATION_FAILED/.test(instrumentation.stdout.toString())) throw new Error('native instrumentation assertion failed: ' + revision);
        const facts = JSON.parse(await readFile(path.join(dir, 'facts.json'), 'utf8'));
        const rows = proxy.state.lists;
        const expected = [
          { direction: 'real-gateway-response', offset: 0, ok: true, entries: 250, totalEntries: 251 },
          { direction: 'synthetic-failure', offset: 250, ok: false },
          { direction: 'real-gateway-response', offset: 250, ok: true, entries: 1, totalEntries: 251 },
        ];
        if (proxy.state.faults !== 1 || proxy.state.firstPages !== 1 || proxy.state.finalPages !== 1 ||
            rows.length !== expected.length || new Set(rows.map((row) => row.connection)).size !== 1 ||
            expected.some((fact, index) => Object.entries(fact).some(([key, value]) => rows[index][key] !== value))) {
          throw new Error('Exact first-page/fault/retry sequence or page-size invariant failed');
        }
        if (rows.some((row) => row.limit !== null || row.path !== 'retry-proof')) throw new Error('proof changed default page or wrong folder');
        if (facts.apkGitCommit !== item.sha || facts.staleErrorAfterSuccess !== (revision === 'baseline')) throw new Error('APK identity/outcome invariant failed');
        const result = { ...item, apkSha256: await hash(item.apk), testApkSha256: await hash(item.testApk), facts };
        evidence.push(result); await writeFile(path.join(dir, 'identity-and-result.json'), JSON.stringify(result, null, 2));
      } finally { await proxy.close(); await adb(['reverse', '--remove', 'tcp:' + proxy.port], { allowFailure: true }); }
    }
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ proof: 'normal packaged Android app; real isolated published Gateway; one-shot path+offset fault proxy', revisions: evidence }, null, 2));
    console.log('NATIVE FILES PROOF PASSED: baseline stale error present; candidate absent; same connection and retained rows.');
  } finally { clearTimeout(deadline); abort.abort(); if (instance) await instance.cleanup(); await rm(work, { recursive: true, force: true }); }
}
if (rootArg) main().catch(async (error) => {
  const message = redact(error?.stack ?? error);
  if (outputArg) { await mkdir(outputArg, { recursive: true }); await writeFile(path.join(outputArg, 'failure.txt'), message); }
  console.error(message); process.exitCode = 1;
});


// Fork-only proof support. Transparent real-Gateway transport except ONE offset-250 list fault.
// No connection/setup tokens, request bodies, device keys or transcript content are logged.
export async function startFilesProxy({ gatewayUrl, evidenceDir, revision, WebSocket, WebSocketServer }) {
  await mkdir(evidenceDir, { recursive: true });
  const state = { revision, faults: 0, firstPages: 0, finalPages: 0, lists: [] };
  let connectionSequence = 0;
  const peers = new Set();
  const writes = [];
  const log = async (fact) => {
    const safe = { at: new Date().toISOString(), revision, ...fact };
    state.lists.push(safe);
    const write = appendFile(path.join(evidenceDir, 'workspace-rpc.jsonl'), JSON.stringify(safe) + '\n');
    writes.push(write);
    await write;
  };
  const upstreamHttp = new URL(gatewayUrl.replace(/^ws/, 'http'));
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/proof-status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }
    const forwarded = httpRequest(new URL(req.url, upstreamHttp), { method: req.method, headers: { ...req.headers, host: upstreamHttp.host } }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    forwarded.on('error', () => { res.writeHead(502); res.end('proof upstream unavailable'); });
    req.pipe(forwarded);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (client) => {
    const connection = ++connectionSequence;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !/^(host|connection|upgrade|sec-websocket-.*)$/i.test(key)));
    const upstream = new WebSocket(gatewayUrl, { headers });
    peers.add(client); peers.add(upstream);
    const pending = new Map();
    const queue = [];
    let queuedBytes = 0;
    const forward = (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (queuedBytes + data.length <= 1048576) { queue.push([data, binary]); queuedBytes += data.length; }
      else { client.close(1009, 'proof queue bound'); upstream.terminate(); }
    };
    upstream.on('open', () => { for (const [data, binary] of queue.splice(0)) upstream.send(data, { binary }); });
    client.on('message', (data, binary) => {
      let frame;
      if (!binary) { try { frame = JSON.parse(data.toString()); } catch {} }
      if (frame?.type === 'req' && frame.method === 'agents.workspace.list' && frame.params?.path === 'retry-proof') {
        const offset = frame.params?.offset ?? 0;
        const limit = frame.params?.limit ?? null;
        if (offset === 250 && state.faults === 0) {
          state.faults++;
          void log({ direction: 'synthetic-failure', connection, path: 'retry-proof', method: frame.method, offset, limit, ok: false });
          client.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 'UNAVAILABLE', message: 'One-shot native Files proof page fault' } }));
          return;
        }
        pending.set(frame.id, { offset, limit });
      }
      forward(data, binary);
    });
    upstream.on('message', (data, binary) => {
      let frame;
      if (!binary) { try { frame = JSON.parse(data.toString()); } catch {} }
      if (frame?.type === 'res' && pending.has(frame.id)) {
        const { offset, limit } = pending.get(frame.id); pending.delete(frame.id);
        const entries = frame.payload?.entries;
        if (frame.ok && offset === 0) state.firstPages++;
        if (frame.ok && offset === 250) state.finalPages++;
        void log({ direction: 'real-gateway-response', connection, path: 'retry-proof', method: 'agents.workspace.list', offset, limit, ok: frame.ok === true, entries: Array.isArray(entries) ? entries.length : null, totalEntries: frame.payload?.totalEntries ?? null });
      }
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    const close = () => { peers.delete(client); peers.delete(upstream); if (client.readyState < 2) client.close(); if (upstream.readyState < 2) upstream.close(); };
    client.on('close', close); upstream.on('close', close);
    client.on('error', close); upstream.on('error', close);
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return { port, url: 'ws://127.0.0.1:' + port, state, async close() {
    for (const peer of peers) peer.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(writes);
  } };
}

