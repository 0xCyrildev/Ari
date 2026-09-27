import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';

/* ==========================================================================
   Motion preference
   --------------------------------------------------------------------------
   The skill is absolute that parallax, loops and scroll-hijack collapse under
   `prefers-reduced-motion`, so this app obeys the OS setting. It also lets a
   person overrule it, because an operating system switching motion off for
   everything is not the same thing as a visitor not wanting motion on this page.

   Three states, stored under one key:
     auto  follow the OS (default)
     on    animate even if the OS says reduce
     off   never animate
   ========================================================================== */

export type MotionPref = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'ari.motion';

interface MotionState {
  readonly allowed: boolean;
  readonly pref: MotionPref;
  readonly setPref: (pref: MotionPref) => void;
}

const MotionContext = createContext<MotionState>({ allowed: true, pref: 'auto', setPref: () => undefined });

const readStored = (): MotionPref => {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'on' || value === 'off' || value === 'auto' ? value : 'auto';
  } catch {
    return 'auto';
  }
};

export function MotionProvider({ children }: { readonly children: ReactNode }) {
  const reduce = useReducedMotion();
  const [pref, setPrefState] = useState<MotionPref>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // A private window that refuses storage is not a reason to stop animating.
    }
  }, [pref]);

  const setPref = useCallback((next: MotionPref) => setPrefState(next), []);
  const allowed = pref === 'on' ? true : pref === 'off' ? false : reduce !== true;

  const value = useMemo<MotionState>(() => ({ allowed, pref, setPref }), [allowed, pref, setPref]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

/** True when this page may move. Every animated component asks before it animates. */
export const useMotionAllowed = (): boolean => useContext(MotionContext).allowed;

export const useMotionPref = (): MotionState => useContext(MotionContext);

const LABEL: Record<MotionPref, string> = { auto: 'Auto', on: 'On', off: 'Off' };
const NEXT: Record<MotionPref, MotionPref> = { auto: 'on', on: 'off', off: 'auto' };

/**
 * The control itself. Small, in the header, because a page that animates should say how to
 * stop it. The title spells out what `Auto` currently resolves to, so the state is never a guess.
 */
export function MotionSwitch() {
  const { allowed, pref, setPref } = useMotionPref();
  return (
    <button
      type="button"
      onClick={() => setPref(NEXT[pref])}
      title={`Motion: ${LABEL[pref]}${pref === 'auto' ? ` (your system asks for ${allowed ? 'standard' : 'reduced'} motion)` : ''}`}
      aria-label={`Motion ${LABEL[pref]}, click to change`}
      className="inline-flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-[11px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
    >
      <span className={allowed ? 'h-[6px] w-[6px] rounded-full bg-accent' : 'h-[6px] w-[6px] rounded-full bg-ink-4'} aria-hidden="true" />
      Motion {LABEL[pref]}
    </button>
  );
}
