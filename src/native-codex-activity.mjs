import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const own = (object, key) => Object.hasOwn(object, key);
const absent = Symbol('not activity metadata');
const string = value => typeof value === 'string' && value.length <= 256;
const number = value => Number.isFinite(value);
const nullable = validate => value => value === null || validate(value);
const boolean = value => typeof value === 'boolean';
const record = value => ({record: value});
const array = value => ({array: value});
const item = {id: string, type: string, status: string};
const turn = {turnId: string, status: string, params: {model: nullable(string), collaborationMode: {settings: {model: nullable(string)}}}, items: array(item), itemsPagination: {}, turnStartedAtMs: nullable(number),
  finalAssistantStartedAtMs: nullable(number), completedItemIds: record(boolean), aeonAssistantMessageStartedAtMsById: record(number),
  agentMessageCompletedAtMsById: record(number), commandExecutionStartedAtMsById: record(number)};
const schema = {model: nullable(string), latestModel: nullable(string), threadRuntimeStatus: {type: string}, turns: array(turn),
  turnHistory: {kind: string, history: {entitiesByKey: record(turn)}}};
const safeKey = key => typeof key === 'number' ? Number.isSafeInteger(key) && key >= 0 && key < 100000 :
  typeof key === 'string' && key.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(key);

function child(spec, key) {
  if (!safeKey(key) || !spec || typeof spec === 'function') return undefined;
  if (spec.array) return typeof key === 'number' ? spec.array : undefined;
  if (spec.record) return spec.record;
  return own(spec, key) ? spec[key] : undefined;
}
function project(value, spec, budget = {remaining: 150000}) {
  if (--budget.remaining < 0) throw new Error('Activity metadata exceeds limit');
  if (typeof spec === 'function') return spec(value) ? value : absent;
  if (value === null) return null;
  if (typeof value !== 'object') return absent;
  if (spec.array) {
    if (!Array.isArray(value) || value.length > 100000) throw new Error('Invalid activity array');
    return value.map(entry => { const projected = project(entry, spec.array, budget); return projected === absent ? null : projected; });
  }
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    const selected = child(spec, key); if (!selected) continue;
    const projected = project(value[key], selected, budget); if (projected !== absent) result[key] = projected;
  }
  return result;
}
const unknown = detail => ({state: 'unknown', observed: false, model: null, source: 'codex-native', updated_at: Date.now(), detail});
const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange',
  'imageView', 'imageGeneration', 'collabAgentToolCall', 'subAgentActivity', 'toolCall']);
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

function mergeTurn(canonical, incoming) {
  const oldItems = canonical.items || [], newItems = incoming.items || [];
  const ids = values => values.map(value => value?.id);
  const oldIds = ids(oldItems), newIds = ids(newItems);
  if ([...oldIds, ...newIds].some(id => !id) || new Set(oldIds).size !== oldIds.length || new Set(newIds).size !== newIds.length) return null;
  const paginated = canonical.itemsPagination != null || incoming.itemsPagination != null;
  let items = newItems;
  if (paginated) {
    const anchors = new Map(oldIds.map((id, index) => [id, index])), before = new Map(); let pending = [], previous = -1;
    for (const value of newItems) {
      if (!anchors.has(value.id)) { pending.push(value); continue; }
      const index = anchors.get(value.id); if (index < previous) return null;
      previous = index; before.set(value.id, pending); pending = [];
    }
    items = oldItems.flatMap(value => [...(before.get(value.id) || []), value]).concat(pending);
  } else if (oldItems.length > newItems.length) {
    // Native reconciliation may compare answer text; only identity-prefix cases are metadata-safe.
    if (!newIds.every((id, index) => oldIds[index] === id)) return null;
    items = oldItems;
  }
  const merged = {...canonical, ...incoming, items,
    status: paginated && canonical.status !== 'inProgress' && incoming.status === 'inProgress' ? canonical.status : incoming.status,
    completedItemIds: {...incoming.completedItemIds, ...canonical.completedItemIds}};
  for (const key of ['aeonAssistantMessageStartedAtMsById', 'agentMessageCompletedAtMsById', 'commandExecutionStartedAtMsById', 'turnStartedAtMs', 'finalAssistantStartedAtMs']) merged[key] = canonical[key] ?? incoming[key];
  return merged;
}

export class NativeActivityProjection {
  constructor() { this.reset(); }
  reset() { this.value = null; this.revision = null; this.owner = null; this.last = null; }
  accept(change, owner) {
    if (!string(owner) || !owner || !Number.isSafeInteger(change?.revision) || change.revision < 0) throw new Error('Invalid activity revision');
    if (change.type === 'snapshot') {
      if (this.owner === owner && this.revision !== null && change.revision < this.revision) throw new Error('Stale activity snapshot');
      this.value = project(change.conversationState, schema);
      if (!this.value || this.value === absent) throw new Error('Invalid activity snapshot');
      this.owner = owner; this.revision = change.revision;
    } else if (change.type === 'patches') {
      if (!this.value || owner !== this.owner || change.baseRevision !== this.revision || change.revision <= this.revision || !Array.isArray(change.patches)) throw new Error('Activity revision gap');
      if (change.patches.length > 100000) throw new Error('Activity patch count exceeds limit');
      let changed = false;
      for (const patch of change.patches) changed = this.patch(patch) || changed;
      this.revision = change.revision;
      if (!changed && this.last) return {...this.last, updated_at: Date.now()};
    } else throw new Error('Unsupported activity change');
    this.last = this.snapshot(); return this.last;
  }
  patch(patch) {
    if (!['add', 'replace', 'remove'].includes(patch?.op) || !Array.isArray(patch.path) || patch.path.length > 32) throw new Error('Invalid activity patch');
    if (!patch.path.length) {
      if (patch.op === 'remove') throw new Error('Removed activity root');
      this.value = project(patch.value, schema); if (!this.value || this.value === absent) throw new Error('Invalid activity root'); return true;
    }
    let spec = schema;
    for (const key of patch.path) { spec = child(spec, key); if (!spec) return false; }
    let parent = this.value;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !own(parent, key)) throw new Error('Missing activity patch parent');
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (!parent || typeof parent !== 'object') throw new Error('Invalid activity patch parent');
    if (Array.isArray(parent)) {
      if (typeof key !== 'number' || key > parent.length || patch.op !== 'add' && key === parent.length) throw new Error('Invalid activity patch index');
    } else if (patch.op !== 'add' && !own(parent, key)) throw new Error('Missing activity patch target');
    if (patch.op === 'remove') { if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key]; return true; }
    const selected = project(patch.value, spec);
    if (selected === absent) throw new Error('Invalid activity metadata');
    if (Array.isArray(parent) && patch.op === 'add') parent.splice(key, 0, selected); else parent[key] = selected;
    return true;
  }
  snapshot() {
    const state = this.value;
    if (!state) return unknown('Waiting for a native Codex snapshot');
    let model = state.latestModel || state.model;
    const observed = phase => ({state: phase, observed: true, source: 'codex-native', updated_at: Date.now(),
      model: /^[a-zA-Z0-9._/:-]{1,128}$/.test(model || '') ? model : null,
      detail: {idle: 'Codex reports this chat is idle', waiting: 'Codex turn is active; waiting for the next observed item',
        reasoning: 'Codex reports an active reasoning item; reasoning text is not retained', generating: 'Codex is generating an assistant message',
        tool: 'Codex reports an active tool item', compacting: 'Codex is compacting this conversation', failed: 'Codex reported a failed turn'}[phase]});
    if (state.threadRuntimeStatus?.type === 'idle') return observed('idle');
    if (state.threadRuntimeStatus?.type && state.threadRuntimeStatus.type !== 'active') return unknown('Native runtime status is not recognized');
    const byId = new Map();
    for (const value of Object.values(state.turnHistory?.history?.entitiesByKey || {})) if (value?.turnId) byId.set(value.turnId, value);
    for (const value of state.turns || []) if (value?.turnId) {
      const canonical = byId.get(value.turnId), merged = canonical ? mergeTurn(canonical, value) : value;
      if (!merged && [canonical?.status, value.status].includes('inProgress')) return unknown('Native history views cannot be reconciled from metadata alone');
      if (!merged) continue;
      byId.set(value.turnId, merged);
    }
    const active = [...byId.values()].filter(value => value.status === 'inProgress');
    if (active.length > 1) return unknown('Multiple active turns; native phase is ambiguous');
    if (!active.length) {
      if (state.threadRuntimeStatus?.type === 'active') return observed('waiting');
      return unknown('Native turn status is not recognized');
    }
    const current = active[0], items = current.items || [];
    model = current.params?.collaborationMode?.settings?.model || current.params?.model || model;
    for (let index = items.length - 1; index >= 0; index--) {
      const value = items[index]; if (!value?.id) continue;
      const complete = current.completedItemIds?.[value.id];
      if (complete === true || terminal.has(value.status) || current.agentMessageCompletedAtMsById?.[value.id] !== undefined) continue;
      const open = complete === false || ['inProgress', 'running'].includes(value.status) ||
        value.type === 'agentMessage' && Number.isFinite(current.aeonAssistantMessageStartedAtMsById?.[value.id]);
      if (!open) continue;
      if (value.type === 'reasoning') return observed('reasoning');
      if (value.type === 'agentMessage') return observed('generating');
      if (value.type === 'contextCompaction') return observed('compacting');
      if (toolTypes.has(value.type)) return observed('tool');
      return unknown('Native active item type is not recognized');
    }
    return observed('waiting');
  }
}

export class ActivityFrames {
  constructor(receive, maximum = 16 * 1024 * 1024) { this.receive = receive; this.maximum = maximum; this.header = Buffer.alloc(4); this.headerSize = 0; this.payload = null; this.size = 0; }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const size = Math.min(4 - this.headerSize, chunk.length - offset);
        chunk.copy(this.header, this.headerSize, offset, offset + size); this.headerSize += size; offset += size;
        if (this.headerSize !== 4) continue;
        const length = this.header.readUInt32LE(0); this.headerSize = 0;
        if (!length || length > this.maximum) throw new Error('Native activity frame exceeds limit');
        this.payload = Buffer.allocUnsafe(length); this.size = 0;
      }
      const size = Math.min(this.payload.length - this.size, chunk.length - offset);
      chunk.copy(this.payload, this.size, offset, offset + size); this.size += size; offset += size;
      if (this.size === this.payload.length) {
        const complete = this.payload; this.payload = null; this.size = 0;
        try { this.receive(JSON.parse(complete.toString('utf8'))); } finally { complete.fill(0); }
      }
    }
  }
  close() { this.payload?.fill(0); this.payload = null; this.header.fill(0); this.headerSize = 0; this.size = 0; }
}

export function nativeActivityScope(value) {
  if (!value || Object.keys(value).some(key => !['threadId', 'hostId'].includes(key)) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.threadId || '') || value.hostId !== 'local') throw new Error('Explicit local Codex thread required');
  return {threadId: value.threadId, hostId: value.hostId};
}

export class NativeCodexActivity {
  constructor({changed = () => {}, socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc/ipc.sock'), retryMs = 2000, snapshotTimeoutMs = 10000, refreshMs = 60000} = {}) {
    this.changed = changed; this.socketPath = socketPath; this.retryMs = retryMs; this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.refreshMs = refreshMs;
    this.projection = new NativeActivityProjection(); this.state = unknown('Native Codex chat is not selected');
  }
  publish(state) {
    const previous = this.state; this.state = state;
    if (previous.state !== state.state || previous.observed !== state.observed || previous.model !== state.model || previous.detail !== state.detail) { try { this.changed(); } catch {} }
  }
  bind(value) {
    const scope = nativeActivityScope(value);
    if (this.scope?.threadId === scope.threadId && this.socket && !this.socket.destroyed) return;
    this.disconnect(); this.scope = scope; this.closed = false; this.connect();
  }
  follow(following) {
    if (!this.clientId || !this.socket || this.socket.destroyed) return;
    this.send({type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      params: {conversationId: this.scope.threadId, hostId: this.scope.hostId, following}});
  }
  send(value) {
    const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([header, data]));
  }
  waitSnapshot() {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => { this.publish(unknown('Native Codex snapshot timed out')); this.socket?.destroy(); }, this.snapshotTimeoutMs); this.deadline.unref();
  }
  connect() {
    if (this.closed || !this.scope) return;
    this.projection.reset(); this.clientId = null; this.resyncing = false; clearInterval(this.refresh);
    this.publish(unknown('Connecting to native Codex activity'));
    try {
      const directory = fs.lstatSync(path.dirname(this.socketPath)), socket = fs.lstatSync(this.socketPath), uid = process.getuid?.();
      if (!socket.isSocket() || directory.isSymbolicLink() || !directory.isDirectory() || uid === undefined || socket.uid !== uid || directory.uid !== uid || (socket.mode & 0o077) || (directory.mode & 0o077)) throw new Error('Owner-private native socket required');
      const connection = this.socket = net.createConnection(this.socketPath);
      const initialize = randomUUID();
      const frames = new ActivityFrames(message => {
        if (connection !== this.socket) return;
        if (message.type === 'response' && message.requestId === initialize) {
          if (!string(message.result?.clientId) || !message.result.clientId) throw new Error('Invalid native IPC initialization');
          this.clientId = message.result.clientId; this.follow(true);
          if (this.refreshMs) { this.refresh = setInterval(() => { this.follow(true); this.waitSnapshot(); }, this.refreshMs); this.refresh.unref(); }
          return;
        }
        if (message.method !== 'thread-stream-state-changed' || message.type !== 'broadcast' ||
            message.params?.conversationId !== this.scope.threadId || message.params?.hostId !== this.scope.hostId) return;
        if (message.version !== 11 || !Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this.clientId)) throw new Error('Incompatible native activity envelope');
        if (this.resyncing && message.params.change?.type === 'patches') return;
        try {
          const state = this.projection.accept(message.params.change, message.sourceClientId);
          this.resyncing = false; this.retryFailures = 0; clearTimeout(this.deadline); this.publish(state);
        } catch {
          this.projection.reset(); this.publish(unknown('Native activity revision changed; requesting a fresh snapshot'));
          if (this.resyncing) throw new Error('Native activity could not resynchronize');
          this.resyncing = true; this.follow(true); this.waitSnapshot();
        }
      });
      connection.on('connect', () => this.send({type: 'request', requestId: initialize, method: 'initialize', version: 0, params: {clientType: 'helix-monitor'}}));
      connection.on('data', chunk => { if (connection !== this.socket) return; try { frames.push(chunk); } catch { if (connection === this.socket) this.publish(unknown('Native activity protocol is unavailable or incompatible')); connection.destroy(); } });
      connection.on('error', () => { if (connection === this.socket) this.publish(unknown('Native Codex activity connection unavailable')); });
      connection.on('close', () => { frames.close(); if (connection === this.socket) { clearTimeout(this.deadline); clearInterval(this.refresh); this.publish(unknown('Native Codex activity disconnected')); this.schedule(); } });
      this.waitSnapshot();
    } catch { this.publish(unknown('Owner-private native Codex socket unavailable')); this.schedule(); }
  }
  schedule() {
    if (!this.closed) {
      const delay = Math.min(this.retryMs * 2 ** Math.min(this.retryFailures || 0, 5), 60000); this.retryFailures = (this.retryFailures || 0) + 1;
      clearTimeout(this.retry); this.retry = setTimeout(() => this.connect(), delay); this.retry.unref();
    }
  }
  disconnect() {
    clearTimeout(this.retry); clearTimeout(this.deadline); clearInterval(this.refresh);
    const connection = this.socket;
    try { this.follow(false); } catch {}
    this.socket = null; this.clientId = null; this.projection.reset();
    if (connection) connection.end();
  }
  close() { this.closed = true; this.disconnect(); this.publish(unknown('Native Codex activity disconnected')); }
  snapshot() { return this.state; }
}
