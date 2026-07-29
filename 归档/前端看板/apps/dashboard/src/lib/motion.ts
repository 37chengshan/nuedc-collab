import type { LocalSettings } from '@/api/types';

export type ResolvedMotion = 'none' | 'reduced' | 'standard';

export function resolveMotionLevel(
  setting: LocalSettings['motionLevel'],
  prefersReduced: boolean,
): ResolvedMotion {
  if (setting === 'none') return 'none';
  if (setting === 'reduced') return 'reduced';
  if (setting === 'standard') return 'standard';
  return prefersReduced ? 'reduced' : 'standard';
}

const STANDARD: Record<'press' | 'hover' | 'toast' | 'menu' | 'drawer' | 'page', number> = {
  press: 100,
  hover: 150,
  toast: 200,
  menu: 250,
  drawer: 300,
  page: 400,
};

export function durationMs(
  kind: 'press' | 'hover' | 'toast' | 'menu' | 'drawer' | 'page',
  level: ResolvedMotion,
): number {
  if (level === 'none') return 0;
  if (level === 'reduced') return Math.min(100, STANDARD[kind]);
  return STANDARD[kind];
}
