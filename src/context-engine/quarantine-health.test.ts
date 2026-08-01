// Context-engine quarantine health tests cover cross-process status visibility.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import {
  clearContextEnginesForOwner,
  listContextEngineQuarantines,
  registerContextEngineForOwner,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";

const CONTEXT_ENGINE_QUARANTINE_OWNER_ID = "core:context-engine-quarantine-health";
const CONTEXT_ENGINE_QUARANTINE_NAMESPACE = "runtime-quarantines";

// Sibling records need a verifiable process start time. The store reads it
// through the repo's cross-platform lock identity, so this covers Linux and
// macOS and still skips anywhere that identity is unavailable.
const hasProcessStartTimes = getFileLockProcessStartTime(process.pid) !== null;

type ContextEngineQuarantineTestRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processToken: string;
  processStartTime: number | null;
};

async function withLiveSiblingProcess<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  if (!child.pid) {
    throw new Error("failed to start live sibling process");
  }
  try {
    return await fn(child.pid);
  } finally {
    child.kill();
  }
}

function seedPersistedContextEngineQuarantineForTest(
  record: ContextEngineQuarantineTestRecord,
): void {
  createCorePluginStateSyncKeyedStore<ContextEngineQuarantineTestRecord>({
    ownerId: CONTEXT_ENGINE_QUARANTINE_OWNER_ID,
    namespace: CONTEXT_ENGINE_QUARANTINE_NAMESPACE,
    maxEntries: 64,
  }).register(JSON.stringify([record.engineId, record.processId]), record);
}

function seedSiblingQuarantineForTest(params: {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processStartTime: number | null;
}): void {
  seedPersistedContextEngineQuarantineForTest({
    ...params,
    processToken: "sibling-process-token",
  });
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("context engine quarantine health", () => {
  it("lists persisted runtime quarantines when local process state is empty", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      resetContextEngineRuntimeQuarantineForTests();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(listContextEngineQuarantines()).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });

  it.runIf(hasProcessStartTimes)(
    "clears only the current process record while preserving live sibling quarantines",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          seedPersistedContextEngineQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "current process failure",
            ...createRuntimeHealthRecordEnvelope(new Date(123)),
          });
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAtMs: 789,
            processId: siblingProcessId,
            processStartTime: getFileLockProcessStartTime(siblingProcessId),
          });

          clearPersistedContextEngineQuarantineForProcess("lossless-claw", process.pid);

          expect(listContextEngineQuarantines()).toEqual([
            {
              engineId: "lossless-claw",
              owner: "plugin:lossless-claw",
              operation: "bootstrap",
              reason: "sibling process failure",
              failedAt: new Date(789),
            },
          ]);
        });
      });
    },
  );

  it.runIf(hasProcessStartTimes)(
    "clears all current process records while preserving live sibling quarantines",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          seedPersistedContextEngineQuarantineForTest({
            engineId: "local-a",
            operation: "bootstrap",
            reason: "current process failure a",
            ...createRuntimeHealthRecordEnvelope(new Date(123)),
          });
          seedPersistedContextEngineQuarantineForTest({
            engineId: "local-b",
            operation: "assemble",
            reason: "current process failure b",
            ...createRuntimeHealthRecordEnvelope(new Date(234)),
          });
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAtMs: 789,
            processId: siblingProcessId,
            processStartTime: getFileLockProcessStartTime(siblingProcessId),
          });

          resetContextEngineRuntimeQuarantineForTests();

          expect(listContextEngineQuarantines()).toEqual([
            {
              engineId: "lossless-claw",
              owner: "plugin:lossless-claw",
              operation: "bootstrap",
              reason: "sibling process failure",
              failedAt: new Date(789),
            },
          ]);
        });
      });
    },
  );

  it("stamps records with the same process identity the reader verifies", () => {
    // Writer and reader must resolve identity through one function. The units are
    // platform-specific (Linux /proc ticks vs Darwin epoch seconds), so a split
    // would silently drop every sibling record rather than fail loudly.
    expect(createRuntimeHealthRecordEnvelope(new Date(0)).processStartTime).toBe(
      getFileLockProcessStartTime(process.pid),
    );
  });

  it("drops records from a previous incarnation of this PID", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-incarnation-", async () => {
      resetContextEngineRuntimeQuarantineForTests();
      seedPersistedContextEngineQuarantineForTest({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "stale pre-restart failure",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
      });

      expect(listContextEngineQuarantines()).toEqual([]);
    });
  });

  it.runIf(hasProcessStartTimes)(
    "drops persisted quarantine records when a sibling PID has been reused",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-pid-reuse-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          resetContextEngineRuntimeQuarantineForTests();
          const siblingStartTime = getFileLockProcessStartTime(siblingProcessId);
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "stale process failure",
            failedAtMs: 123,
            processId: siblingProcessId,
            processStartTime: siblingStartTime === null ? 1 : siblingStartTime + 1,
          });

          expect(listContextEngineQuarantines()).toEqual([]);
        });
      });
    },
  );

  it("drops sibling records whose process identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-unverified-", async () => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        resetContextEngineRuntimeQuarantineForTests();
        // A null recorded start time (identity source unavailable to the
        // recorder) must fail closed instead of trusting bare PID liveness.
        seedSiblingQuarantineForTest({
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "unverifiable recorder identity",
          failedAtMs: 123,
          processId: siblingProcessId,
          processStartTime: null,
        });

        expect(listContextEngineQuarantines()).toEqual([]);
      });
    });
  });

  it("clears persisted quarantine records when owner engines unload", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-owner-", async () => {
      const owner = "plugin:lossless-claw";
      registerContextEngineForOwner(
        "lossless-claw",
        () => ({
          info: { id: "lossless-claw", name: "Lossless Claw", version: "1" },
          async ingest() {
            return { ingested: true };
          },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0 };
          },
          async compact() {
            return { ok: true, compacted: false };
          },
        }),
        owner,
      );
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner,
        operation: "bootstrap",
        reason: "plugin disabled",
        failedAt: new Date(123),
      });

      clearContextEnginesForOwner(owner);

      expect(listContextEngineQuarantines()).toEqual([]);
    });
  });
});
