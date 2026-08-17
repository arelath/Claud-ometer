export class SessionSummaryDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSummaryDeferredError';
  }
}
