"use client";
import { createContext, useCallback, useContext, useState } from "react";

const ToastCtx = createContext<(msg: string) => void>(() => {});

export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] flex flex-col gap-2 items-center">
        {toasts.map((t) => (
          <div key={t.id} className="bg-ink text-white text-sm font-bold rounded-full px-4 py-2 shadow-card">
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
