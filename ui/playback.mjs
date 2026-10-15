// Public synthetic fixture. Never returned by the local service or labelled live.
export const playback = {
  schema: 'helix.monitor.v1', version: '1.0.1', status: 'online', core: 'online',
  model_state: {state: 'tool', model: 'Synthetic fixture model', observed: true, source: 'openai-proxy', updated_at: 1792023000000, detail: 'Synthetic tool activity. No live model connection.'},
  rtk: {enabled: false, available: false},
  memory: {status: 'deterministic', notes: 12, claude_bridge: false},
  counters: {operations: 38, failed: 1, model_calls: 0, memory_lookups: 7, known_input: 0, known_output: 0, unknown_usage: 0},
  active: [{id: 'playback-request-01', kind: 'memory', action: 'search', started: 1792023000000}],
  events: [
    {id: 'playback-event-08', at: 1792023000000, kind: 'tool-flow', action: 'resume', status: 'complete', elapsed_ms: 21},
    {id: 'playback-event-07', at: 1792022998000, kind: 'evidence', action: 'read', status: 'complete', elapsed_ms: 4},
    {id: 'playback-event-06', at: 1792022993000, kind: 'memory', action: 'search', status: 'complete', elapsed_ms: 3},
    {id: 'playback-event-05', at: 1792022991000, kind: 'tool-flow', action: 'run', status: 'failed', elapsed_ms: 126},
    {id: 'playback-event-04', at: 1792022988000, kind: 'evidence', action: 'store', status: 'complete', elapsed_ms: 8},
    {id: 'playback-event-03', at: 1792022985000, kind: 'goal', action: 'checkpoint', status: 'complete', elapsed_ms: 12},
    {id: 'playback-event-02', at: 1792022980000, kind: 'memory', action: 'put', status: 'complete', elapsed_ms: 2},
    {id: 'playback-event-01', at: 1792022976000, kind: 'tool-flow', action: 'validate', status: 'complete', elapsed_ms: 6},
  ],
  goals: [
    {id: 'playback-goal-01', project: 'sample-project', objective: 'Verify a deterministic tool result', state: 'active', cursor: 3, revision: 4, stored_only: true},
    {id: 'playback-goal-02', project: 'sample-project', objective: 'Review the archived evidence index', state: 'complete', cursor: 2, revision: 2, stored_only: true},
  ],
  compaction: {mode: 'native default', threshold_override: null, forced_early: false, observed: 0},
  privacy: {raw_session_export: false, background_llm: false},
  graph: {nodes: ['client', 'controller', 'tool-flow', 'evidence', 'memory'], active: ['memory']},
};

// Explicit fixtures for verifying the lamp independently of request activity.
export const modelPhases = ['idle', 'waiting', 'reasoning', 'generating', 'tool', 'complete', 'failed', 'unknown'].map(state => ({...playback.model_state, state, observed: state !== 'unknown'}));
