import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  subscribePollEvents,
  type PollEvent,
} from './api';

export type PollStatus = 'idle' | 'polling' | 'success' | 'error';

export type Toast = {
  id: number;
  feedId: number;
  feedName?: string;
  ok: boolean;
  error?: string;
};

type PollContextValue = {
  pollStatuses: Record<number, PollStatus>;
  pollAllStatus: PollStatus;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  setPollStatus: (feedId: number, status: PollStatus) => void;
  startPollAll: (feedIds: number[]) => void;
  addPendingPoll: (feedId: number) => void;
  feedNames: Record<number, string>;
  setFeedNames: (names: Record<number, string>) => void;
};

const PollCtx = createContext<PollContextValue | null>(null);

export function usePoll() {
  const ctx = useContext(PollCtx);
  if (!ctx) throw new Error('usePoll must be used within PollProvider');
  return ctx;
}

let toastSeq = 0;

export function PollProvider({ children }: { children: React.ReactNode }) {
  const [pollStatuses, setPollStatuses] = useState<Record<number, PollStatus>>({});
  const [pollAllStatus, setPollAllStatus] = useState<PollStatus>('idle');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [feedNames, setFeedNames] = useState<Record<number, string>>({});

  const pendingPollIds = useRef(new Set<number>());

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setPollStatus = useCallback((feedId: number, status: PollStatus) => {
    setPollStatuses((prev) => ({ ...prev, [feedId]: status }));
    if (status === 'polling') {
      pendingPollIds.current.add(feedId);
    }
  }, []);

  const startPollAll = useCallback((feedIds: number[]) => {
    setPollAllStatus('polling');
    for (const id of feedIds) {
      setPollStatuses((prev) => ({ ...prev, [id]: 'polling' }));
      pendingPollIds.current.add(id);
    }
  }, []);

  const addPendingPoll = useCallback((feedId: number) => {
    pendingPollIds.current.add(feedId);
    setPollStatuses((prev) => ({ ...prev, [feedId]: 'polling' }));
  }, []);

  useEffect(() => {
    const unsub = subscribePollEvents(
      (evt: PollEvent) => {
        const status: PollStatus = evt.ok ? 'success' : 'error';
        setPollStatuses((prev) => ({ ...prev, [evt.feed_id]: status }));

        pendingPollIds.current.delete(evt.feed_id);
        if (pendingPollIds.current.size === 0) {
          setPollAllStatus((s) => (s === 'polling' ? 'idle' : s));
        }

        const toast: Toast = {
          id: ++toastSeq,
          feedId: evt.feed_id,
          ok: evt.ok,
          error: evt.error,
        };
        setToasts((prev) => [...prev.slice(-9), toast]);

        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, 5000);

        setTimeout(() => {
          setPollStatuses((prev) => {
            if (prev[evt.feed_id] !== status) return prev;
            const next = { ...prev };
            delete next[evt.feed_id];
            return next;
          });
        }, 3000);
      },
      () => {},
    );
    return unsub;
  }, []);

  return (
    <PollCtx.Provider
      value={{
        pollStatuses,
        pollAllStatus,
        toasts,
        dismissToast,
        setPollStatus,
        startPollAll,
        addPendingPoll,
        feedNames,
        setFeedNames,
      }}
    >
      {children}
    </PollCtx.Provider>
  );
}
