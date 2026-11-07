// Stream multiplexer shared by the hub and the agent over one WebSocket.
// JSON text frames carry control; binary frames carry bytes prefixed by a uint32
// channel id. Each direction of a channel is limited by a byte credit window, so a
// slow browser or backend stalls its own channel and cannot grow either process.
// hub/mux.mjs is a byte-identical copy; hub/test/hub.test.mjs enforces that.
const WINDOW_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

class Channel {
  constructor(mux, id) {
    this.mux = mux;
    this.id = id;
    this.sent = 0;
    this.acked = 0;
    this.closed = false;
    this.waiters = [];
    this.backlog = [];
    this.sink = undefined;
    this.endPending = false;
    this.sentEnd = false;
    this.gotEnd = false;
    this.onHead = undefined;
    this.onClose = undefined;
  }

  control(frame) { if (!this.closed) this.mux.sendJson({ ...frame, s: this.id }); }

  async write(chunk) {
    for (let at = 0; at < chunk.length && !this.closed; at += CHUNK_BYTES) {
      while (this.sent - this.acked >= WINDOW_BYTES && !this.closed) await new Promise((wake) => this.waiters.push(wake));
      if (this.closed) return;
      const piece = chunk.subarray(at, at + CHUNK_BYTES);
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(this.id);
      this.sent += piece.length;
      this.mux.sendBinary(Buffer.concat([prefix, piece]));
    }
  }

  /** Send a readable's bytes; ends this direction when the source ends. */
  async pipeFrom(readable) {
    try {
      for await (const chunk of readable) {
        await this.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (this.closed) return;
      }
      this.control({ t: 'end' });
      this.sentEnd = true;
      this.settle();
    } catch {
      this.abort();
    }
  }

  /** Deliver received bytes to a writable; credit returns only after it flushed them. */
  pipeTo(writable) {
    this.sink = writable;
    for (const data of this.backlog.splice(0)) this.deliver(data);
    if (this.endPending) writable.end();
  }

  deliver(data) {
    if (!this.sink) { this.backlog.push(data); return; }
    if (this.sink.destroyed || this.sink.writableEnded) return;
    this.sink.write(data, () => this.control({ t: 'ack', n: data.length }));
  }

  receive(frame) {
    if (frame.t === 'ack') {
      this.acked += frame.n;
      for (const wake of this.waiters.splice(0)) wake();
    } else if (frame.t === 'end') {
      if (this.sink) this.sink.end(); else this.endPending = true;
      this.gotEnd = true;
      this.settle();
    } else if (frame.t === 'abort') {
      this.closeLocal();
    } else {
      this.onHead?.(frame);
    }
  }

  /** Both directions ended cleanly: forget the channel, leaving in-flight flushes alone. */
  settle() {
    if (!this.sentEnd || !this.gotEnd || this.closed) return;
    this.closed = true;
    this.mux.channels.delete(this.id);
  }

  closeLocal() {
    if (this.closed) return;
    this.closed = true;
    this.mux.channels.delete(this.id);
    for (const wake of this.waiters.splice(0)) wake();
    this.onClose?.();
  }

  /** Tear down both directions and tell the peer. */
  abort() {
    this.control({ t: 'abort' });
    this.closeLocal();
  }
}

export class Mux {
  constructor({ sendJson, sendBinary, accept }) {
    this.sendJson = sendJson;
    this.sendBinary = sendBinary;
    this.accept = accept;
    this.channels = new Map();
    this.nextId = 1;
  }

  create() {
    const channel = new Channel(this, this.nextId);
    this.nextId += 1;
    this.channels.set(channel.id, channel);
    return channel;
  }

  json(frame) {
    if (typeof frame.s !== 'number') return;
    const channel = this.channels.get(frame.s);
    if (channel) { channel.receive(frame); return; }
    if (frame.t === 'req' && this.accept) {
      const accepted = new Channel(this, frame.s);
      this.channels.set(frame.s, accepted);
      this.accept(accepted, frame);
    }
  }

  binary(buffer) {
    if (buffer.length >= 4) this.channels.get(buffer.readUInt32BE(0))?.deliver(buffer.subarray(4));
  }

  /** The carrier is gone; no peer remains to notify. */
  closeAll() {
    for (const channel of [...this.channels.values()]) channel.closeLocal();
  }
}
