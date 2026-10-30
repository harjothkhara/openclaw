import assert from "node:assert/strict";

// ws 8.22.0's callback confirms bytes written out, not application consumption.
// Keep this at the native-facing write boundary; upstream observation is separate.
export function forwardNativeFrame(front, data, binary, onForwarded, onFailure, required = true) {
  if (front.readyState !== 1) {
    if (required) throw Error("Native relay frontend is not open");
    return false;
  }
  if (front.bufferedAmount >= 4 * 1024 * 1024) {
    if (required) throw Error("Relay backpressure");
    return false;
  }
  front.send(data, { binary }, (error) => {
    if (error) {
      onFailure(error);
      return;
    }
    if (front.readyState !== 1) {
      if (required) onFailure(Error("Native relay frontend closed before write receipt"));
      return;
    }
    // Evidence recording can fail its own budget; never throw from an I/O callback.
    try {
      onForwarded();
    } catch (error) {
      onFailure(error);
    }
  });
  return true;
}

export function configEventForwarded(records, conn, after) {
  return records.some(
    (row) =>
      row.t >= after &&
      row.conn === conn &&
      row.side === "event" &&
      row.delivery === "native-write-complete" &&
      row.method === "config.changed",
  );
}
