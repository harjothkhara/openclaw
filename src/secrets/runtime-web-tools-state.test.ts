/** Tests clone isolation for active web-tool metadata state. */
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime.js";
import { createEmptyRuntimeWebToolsMetadata } from "./runtime-fast-path.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  getActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function activeSearchProvider(): string | undefined {
  return getActiveRuntimeWebToolsMetadata()?.search.selectedProvider;
}

function populatedSearchMetadata(provider: string): RuntimeWebToolsMetadata {
  return {
    search: {
      providerConfigured: provider,
      providerSource: "configured",
      selectedProvider: provider,
      selectedProviderKeySource: "secretRef",
      diagnostics: [],
    },
    fetch: {
      providerSource: "none",
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function preparedSnapshot(params: {
  sourceConfig: OpenClawConfig;
  webTools?: RuntimeWebToolsMetadata;
  webToolsFromFastPath: boolean;
}): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: params.sourceConfig,
    config: structuredClone(params.sourceConfig),
    authStores: [],
    warnings: [],
    webTools: params.webTools ?? createEmptyRuntimeWebToolsMetadata(),
    webToolsFromFastPath: params.webToolsFromFastPath,
  };
}

describe("runtime web tools state", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearActiveRuntimeWebToolsMetadata();
  });

  it("exposes active runtime web tool metadata as a defensive clone", () => {
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "gemini",
        providerSource: "configured",
        selectedProvider: "gemini",
        selectedProviderKeySource: "secretRef",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });

    const first = getActiveRuntimeWebToolsMetadata();
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    expect(first.search.providerConfigured).toBe("gemini");
    expect(first.search.selectedProvider).toBe("gemini");
    expect(first.search.selectedProviderKeySource).toBe("secretRef");
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    if (!second) {
      throw new Error("missing cloned runtime web tools metadata");
    }
    expect(second.search.providerConfigured).toBe("gemini");
    expect(second.search.selectedProvider).toBe("gemini");
  });

  it("preserves populated web metadata across repeated stripped fast-path refreshes", () => {
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({
          tools: {
            web: {
              search: { provider: "brave" },
            },
          },
        }),
        webTools: populatedSearchMetadata("brave"),
        webToolsFromFastPath: false,
      }),
    );

    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsFromFastPath: true,
      }),
    );
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsFromFastPath: true,
      }),
    );

    expect(activeSearchProvider()).toBe("brave");
  });

  it.each([
    {
      name: "tools.web",
      sourceConfig: asConfig({
        tools: {
          web: {},
        },
      }),
    },
    {
      name: "plugins.entries",
      sourceConfig: asConfig({
        plugins: {
          entries: {},
        },
      }),
    },
  ])("clears web metadata when a fast-path refresh includes an explicit empty $name", ({
    sourceConfig,
  }) => {
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({
          tools: {
            web: {
              search: { provider: "brave" },
            },
          },
        }),
        webTools: populatedSearchMetadata("brave"),
        webToolsFromFastPath: false,
      }),
    );

    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig,
        webToolsFromFastPath: true,
      }),
    );
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsFromFastPath: true,
      }),
    );

    expect(activeSearchProvider()).toBeUndefined();
  });

  it("clears web metadata when the full resolver returns empty metadata", () => {
    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({
          tools: {
            web: {
              search: { provider: "brave" },
            },
          },
        }),
        webTools: populatedSearchMetadata("brave"),
        webToolsFromFastPath: false,
      }),
    );

    activateSecretsRuntimeSnapshot(
      preparedSnapshot({
        sourceConfig: asConfig({}),
        webToolsFromFastPath: false,
      }),
    );

    expect(activeSearchProvider()).toBeUndefined();
  });
});
