import type { LucideIcon } from 'lucide-react';

/** Lucide icons (lucide.dev) at the console's sizes: one stroke weight everywhere, decorative (labels carry the meaning). */
export const navIcon = (C: LucideIcon) => <C className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} aria-hidden />;
export const smallIcon = (C: LucideIcon, className = '') => <C className={`h-4 w-4 shrink-0 ${className}`} strokeWidth={1.75} aria-hidden />;
