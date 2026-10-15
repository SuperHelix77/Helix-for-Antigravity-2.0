export class NativeOperationRejection extends Error {
  constructor(code, message) { super(message); this.name = 'NativeOperationRejection'; this.code = code; }
}
