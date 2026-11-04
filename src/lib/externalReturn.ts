import type { ExternalPlayerReport } from "./externalHandoff.ts";

/** The relay consumes reports, so overlapping wake events must share one read. */
export function createReturnReportCheck(
  collect: (token: string, signal: AbortSignal) => Promise<ExternalPlayerReport | null>,
  { timeoutMs = 2500, retryDelaysMs = [200, 400] } = {},
) {
  const flights = new Map<string, Promise<ExternalPlayerReport | null>>();
  return (token: string): Promise<ExternalPlayerReport | null> => {
    if (!token) return Promise.resolve(null);
    const existing = flights.get(token);
    if (existing) return existing;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    const poll = async () => {
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
        if (controller.signal.aborted) return null;
        try {
          const report = await collect(token, controller.signal);
          if (report) return report;
        } catch {
          // Network failure keeps the manual fallback available.
        }
      }
      return null;
    };
    const flight = Promise.race([poll(), expired]).finally(() => {
      clearTimeout(timeout);
      controller.abort();
      flights.delete(token);
    });
    flights.set(token, flight);
    return flight;
  };
}
