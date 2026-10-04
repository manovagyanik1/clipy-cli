export interface AgentContextWaitOptions {
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface AgentContextWaitResult {
  readonly response: Response;
  readonly timedOut: boolean;
}

function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 3_000;
}

async function fetchBeforeDeadline(
  fetchContext: (signal: AbortSignal) => Promise<Response>,
  remainingMs: number,
): Promise<Response | null> {
  if (remainingMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await fetchContext(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForAgentContext(
  fetchContext: (signal: AbortSignal) => Promise<Response>,
  options: AgentContextWaitOptions
): Promise<AgentContextWaitResult> {
  const startedAt = options.now();
  const initial = await fetchBeforeDeadline(fetchContext, options.timeoutMs);
  if (!initial) throw new Error('Agent context request exceeded the wait timeout');
  let response = initial;
  while (response.headers.get('x-clipy-agent-readiness') === 'preparing') {
    const remainingMs = options.timeoutMs - (options.now() - startedAt);
    if (remainingMs <= 0) return { response, timedOut: true };
    await options.sleep(Math.min(retryDelayMs(response), remainingMs));
    if (options.now() - startedAt >= options.timeoutMs) {
      return { response, timedOut: true };
    }
    const next = await fetchBeforeDeadline(
      fetchContext,
      options.timeoutMs - (options.now() - startedAt),
    );
    if (!next) return { response, timedOut: true };
    await response.body?.cancel().catch(() => {});
    response = next;
  }
  return { response, timedOut: false };
}
