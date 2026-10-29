/** Socket abstraction so the engine runs on real WebSockets in apps and on fakes in tests. */

export interface Socket {
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: ((code: number) => void) | null;
}

export type Transport = (url: string, protocols: string[]) => Socket;

/** Default transport over the platform WebSocket. */
export const webSocketTransport: Transport = (url, protocols) => {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = 'arraybuffer';
  const sock: Socket = {
    send: (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    },
    close: (code) => {
      ws.close(code === 1000 || (code !== undefined && code >= 3000) ? code : 1000);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.addEventListener('open', () => sock.onopen?.());
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) sock.onmessage?.(new Uint8Array(ev.data));
  });
  ws.addEventListener('close', (ev) => sock.onclose?.(ev.code));
  ws.addEventListener('error', () => {
    // A failed handshake is followed by a close event; nothing extra to do here.
  });
  return sock;
};
