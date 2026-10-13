'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icon';

interface ToastItem {
  id: number;
  message: string;
}

const ToastContext = createContext<(message: string) => void>(() => {});

/** Shows a short, stable message in a polite live region; identical messages are not stacked. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string) => {
      const id = nextId.current++;
      setItems((all) => (all.some((t) => t.message === message) ? all : [...all.slice(-2), { id, message }]));
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={useMemo(() => show, [show])}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-sm animate-fade-up items-center gap-3 rounded-xl border border-white/10 bg-[#0f172a] py-2 pr-2 pl-4 text-[15px] text-white shadow-lg"
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-white/10"
              aria-label="Dismiss"
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
