import { useEffect, useRef, useState } from 'react';
import { streamEvents } from './api';

export const WINDOW = 120;

/**
 * Subscribes to an SSE endpoint and keeps a sliding window of the last `WINDOW` ticks (DSH-02). It
 * reconnects after errors and stops when the component unmounts.
 */
export function useEventStream<T>(
  path: string,
  eventName = 'tick',
): { points: T[]; connected: boolean } {
  const [points, setPoints] = useState<T[]>([]);
  const [connected, setConnected] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const ctrl = new AbortController();
    void (async () => {
      while (alive.current) {
        try {
          setConnected(true);
          await streamEvents(
            path,
            (event, data) => {
              if (event === eventName) setPoints((p) => [...p.slice(-(WINDOW - 1)), data as T]);
            },
            ctrl.signal,
          );
        } catch {
          // fall through to the retry delay
        }
        setConnected(false);
        if (!alive.current) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      alive.current = false;
      ctrl.abort();
    };
  }, [path, eventName]);
  return { points, connected };
}

/** Sets the document title so screen-reader users hear which page they are on. */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} - Syncra`;
  }, [title]);
}
