// Bounds-checked binary writer and reader over ArrayBuffer/DataView, shared by the client and the server.
// Pure TypeScript: no Node or browser APIs beyond TextEncoder/TextDecoder.

export type ProtocolErrorCode = 'magic' | 'version' | 'type' | 'truncated' | 'trailing' | 'range' | 'value';

/** A message that cannot be decoded; nothing of it is returned. */
export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;

  constructor(capacity = 1024) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  reset(): void {
    this.pos = 0;
  }

  private need(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  i8(v: number): void {
    this.need(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
  }

  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  i16(v: number): void {
    this.need(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  /** Signed 24-bit (positions in cm: ±83 km). */
  i24(v: number): void {
    this.need(3);
    const x = v < 0 ? v + 0x1000000 : v;
    this.view.setUint16(this.pos, x & 0xffff, true);
    this.view.setUint8(this.pos + 2, (x >>> 16) & 0xff);
    this.pos += 3;
  }

  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  i32(v: number): void {
    this.need(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  f64(v: number): void {
    this.need(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /** Unsigned LEB128 (ids, counts): 1 byte below 128, at most 5 bytes for a u32. */
  varu(v: number): void {
    let x = v >>> 0;
    while (x >= 0x80) {
      this.u8((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.u8(x);
  }

  /** UTF-8 string with a varint byte length, cut (on a code point boundary) to `maxBytes`. */
  str(s: string, maxBytes = 1024): void {
    let b = encoder.encode(s);
    if (b.length > maxBytes) {
      let end = maxBytes;
      // Back off continuation bytes so the cut never splits a code point.
      while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
      b = b.subarray(0, end);
    }
    this.varu(b.length);
    this.raw(b);
  }

  raw(b: Uint8Array): void {
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
  }

  /** A copy of the bytes written so far, as its own ArrayBuffer. */
  finish(): ArrayBuffer {
    return this.buf.slice(0, this.pos);
  }

  /** A view of the bytes written so far (valid until the next write). */
  view8(): Uint8Array {
    return this.bytes.subarray(0, this.pos);
  }
}

export class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  pos = 0;

  constructor(data: ArrayBuffer | ArrayBufferView) {
    if (data instanceof ArrayBuffer) {
      this.view = new DataView(data);
      this.bytes = new Uint8Array(data);
    } else {
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  private take(n: number): number {
    if (this.pos + n > this.view.byteLength) throw new ProtocolError('truncated', `message truncated at byte ${this.pos} (needs ${n} more)`);
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  i8(): number {
    return this.view.getInt8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }

  i24(): number {
    const at = this.take(3);
    const x = this.view.getUint16(at, true) | (this.view.getUint8(at + 2) << 16);
    return x >= 0x800000 ? x - 0x1000000 : x;
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  varu(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (result > 0xffffffff) throw new ProtocolError('range', 'varint above u32');
        return result;
      }
    }
    throw new ProtocolError('range', 'varint longer than 5 bytes');
  }

  /**
   * A count of items that each take at least `minBytes`: checked against the bytes left before anything is
   * allocated, so a lying length field can never make the decoder reserve more than the message holds.
   */
  count(minBytes: number, max = 0xffff): number {
    const n = this.varu();
    if (n > max) throw new ProtocolError('range', `count ${n} above ${max}`);
    if (n * minBytes > this.remaining) throw new ProtocolError('truncated', `count ${n} points past the end of the message`);
    return n;
  }

  str(maxBytes = 1024): string {
    const n = this.varu();
    if (n > maxBytes) throw new ProtocolError('range', `string of ${n} bytes above ${maxBytes}`);
    const at = this.take(n);
    try {
      return decoder.decode(this.bytes.subarray(at, at + n));
    } catch {
      throw new ProtocolError('value', 'string is not valid UTF-8');
    }
  }

  end(): void {
    if (this.remaining !== 0) throw new ProtocolError('trailing', `${this.remaining} unexpected bytes after the message`);
  }
}
