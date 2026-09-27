import { animate, motion, useMotionValue, useScroll, useSpring, useTransform, useInView } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** framer-motion 13 does not export useMediaQuery, and the question is a plain CSS one. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
import { useMotionAllowed } from '../app/motion-pref';
import { cx } from '../lib/util';

/* ==========================================================================
   Landing motion kit
   --------------------------------------------------------------------------
   Dials: VARIANCE 7, MOTION 7, DENSITY 4. At 7 the page has to actually move,
   and every move here answers a question the content is already asking:

     ScrollProgress   where am I in a long page                    (orientation)
     ParallaxImage    the photographs are places, not wallpaper     (depth)
     HorizontalPan    a pipeline is a sequence, so it reads sideways (storytelling)
     Marquee          the reason codes are a fixed vocabulary       (breadth)
     CountUp          these numbers are counts of real things       (emphasis)
     Tilt             one object, offered to the cursor             (feedback)

   Everything collapses to a static layout when motion is off, and the static
   layout is the one that is tested, not the leftover.
   ========================================================================== */

const EASE = [0.16, 1, 0.3, 1] as const;

/* ---------------------------------------------------------------- Reveal -- */

export function Reveal({ children, className, delay = 0, y = 26 }: { readonly children: ReactNode; readonly className?: string; readonly delay?: number; readonly y?: number }) {
  const allowed = useMotionAllowed();
  if (!allowed) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({ children, className, amount = 0.2 }: { readonly children: ReactNode; readonly className?: string; readonly amount?: number }) {
  const allowed = useMotionAllowed();
  if (!allowed) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, y = 22 }: { readonly children: ReactNode; readonly className?: string; readonly y?: number }) {
  const allowed = useMotionAllowed();
  if (!allowed) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={{ hidden: { opacity: 0, y }, show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE } } }}
    >
      {children}
    </motion.div>
  );
}

/* -------------------------------------------------------- ScrollProgress -- */

/** A hairline across the top. It is the only fixed element on the page. */
export function ScrollProgress() {
  const allowed = useMotionAllowed();
  const { scrollYProgress } = useScroll();
  const width = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);
  if (!allowed) return null;
  return (
    <motion.div
      aria-hidden="true"
      style={{ scaleX: width }}
      className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-accent"
    />
  );
}

/* ---------------------------------------------------------------- Marquee -- */

/**
 * One marquee per page, used for the reason-code vocabulary: the point of the strip is that the
 * set is finite and named, which is exactly what a policy engine is and what a model is not.
 */
export function Marquee({ items, duration = 46 }: { readonly items: readonly string[]; readonly duration?: number }) {
  const allowed = useMotionAllowed();
  if (!allowed) {
    return (
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item) => <li key={item} className="font-mono text-[11px] text-ink-3">{item}</li>)}
      </ul>
    );
  }
  const doubled = [...items, ...items];
  return (
    <div className="relative flex overflow-hidden" aria-hidden="true">
      <motion.div
        className="flex shrink-0 items-center gap-7 pr-7"
        animate={{ x: ['0%', '-50%'] }}
        transition={{ duration, ease: 'linear', repeat: Infinity }}
      >
        {doubled.map((item, index) => (
          <span key={`${item}-${index}`} className="flex shrink-0 items-center gap-7 font-mono text-[11px] text-ink-3">
            {item}
            <span className="h-[3px] w-[3px] rounded-full bg-ink-4" />
          </span>
        ))}
      </motion.div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-base to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-base to-transparent" />
    </div>
  );
}

/* --------------------------------------------------------- HorizontalPan -- */

/**
 * The seven stages, panned sideways while the section pins.
 *
 * A pipeline is a left-to-right sequence, and reading it as a seven-row table threw that away.
 * Below 900px, or when motion is off, the same children become a native scroll-snap row: the
 * sequence survives, the hijack does not.
 */
export function HorizontalPan({
  title,
  lead,
  children,
}: {
  readonly title: ReactNode;
  readonly lead?: ReactNode;
  readonly children: ReactNode;
}) {
  const allowed = useMotionAllowed();
  const narrow = useIsNarrow();
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [dist, setDist] = useState(0);
  const pan = allowed && narrow !== true;

  useEffect(() => {
    const trackEl = track.current;
    const wrapEl = wrap.current;
    if (trackEl === null || wrapEl === null) return;
    const measure = (): void => setDist(Math.max(0, trackEl.scrollWidth - wrapEl.clientWidth + 32));
    const observer = new ResizeObserver(measure);
    observer.observe(trackEl);
    observer.observe(wrapEl);
    measure();
    return () => observer.disconnect();
  }, []);

  const { scrollYProgress } = useScroll({ target: wrap, offset: ['start start', 'end end'] });
  const x = useTransform(scrollYProgress, [0, 1], [0, -dist]);
  const progress = useTransform(scrollYProgress, [0, 1], [0.06, 1]);
  const heading = (
    <div className="mx-auto w-full max-w-[75rem] px-5">
      {title}
      {lead !== undefined && <p className="mt-3 max-w-[58ch] text-[13px] leading-relaxed text-ink-3">{lead}</p>}
    </div>
  );

  if (!pan) {
    return (
      <div>
        {heading}
        <div className="mt-8 overflow-x-auto pb-4 snap-x snap-mandatory">
          <div ref={track} className="flex w-max gap-4 px-5">
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrap} className="relative" style={{ height: `calc(78dvh + ${dist}px)` }}>
      <div className="sticky top-0 flex h-[78dvh] flex-col justify-center overflow-hidden">
        {heading}
        <motion.div
          ref={track}
          style={{ x }}
          className="mt-7 flex w-max gap-4 pl-[max(1.25rem,calc((100vw-75rem)/2))]"
        >
          {children}
        </motion.div>
        {/* The rule under the row is the pan's own progress, so the hijack reports itself. */}
        <div className="mx-auto mt-7 w-full max-w-[75rem] px-5">
          <div className="h-[2px] w-full bg-line">
            <motion.div style={{ scaleX: progress }} className="h-full origin-left bg-accent" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ ParallaxImage */

/**
 * A photograph that scrolls at a different rate to its frame. The image is oversized inside a
 * clipped box so the parallax never exposes an edge, and `priority` is the hero's job alone.
 */
export function ParallaxImage({
  src,
  alt,
  className,
  strength = 9,
  priority = false,
  children,
}: {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
  readonly strength?: number;
  readonly priority?: boolean;
  readonly children?: ReactNode;
}) {
  const allowed = useMotionAllowed();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [`${-strength}%`, `${strength}%`]);

  return (
    <div ref={ref} className={cx('relative overflow-hidden bg-sunken', className)}>
      <motion.img
        src={src}
        alt={alt}
        decoding="async"
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        style={allowed ? { y } : {}}
        className={cx('absolute inset-x-0 -top-[9%] h-[118%] w-full object-cover', !allowed && 'static h-full')}
      />
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------- CountUp -- */

/** Counts a number that is a count of something real, once, when it enters view. */
export function CountUp({ to, suffix = '', duration = 1.1 }: { readonly to: number; readonly suffix?: string; readonly duration?: number }) {
  const allowed = useMotionAllowed();
  const ref = useRef<HTMLSpanElement>(null);
  const value = useMotionValue(allowed ? 0 : to);
  const text = useTransform(value, (current) => `${Math.round(current).toLocaleString('en-US')}${suffix}`);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });

  useEffect(() => {
    if (!allowed || !inView) return;
    const controls = animate(value, to, { duration, ease: EASE });
    return () => controls.stop();
  }, [allowed, inView, to, duration, value]);

  return (
    <span ref={ref} className="tabular-nums">
      <motion.span>{text}</motion.span>
    </span>
  );
}

/* -------------------------------------------------------------------- Tilt -- */

/**
 * Pointer tilt on one object. Motion values only, outside the render cycle: a `useState` here
 * would re-render the tree on every mouse move, which is the mistake this pattern is known for.
 */
export function Tilt({ children, className, max = 5 }: { readonly children: ReactNode; readonly className?: string; readonly max?: number }) {
  const allowed = useMotionAllowed();
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rotateX = useSpring(useTransform(py, [0, 1], [max, -max]), { stiffness: 140, damping: 18 });
  const rotateY = useSpring(useTransform(px, [0, 1], [-max, max]), { stiffness: 140, damping: 18 });

  return (
    <motion.div
      ref={ref}
      className={cx('[transform-style:preserve-3d]', className)}
      style={allowed ? { rotateX, rotateY } : {}}
      onPointerMove={(event) => {
        if (!allowed || ref.current === null) return;
        const box = ref.current.getBoundingClientRect();
        px.set((event.clientX - box.left) / box.width);
        py.set((event.clientY - box.top) / box.height);
      }}
      onPointerLeave={() => {
        px.set(0.5);
        py.set(0.5);
      }}
    >
      {children}
    </motion.div>
  );
}

/* --------------------------------------------------------- HeroEnter (one) -- */

/** The hero's load-in: four elements, one after another, never repeating. */
export function HeroEnter({ children, order = 0, className }: { readonly children: ReactNode; readonly order?: number; readonly className?: string }) {
  const allowed = useMotionAllowed();
  if (!allowed) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.08 + order * 0.09, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
