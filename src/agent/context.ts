export interface ToolContext<TServices = Record<string, unknown>> {
  services: TServices;
  /**
   * Fires when the agent is aborted (via `RunAgentInput.signal`) OR when this
   * tool's `timeoutMs` expires. Always present; never-aborts when neither
   * source is wired, so handlers can unconditionally pass it to `fetch`,
   * `setTimeout`, etc.
   *
   * Note: `timeoutMs` already returns a `[TIMEOUT]` text marker to the model
   * on expiry. This signal is additive — it lets handlers cancel real work
   * (HTTP, DB queries, subprocesses) so they don't leak.
   *
   * Gotcha: per the WHATWG spec, listeners attached via
   * `addEventListener("abort", ...)` to a signal that is ALREADY aborted
   * never fire. If the agent is aborted before this handler runs, the signal
   * arrives in an already-aborted state. Prefer passing `ctx.signal` directly
   * to `fetch` / `setTimeout` (which check `.aborted` synchronously), or check
   * `ctx.signal.aborted` before relying on event listeners.
   */
  signal: AbortSignal;
}
