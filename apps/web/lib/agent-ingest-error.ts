/**
 * Shared error type for the Agent ingest libraries (heartbeat, log report,
 * backup report and operation agent auth). Carries the HTTP status and the
 * stable error code returned to agents. Each library keeps its own named
 * subclass so existing `instanceof` checks keep working, while shared
 * handling can catch this base class.
 */
export class AgentIngestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
