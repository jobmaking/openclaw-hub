'use strict';

const { once } = require('node:events');

class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.events = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) { this.events.push(message); return; }
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer); this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
  }
  static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new CDP(socket); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error('The desktop evaluation failed.');
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

module.exports = { CDP };
