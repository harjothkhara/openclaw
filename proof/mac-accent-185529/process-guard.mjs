const PER_CHILD_LOG_BYTES = 8 * 1024 * 1024;
const TOTAL_LOG_BYTES = 64 * 1024 * 1024;

// A denied group signal is evidence of failed cleanup, never an exception from an I/O callback.
export function createProcessGuard({
  onFailure,
  onOverflow,
  killProcess = process.kill,
  perChildLogBytes = PER_CHILD_LOG_BYTES,
  totalLogBytes = TOTAL_LOG_BYTES,
}) {
  const signalErrors = [];
  let totalBytes = 0;

  function signalError(p, operation, signal, error) {
    const receipt = { label: p.label, operation, signal, code: error.code || "UNKNOWN" };
    if (
      !signalErrors.some(
        (item) =>
          item.label === receipt.label &&
          item.operation === receipt.operation &&
          item.signal === receipt.signal &&
          item.code === receipt.code,
      )
    ) {
      signalErrors.push(receipt);
    }
    onFailure(Error(`${p.label} process-group ${operation} failed: ${receipt.code}`));
  }

  function signal(p, name = "SIGKILL") {
    if (!p || p.groupRetired || !p.child.pid) return;
    try {
      killProcess(-p.child.pid, name);
    } catch (error) {
      if (error.code === "ESRCH") {
        p.groupRetired = true;
        return;
      }
      signalError(p, "signal", name, error);
      try {
        if (!p.child.kill(name)) {
          signalError(p, "child-signal", name, { code: "KILL_RETURNED_FALSE" });
        }
      } catch (childError) {
        signalError(p, "child-signal", name, childError);
      }
    }
  }

  function alive(p) {
    if (!p.child.pid || p.groupRetired) return false;
    try {
      killProcess(-p.child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        p.groupRetired = true;
        return false;
      }
      signalError(p, "inspect", 0, error);
      return true; // Unknown liveness must block a green verdict.
    }
  }

  function account(p, bytes) {
    if (p.outputOverflow) return false;
    totalBytes += bytes;
    p.bytes += bytes;
    if (p.bytes <= perChildLogBytes && totalBytes <= totalLogBytes) return true;
    p.failed = true;
    p.outputOverflow = { label: p.label, childBytes: p.bytes, totalBytes };
    onOverflow(Error(`Log budget exceeded by ${p.label}`));
    signal(p);
    return false;
  }

  return { signal, alive, account, signalErrors };
}
