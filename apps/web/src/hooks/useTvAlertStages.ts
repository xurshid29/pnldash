import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import { tvApi, type TvAlertSettings } from '../api/tv';
import type { TvStage } from '../api/types';

const QUERY_KEY = ['tv', 'settings'] as const;

// The ⚙ menu's 📐 stage switches (2026-10-06): which VWAP-setup stages are
// announced. Server-side and global — the same switch mutes the phone and
// every dashboard; a switched-off stage still lands in the 📐 sidebar.
// Optimistic: the checkbox flips at once, and rolls back if the save fails.
export function useTvAlertStages() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => tvApi.settings(), staleTime: 60_000 });
  const save = useMutation({
    mutationFn: (announced: TvStage[]) => tvApi.saveSettings(announced),
    onMutate: async (announced) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<TvAlertSettings>(QUERY_KEY);
      if (prev) qc.setQueryData<TvAlertSettings>(QUERY_KEY, { ...prev, announced });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(QUERY_KEY, ctx.prev);
      void message.error('Could not save the 📐 alert stages');
    },
    onSuccess: (data) => qc.setQueryData(QUERY_KEY, data),
  });
  return { settings: query.data ?? null, save: (announced: TvStage[]) => save.mutate(announced) };
}
