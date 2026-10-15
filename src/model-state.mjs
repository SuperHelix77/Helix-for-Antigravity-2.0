export class ModelState {
  constructor(changed = () => {}) { this.requests = new Map(); this.last = null; this.changed = changed; }
  start(id, model) { this.set(id, 'waiting', model, 'Waiting for the configured provider'); }
  set(id, state, model, detail) {
    const previous = this.requests.get(id);
    const value = {state, model, observed: true, source: 'openai-proxy', updated_at: Date.now(), detail};
    this.requests.set(id, value); this.last = value;
    if (!previous || previous.state !== state || previous.model !== model) { try { this.changed(); } catch {} }
  }
  event(id, record) {
    const old = this.requests.get(id); if (!old) return;
    const type = record.type || '', item = record.item?.type;
    if (/^response\.reasoning(?:_|\.)/.test(type) || type === 'response.output_item.added' && item === 'reasoning') this.set(id, 'reasoning', old.model, 'Provider emitted a reasoning event; private reasoning is not collected');
    else if (type === 'response.output_text.delta' || type === 'response.output_item.added' && item === 'message') this.set(id, 'generating', old.model, 'Provider is generating a response');
    else if (type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(item)) this.set(id, 'tool', old.model, 'Provider is preparing a tool call; execution is observed separately');
    else if (['response.failed', 'response.incomplete', 'error'].includes(type)) this.set(id, 'failed', old.model, 'Provider reported failure or an incomplete response');
  }
  finish(id, success) {
    const old = this.requests.get(id); if (!old) return;
    const state = typeof success === 'string' ? success : success ? 'complete' : 'failed';
    this.last = {...old, state, updated_at: Date.now(), detail: state === 'complete' ? 'Provider response completed' : state === 'unknown' ? 'Response ended without a completed status; ongoing provider state is unobservable' : 'Request failed, was cancelled or ended incomplete'};
    this.requests.delete(id);
    try { this.changed(); } catch {}
  }
  snapshot(active = []) {
    const requests = [...this.requests.values()];
    if (requests.length) return requests.find(r => r.state === 'reasoning') || requests.at(-1);
    if (active.some(r => r.kind !== 'openai')) return {state: 'tool', model: null, observed: true, source: 'mcp-only', updated_at: Date.now(), detail: 'HELIX is executing an MCP operation; client reasoning is not observable'};
    return this.last || {state: 'unknown', model: null, observed: false, source: 'none', updated_at: null, detail: 'No model stream connected. MCP tools do not expose the client reasoning state.'};
  }
}
