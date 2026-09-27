import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/* ==========================================================================
   Reveal choreography
   ========================================================================== */

const STAGGER = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } } as const;
const RISE = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.7, 0.3, 1] } } } as const;

/**
 * Entrance only. Nothing here loops, and under `prefers-reduced-motion` the group renders at
 * its final state immediately rather than playing a shortened version of the same move.
 */
export function Reveal({ children, className, delay = 0 }: { readonly children: ReactNode; readonly className?: string; readonly delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce === true) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.5, delay, ease: [0.2, 0.7, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function RevealGroup({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  const reduce = useReducedMotion();
  if (reduce === true) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={STAGGER} initial="hidden" whileInView="show" viewport={{ once: true, margin: '0px 0px -10% 0px' }}>
      {children}
    </motion.div>
  );
}

export const riseItem = RISE;
