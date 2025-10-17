export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(chatId, initialState = {}) {
    const state = {
      createdAt: Date.now(),
      ...initialState,
    };
    this.sessions.set(chatId, state);
    return state;
  }

  get(chatId) {
    return this.sessions.get(chatId);
  }

  update(chatId, updater) {
    const existing = this.sessions.get(chatId) || {};
    const updated = typeof updater === "function" ? updater(existing) : updater;
    this.sessions.set(chatId, { ...existing, ...updated });
    return this.sessions.get(chatId);
  }

  delete(chatId) {
    this.sessions.delete(chatId);
  }
}
