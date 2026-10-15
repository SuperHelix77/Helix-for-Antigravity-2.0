import {NativeOperationRejection} from './native-operation-rejection.mjs';
import {verificationCommand} from './verification.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export class CheckpointOperationRejection extends NativeOperationRejection {
  constructor(code, message) { super(code, message); this.name = 'CheckpointOperationRejection'; }
}

// Scope comes from a current controller snapshot, never model arguments or a receipt.
export function bindCheckpointOperation(args, {binding, task, allowPatch=false} = {}) {
  const allowed = ['op', 'revision', 'step', 'review', 'request_id', 'verify', ...(allowPatch?['patch']:[])];
  if (!object(args) || args.op !== 'checkpoint' || Object.keys(args).some(key => !allowed.includes(key)) ||
      !Number.isSafeInteger(args.revision) || args.revision < 1 || !string(args.step, 128) ||
      !string(args.review, 2000) || !string(args.request_id, 128))
    throw new CheckpointOperationRejection('invalid_arguments', 'Checkpoint requires revision, step, review and request_id; optional verify has cmd/workdir');
  if (!string(task, 256) || !object(binding) || binding.task !== task || binding.state !== 'active' ||
      binding.kind !== 'model' || binding.busy !== false || binding.revision !== args.revision || binding.step !== args.step ||
      !object(binding.scope) || Object.keys(binding.scope).sort().join(',') !== 'goal,project,session' ||
      !string(binding.scope.goal, 256) || !string(binding.scope.project, 4096) || !string(binding.scope.session, 256))
    throw new CheckpointOperationRejection('stale_frontier', 'Current controller-owned model frontier required; stale or cross-task checkpoint rejected');
  if (args.verify !== undefined) {
    try { verificationCommand(args.verify); }
    catch (error) { throw new CheckpointOperationRejection('invalid_verification', error.message); }
  }
  if (args.patch !== undefined && (!allowPatch || !string(args.patch,100000) || args.verify === undefined))
    throw new CheckpointOperationRejection('invalid_checkpoint_patch', 'Checkpoint patch requires explicit support, an exact patch and declared verification');
  return {tool: 'goal', args: {action: 'checkpoint', ...binding.scope, revision: args.revision,
    step: args.step, review: args.review, request_id: args.request_id}, verify: args.verify,
    ...(args.patch!==undefined?{patch:args.patch}:{})};
}
