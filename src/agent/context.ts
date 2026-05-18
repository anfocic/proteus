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
   */
  signal: AbortSignal;
}
