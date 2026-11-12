/**
 * Soft integration with Agent Threads (plugin id `claude-threads`). We never import it; we
 * reach its public API v1 through the plugin registry, same as threads-widgets / threads-design,
 * and treat its absence as a normal state. Types are our own copy of the few shapes used.
 */

export interface AgentThreadsApiV1 {
  readonly apiVersion: 1;
  readonly threads: {
    create(input: { readonly title?: string }): Promise<{ readonly threadId: string }>;
    send(threadId: string, input: { readonly prompt: string }): Promise<{ readonly runId: string }>;
    open(threadId: string): Promise<void>;
  };
}

interface PluginRegistry { plugins?: { plugins?: Record<string, unknown> } }

export const AGENT_THREADS_PLUGIN_ID = 'claude-threads';

/** The public API, or undefined when Agent Threads is not installed/enabled or speaks another version. */
export function getAgentThreadsApi(app: unknown): AgentThreadsApiV1 | undefined {
  const plugin = (app as PluginRegistry | undefined)?.plugins?.plugins?.[AGENT_THREADS_PLUGIN_ID] as
    { api?: { v1?: AgentThreadsApiV1 } } | undefined;
  const api = plugin?.api?.v1;
  return api && api.apiVersion === 1 && typeof api.threads?.create === 'function' ? api : undefined;
}

export function continuePrompt(notePath: string): string {
  return [
    `Continue the conversation from the imported ChatGPT note [[${notePath}]] (vault path: ${notePath}).`,
    'Read that note first. Then give me a two or three sentence recap of where the conversation left off and ask what I want to do next.',
  ].join('\n\n');
}

export interface ContinueTarget { path: string; title?: string }

/** Creates a thread pointing at the note, sends the first prompt and opens it. */
export async function continueInAgentThreads(api: AgentThreadsApiV1, target: ContinueTarget): Promise<string> {
  const title = `Continue: ${target.title?.trim() || target.path.replace(/^.*\//, '').replace(/\.md$/, '')}`.slice(0, 60);
  const { threadId } = await api.threads.create({ title });
  await api.threads.send(threadId, { prompt: continuePrompt(target.path) });
  await api.threads.open(threadId);
  return threadId;
}
