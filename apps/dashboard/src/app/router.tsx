/**
 * A 90-line router, because `react-router-dom` is not in this machine's pnpm store and the
 * box cannot reach the registry from Node.
 *
 * What it does: keep `window.history` and a React state in sync, parse `/segment/segment`
 * into params, and give links a `navigate()` that does not reload. What it deliberately does
 * not do: nested layout routes, loaders, scroll restoration beyond the top, or route data
 * — all of which are the parts of a router that a design system should not need.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

interface RouterValue {
  readonly path: readonly string[];
  readonly raw: string;
  readonly navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue>({ path: [], raw: '/', navigate: () => undefined });

export function RouterProvider({ children }: { readonly children: ReactNode }) {
  const [raw, setRaw] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setRaw(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, '', to);
    setRaw(to);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  const value = useMemo<RouterValue>(
    () => ({ raw, path: raw.split('/').filter((segment) => segment.length > 0), navigate }),
    [raw, navigate],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export const useRouter = (): RouterValue => useContext(RouterContext);

/** `useSegments()[1]` is the second path segment, and `undefined` when there is none. */
export function useSegments(): readonly string[] {
  return useRouter().path;
}

export function Link({ to, className, children, onClick }: { readonly to: string; readonly className?: string; readonly children: ReactNode; readonly onClick?: () => void }) {
  const { navigate } = useRouter();
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onClick?.();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} className={className}>
      {children}
    </a>
  );
}
