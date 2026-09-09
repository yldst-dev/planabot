export class MemoryConflictError extends Error {
  constructor() {
    super("기억이 다른 요청에서 변경되었습니다.");
    this.name = "MemoryConflictError";
  }
}
