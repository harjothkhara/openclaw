import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

export async function createDockerGateway({ work, run, signal, secrets, evidenceDir, redact }) {
  const tag = 'ghcr.io/openclaw/openclaw:2026.11.1';
  const owner = randomUUID(), name = 'files-proof-' + owner;
  const label = 'ai.openclaw.files-proof';
  const uid = process.getuid(), gid = process.getgid();
  if (!uid || !gid) throw new Error('Docker proof requires nonroot host UID/GID');
  const data = path.resolve(work, 'docker-data');
  const client = path.resolve(work, 'docker-cli');
  const token = randomBytes(32).toString('hex');
  secrets.push(token);
  const configPath = path.join(data, 'openclaw.json');
  const docker = (args, extra = {}) => run('docker', ['--config', client, ...args], { timeout: 30000, ...extra });
  const text = async (args, extra) => (await docker(args, extra)).stdout.toString().trim();
  const inspect = async () => {
    const ids = await text(['container', 'ls', '-aq', '--filter', 'name=^/' + name + '$']);
    return ids ? JSON.parse(await text(['container', 'inspect', '--format', '{{json .}}', name])) : null;
  };
  let attempted = false, closing;
  // This lifecycle owns the task directory; remove it only after container absence is proven.
  const cleanup = () => closing ??= (async () => {
    if (attempted) {
      let item = await inspect();
      if (item && item.Config.Labels?.[label] !== owner) throw new Error('Container ownership label mismatch');
      if (item?.State.Running) {
        await docker(['container', 'stop', '--time', '10', name], { allowFailure: true });
        item = await inspect();
        if (item?.State.Running) {
          await docker(['container', 'kill', name], { allowFailure: true });
          item = await inspect();
        }
      }
      if (item?.State.Running || item?.State.Restarting) throw new Error('Container extinction not proven');
      if (item) await docker(['container', 'rm', name]);
      if (await inspect()) throw new Error('Container removal not proven');
    }
    await rm(work, { recursive: true, force: true });
  })();
  // Keep startup/RPC failure evidence before owned-container cleanup removes it.
  const captureFailure = async () => {
    try {
      const item = await inspect();
      if (!item) return;
      if (item.Config.Labels?.[label] !== owner) throw new Error('Diagnostic container ownership mismatch');
      const logs = await docker(['container', 'logs', '--tail', '150', name], { allowFailure: true });
      await writeFile(path.join(evidenceDir, 'gateway-failure.log'), redact(logs.stdout.toString() + logs.stderr.toString()));
      await writeFile(path.join(evidenceDir, 'gateway-failure-state.json'), JSON.stringify({
        status: item.State.Status, exitCode: item.State.ExitCode, oomKilled: item.State.OOMKilled,
        error: redact(item.State.Error ?? ''),
      }, null, 2));
    } catch (error) {
      console.error(redact('Gateway diagnostic capture failed: ' + error));
    }
  };
  const reservation = createServer();
  try {
    signal.throwIfAborted();
    await mkdir(client, { recursive: true, mode: 0o700 });
    for (const dir of ['home', 'state', 'agent', 'workspace/retry-proof']) {
      await mkdir(path.join(data, dir), { recursive: true, mode: 0o700 });
    }
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'token', token }, controlUi: { enabled: false } },
      cron: { enabled: false }, agents: { defaults: { workspace: '/data/workspace' } },
    }), { mode: 0o600 });
    for (let n = 0; n < 251; n++) {
      await writeFile(path.join(data, 'workspace/retry-proof', 'file-' + String(n).padStart(3, '0') + '.txt'), 'Files proof\n');
    }
    await docker(['pull', tag], { timeout: 240000 });
    const image = JSON.parse(await text(['image', 'inspect', '--format', '{{json .}}', tag]));
    const digest = image.RepoDigests.find((x) => x.startsWith('ghcr.io/openclaw/openclaw@sha256:'));
    if (!digest || !image.Id) throw new Error('Immutable official image identity missing');
    await writeFile(path.join(work, 'docker-owner.json'), JSON.stringify({ name, label, owner, tag, repoDigest: digest, imageID: image.Id }), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = reservation.address().port;
    signal.throwIfAborted();
    attempted = true;
    await docker(['container', 'create', '--name', name, '--label', label + '=' + owner,
      '--init', '--network', 'host', '--user', uid + ':' + gid,
      '--cap-drop', 'NET_RAW', '--cap-drop', 'NET_ADMIN', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,src=' + data + ',dst=/data',
      '-e', 'HOME=/data/home', '-e', 'OPENCLAW_STATE_DIR=/data/state',
      '-e', 'OPENCLAW_CONFIG_PATH=/data/openclaw.json', '-e', 'OPENCLAW_AGENT_DIR=/data/agent',
      digest, 'node', 'dist/index.js', 'gateway', '--bind', 'loopback', '--port', String(port)]);
    await new Promise((resolve) => reservation.close(resolve));
    signal.throwIfAborted();
    await docker(['container', 'start', name]);
    const until = Date.now() + 90000;
    while (true) {
      signal.throwIfAborted();
      // A listening socket can precede traffic admission; use the shipped startup probe.
      const ready = await fetch('http://127.0.0.1:' + port + '/startupz', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      }).then(async (response) => { await response.arrayBuffer(); return response.ok; }, () => false);
      if (ready) break;
      const item = await inspect();
      if (!item?.State.Running || Date.now() > until) throw new Error('Docker Gateway did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const item = await inspect();
    if (item.Image !== image.Id) throw new Error('Running image ID mismatch');
    const code = "const fs=require('node:fs');const p=require('/app/package.json');const b=JSON.parse(fs.readFileSync('/app/dist/build-info.json','utf8'));console.log(JSON.stringify({version:p.version,commit:b.commit,node:process.version,uid:process.getuid(),gid:process.getgid()}))";
    const runtime = JSON.parse(await text(['container', 'exec', name, 'node', '-e', code]));
    if (runtime.version !== '2026.11.1' || !/^[a-f0-9]{40}$/.test(runtime.commit) || runtime.uid !== uid || runtime.gid !== gid) throw new Error('Runtime identity mismatch');
    return { url: 'ws://127.0.0.1:' + port, gatewayToken: token, configPath,
      identity: { tag, repoDigest: digest, imageID: image.Id, container: name, label: { [label]: owner }, runtime }, cleanup, captureFailure };
  } catch (error) {
    if (attempted) await captureFailure();
    try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], 'Docker cleanup is unproven for ' + name); }
    throw error;
  } finally {
    if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
  }
}

