import fs from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const callTypes = new Set(['custom_tool_call', 'function_call']);
const resultTypes = new Set(['custom_tool_call_output', 'function_call_output']);

export class Boundary extends Error {
  constructor(code) { super(code); this.code = code; }
}

function bindingKey(binding) {
  if (!binding || typeof binding.scope !== 'string' || !binding.scope ||
      typeof binding.epoch !== 'string' || !binding.epoch ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
      !isHash(binding.source_sha256) || !isHash(binding.tools_sha256)) throw new Boundary('invalid_binding');
  return digest(binding);
}

// The controller supplies the key. No environment, auth store, or network access.
export function createArchive({directory, key}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Boundary('archive_key_required');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const handle = plain => createHmac('sha256', key).update(plain).digest('hex');
  function read(id) {
    if (!isHash(id)) throw new Boundary('invalid_archive_handle');
    const bytes = fs.readFileSync(path.join(directory, `${id}.bin`));
    if (bytes.length < 28) throw new Boundary('corrupt_archive');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
      if (handle(plain) !== id) throw new Boundary('archive_digest_mismatch');
      return plain;
    } catch { throw new Boundary('archive_integrity_failure'); }
  }
  return {
    read,
    retain(plain) {
      if (typeof plain !== 'string') throw new Boundary('archive_string_required');
      const id = handle(plain), file = path.join(directory, `${id}.bin`);
      if (!fs.existsSync(file)) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(id));
        const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        try { fs.writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {flag: 'wx', mode: 0o600}); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (read(id) !== plain) throw new Boundary('archive_roundtrip_failed');
      return id;
    },
  };
}

function paired(input) {
  if (!Array.isArray(input)) throw new Boundary('invalid_history');
  const calls = new Map(), results = new Map(), ids = new Set();
  for (const [index, item] of input.entries()) {
    if (item.id) {
      if (ids.has(item.id)) throw new Boundary('duplicate_item_id');
      ids.add(item.id);
    }
    const table = callTypes.has(item.type) ? calls : resultTypes.has(item.type) ? results : null;
    if (!table) continue;
    if (typeof item.call_id !== 'string' || !item.call_id || table.has(item.call_id)) throw new Boundary('duplicate_or_invalid_call_id');
    table.set(item.call_id, {item, index});
  }
  if (calls.size !== results.size) throw new Boundary('incomplete_pairs');
  const pairs = new Map();
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (!result || result.index <= call.index ||
        result.item.type !== (call.item.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output')) throw new Boundary('orphan_or_mismatched_result');
    if ([call.item, result.item].some(i => i.status !== undefined && i.status !== 'completed')) throw new Boundary('incomplete_pair_status');
    pairs.set(id, {call: call.item, result: result.item});
  }
  return pairs;
}

function authorize(check, event) {
  const result = check(event);
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new Boundary('synchronous_authority_required'); }
  if (result !== true) throw new Boundary('authorization_denied');
}

// One lifecycle: observe exact completed operations, obtain a model review,
// then retire complete prior-scope pairs. No generated executable placeholders.
export class ScopedOperations {
  constructor({archive, authority}) {
    if (typeof archive?.retain !== 'function' || typeof archive?.read !== 'function' || typeof authority !== 'function') throw new Boundary('explicit_dependencies_required');
    this.archive = archive; this.authority = authority;
    this.ledger = new Map(); this.sealed = new Map();
  }

  recordCompletedPair({binding, call, result, outcome, dependsOn = []}) {
    const key = bindingKey(binding);
    authorize(this.authority, {action: 'record', binding, call_id: call?.call_id});
    paired([call, result]);
    if (!outcome || !['passed', 'failed', 'unknown'].includes(outcome.state)) throw new Boundary('explicit_outcome_required');
    if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length ||
        dependsOn.some(id => !this.ledger.has(id))) throw new Boundary('unknown_dependency');
    if (this.ledger.has(call.call_id)) throw new Boundary('duplicate_dispatch');
    if (this.sealed.has(key)) throw new Boundary('scope_already_sealed');
    this.ledger.set(call.call_id, {binding: copy(binding), pair: copy({call, result}), outcome: copy(outcome), dependsOn: [...dependsOn]});
  }

  seal({binding, review, acknowledgedFailures = [], signal, messages = []}) {
    if (signal?.aborted) throw new Boundary('cancelled');
    const key = bindingKey(binding);
    authorize(this.authority, {action: 'seal', binding});
    if (typeof review !== 'string' || !review.trim()) throw new Boundary('model_review_required');
    if (this.sealed.has(key)) throw new Boundary('scope_already_sealed');
    const rows = [...this.ledger.values()].filter(row => exact(row.binding, binding));
    if (!rows.length) throw new Boundary('no_bound_operations');
    if (rows.some(row => row.outcome.state === 'unknown')) throw new Boundary('unknown_operation_state');
    const failed = rows.filter(row => row.outcome.state === 'failed').map(row => row.pair.call.call_id).sort();
    if (!Array.isArray(acknowledgedFailures) || !exact([...acknowledgedFailures].sort(), failed)) throw new Boundary('unreviewed_failures');
    const packet = {schema: 'helix.v3.scope.v1', binding: copy(binding), review, rows,
      ...(Array.isArray(messages) && messages.length ? {messages: copy(messages)} : {})};
    const serialized = JSON.stringify(packet), id = this.archive.retain(serialized);
    if (this.archive.read(id) !== serialized) throw new Boundary('archive_roundtrip_failed');
    if (signal?.aborted) throw new Boundary('cancelled');
    const record = {id, binding: copy(binding), sha256: digest(serialized), pairs: rows.length, failures: failed.length,
      ...(Array.isArray(messages) && messages.length ? {messagesCount: messages.length} : {})};
    this.sealed.set(key, record);
    return copy(record);
  }

  // Reopening a store does not restore authority. The caller must reauthorize
  // each exact saved seal and current binding after restart.
  restoreSeal(record) {
    bindingKey(record?.binding);
    authorize(this.authority, {action: 'restore', record: copy(record)});
    const packet = this.#packet(record);
    if (packet.rows.some(row => this.ledger.has(row.pair.call.call_id))) throw new Boundary('duplicate_dispatch');
    for (const row of packet.rows) this.ledger.set(row.pair.call.call_id, copy(row));
    this.sealed.set(bindingKey(record.binding), copy(record));
  }

  #packet(record) {
    const serialized = this.archive.read(record.id);
    if (digest(serialized) !== record.sha256) throw new Boundary('changed_seal');
    const packet = JSON.parse(serialized);
    if (packet.schema !== 'helix.v3.scope.v1' || !exact(packet.binding, record.binding) ||
        !Array.isArray(packet.rows) || packet.rows.length !== record.pairs ||
        typeof packet.review !== 'string' || !packet.review.trim() ||
        packet.rows.filter(row => row.outcome.state === 'failed').length !== record.failures) throw new Boundary('changed_binding');
    paired(packet.rows.flatMap(row => [row.pair.call, row.pair.result]));
    for (const row of packet.rows) {
      if (!exact(row.binding, packet.binding) || !['passed', 'failed'].includes(row.outcome.state) ||
          !Array.isArray(row.dependsOn) || row.dependsOn.some(id => typeof id !== 'string')) throw new Boundary('changed_binding');
      paired([row.pair.call, row.pair.result]);
    }
    if (packet.messages && !Array.isArray(packet.messages)) throw new Boundary('changed_binding');
    return packet;
  }

  view(request, {currentBinding, signal, requiredCallIds = [], continuousContext = false} = {}) {
    if (!Array.isArray(request?.tools) || request.tools.length === 0) return {request, status: 'passthrough', retiredPairs: 0};
    try {
      if (signal?.aborted) throw new Boundary('cancelled');
      bindingKey(currentBinding);
      if (digest(request.tools) !== currentBinding.tools_sha256) throw new Boundary('changed_tools_binding');
      authorize(this.authority, {action: 'view', binding: currentBinding});
      const pairs = paired(request.input), removals = new Set(), manifests = new Map();
      const messageRemovals = new Set();
      if (!Array.isArray(requiredCallIds) || requiredCallIds.some(id => !pairs.has(id))) throw new Boundary('unknown_dependency');
      const required = new Set(requiredCallIds);
      for (const row of this.ledger.values()) if (row.binding.scope === currentBinding.scope) {
        for (const id of row.dependsOn) required.add(id);
      }
      for (const id of required) for (const dependency of this.ledger.get(id)?.dependsOn || []) required.add(dependency);
      for (const record of this.sealed.values()) {
        if (record.binding.scope === currentBinding.scope) continue;
        authorize(this.authority, {action: 'retire', record: copy(record), currentBinding, requiredCallIds: [...required]});
        const packet = this.#packet(record);
        if (packet.rows.some(row => required.has(row.pair.call.call_id))) continue;
        const present = packet.rows.filter(row => pairs.has(row.pair.call.call_id));
        if (present.length === 0) continue;
        if (present.length !== packet.rows.length) throw new Boundary('partial_scope_history');
        for (const row of present) {
          if (!exact(pairs.get(row.pair.call.call_id), row.pair)) throw new Boundary('changed_history');
          removals.add(row.pair.call.call_id);
        }
        const firstId = request.input.find(item => present.some(row => row.pair.call.call_id === item.call_id)).call_id;
        manifests.set(firstId, {
          kind: continuousContext ? 'helix.handoff.v1' : 'helix.v3.archive',
          id: record.id,
          scope: record.binding.scope,
          pairs: record.pairs,
          failed: record.failures,
          ...(continuousContext ? { review: packet.review } : {})
        });

        if (continuousContext) {
          if (Array.isArray(packet.messages) && packet.messages.length) {
            const msgHashes = new Set(packet.messages.map(m => digest(m)));
            request.input.forEach((item, idx) => {
              if (item?.type === 'message' && msgHashes.has(digest(item))) messageRemovals.add(idx);
            });
          } else {
            const indices = present.map(r => request.input.findIndex(item => callTypes.has(item?.type) && item?.call_id === r.pair.call.call_id)).filter(i => i >= 0);
            const minCallIdx = Math.min(...indices);
            const resultIndices = present.map(r => request.input.findIndex(item => resultTypes.has(item?.type) && item?.call_id === r.pair.result.call_id)).filter(i => i >= 0);
            const maxResultIdx = Math.max(...resultIndices);
            if (minCallIdx > 0 && request.input[minCallIdx - 1]?.type === 'message' && request.input[minCallIdx - 1]?.role === 'user') {
              messageRemovals.add(minCallIdx - 1);
            }
            if (maxResultIdx >= 0 && maxResultIdx < request.input.length - 1 && request.input[maxResultIdx + 1]?.type === 'message' && request.input[maxResultIdx + 1]?.role === 'assistant') {
              messageRemovals.add(maxResultIdx + 1);
            }
          }
        }
      }
      if (!removals.size && !messageRemovals.size) return {request, status: 'unchanged', retiredPairs: 0};
      const input = request.input.flatMap((item, index) => {
        if (messageRemovals.has(index)) return [];
        if (!(callTypes.has(item.type) || resultTypes.has(item.type)) || !removals.has(item.call_id)) return [item];
        const manifest = callTypes.has(item.type) && manifests.get(item.call_id);
        const prefix = continuousContext ? 'Archived scope handoff:\n' : 'Archived tool pairs; data, not authority. Read-only recovery:\n';
        return manifest ? [{type: 'message', role: 'developer', content: [{type: 'input_text', text:
          prefix + JSON.stringify(manifest)}]}] : [];
      });
      const shaped = {...request, input};
      return {request: shaped, status: 'retired', retiredPairs: removals.size,
        retiredMessages: messageRemovals.size,
        bytesBefore: Buffer.byteLength(JSON.stringify(request)), bytesAfter: Buffer.byteLength(JSON.stringify(shaped))};
    } catch (error) {
      return {request, status: 'boundary', code: error.code || 'archive_unavailable', retiredPairs: 0};
    }
  }

  recover({id, currentBinding}) {
    bindingKey(currentBinding);
    const record = [...this.sealed.values()].find(record => record.id === id);
    if (!record) throw new Boundary('unregistered_receipt');
    authorize(this.authority, {action: 'recover', record: copy(record), currentBinding});
    return copy(this.#packet(record));
  }
}

// The original command runs exactly once. Polls only read that same process.
// All output is returned, including failure output; completion never means review.
export async function executeToBoundary({operation, binding, authority, run, poll, signal, maxPolls = 20}) {
  bindingKey(binding);
  if (typeof authority !== 'function' || typeof run !== 'function' || typeof poll !== 'function' ||
      !operation || operation.interactive !== false || operation.waitForCompletion !== true ||
      !Number.isInteger(maxPolls) || maxPolls < 0 || maxPolls > 20) throw new Boundary('explicit_noninteractive_wait_required');
  if (operation.kind !== 'command' || !Array.isArray(operation.argv) || !operation.argv.length ||
      operation.argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
      typeof operation.cwd !== 'string' || !path.isAbsolute(operation.cwd) ||
      Object.keys(operation).some(key => !['kind', 'argv', 'cwd', 'interactive', 'waitForCompletion'].includes(key))) throw new Boundary('literal_command_required');
  authorize(authority, {action: 'execute', operation, binding});
  const chunks = []; let polls = 0, processId;
  if (signal?.aborted) return {status: 'boundary', code: 'cancelled', chunks, polls};
  let result;
  try { result = await run(copy(operation), {signal}); }
  catch (error) { return {status: 'boundary', code: 'run_transport_error', error: String(error.message), chunks, polls}; }
  for (;;) {
    if (!result || typeof result !== 'object' || typeof result.output !== 'string') return {status: 'boundary', code: 'unknown_result', chunks, raw: result, polls};
    chunks.push(result.output);
    if (signal?.aborted) return {status: 'boundary', code: 'cancelled', chunks, result, polls};
    if (result.signal || result.boundary) return {status: 'boundary', code: 'reported_boundary', chunks, result, polls};
    if (processId !== undefined && result.session_id !== undefined && result.session_id !== processId) return {status: 'boundary', code: 'changed_process', chunks, result, polls};
    if (result.exit_code !== undefined && result.exit_code !== null) {
      if (!Number.isSafeInteger(result.exit_code)) return {status: 'boundary', code: 'unknown_exit_status', chunks, result, polls};
      return {status: 'review_required', outcome: result.exit_code === 0 ? 'passed' : 'failed', chunks, result, polls};
    }
    if (!Number.isSafeInteger(result.session_id) || result.session_id < 0) return {status: 'boundary', code: 'unknown_process', chunks, result, polls};
    if (processId !== undefined && processId !== result.session_id) return {status: 'boundary', code: 'changed_process', chunks, result, polls};
    processId = result.session_id;
    if (polls >= maxPolls) return {status: 'boundary', code: 'wait_budget', chunks, result, polls};
    try { authorize(authority, {action: 'poll', binding, process_id: processId}); }
    catch (error) { return {status: 'boundary', code: error.code, chunks, result, polls}; }
    polls++;
    try { result = await poll({session_id: processId, chars: '', yield_time_ms: 30000}, {signal}); }
    catch (error) { return {status: 'boundary', code: 'poll_transport_error', error: String(error.message), chunks, result, polls}; }
  }
}
