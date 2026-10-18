import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screener';
import type { TvBreakout } from '../api/types';

// Today's 📐 BB breakout signals (script v17), newest first. The SSE 'breakout'
// event (useScreenerStream) prepends each new one to this cache as it arrives,
// so a TOUCH shows within a second; the poll is only a safety net.
export const BREAKOUTS_KEY = ['screener', 'breakouts', 'today'] as const;

export function useBreakouts() {
  const query = useQuery({
    queryKey: BREAKOUTS_KEY,
    queryFn: () => screenerApi.breakouts(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return { breakouts: query.data ?? [], isLoading: query.isLoading };
}

// A new breakout from the stream, newest first, without duplicates.
export function prependBreakout(cur: TvBreakout[] | undefined, ev: TvBreakout): TvBreakout[] | undefined {
  if (!cur) return cur;
  return cur.some((b) => b.id === ev.id) ? cur : [ev, ...cur];
}
