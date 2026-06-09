// Shared command preflight: config readiness plus optional plugin registry activation.
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

function loadConfigGuardModule() {
  return configGuardModuleLoader.load();
}

/** Run the lazy command bootstrap steps selected by command policy. */
export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
}) {
  let configReady: { valid: boolean } | undefined;
  if (!params.skipConfigGuard) {
    const { ensureConfigReady } = await loadConfigGuardModule();
    configReady = await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
    });
  }
  // Invalid-config recovery installs may need the installer to repair plugin-owned
  // config before runtime hook activation can safely read it.
  if (!params.loadPlugins || (params.allowInvalid && configReady?.valid === false)) {
    return;
  }
  const pluginRegistryLoadPolicy =
    params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry;
  await ensureCliPluginRegistryLoaded({
    scope: pluginRegistryLoadPolicy.scope,
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}
