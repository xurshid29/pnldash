import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { screenerApi } from '../api/screener';
import type { CyclePayload } from '../api/types';

// Today's opportunity-alert log (GET /api/screener/alerts) for the 📐
// sidebar. Polls on the cycle cadence, and refetches immediately when a
// cycle brings a new alert id so the sidebar and the toast appear together.
export function useAlertLog(payload: CyclePayload | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['screener', 'alerts'],
    queryFn: () => screenerApi.alerts(),
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
  const newestLive = payload?.alerts?.[0]?.id ?? null;
  useEffect(() => {
    if (newestLive) void qc.invalidateQueries({ queryKey: ['screener', 'alerts'] });
  }, [newestLive, qc]);
  return { alerts: query.data ?? [], isLoading: query.isLoading };
}
