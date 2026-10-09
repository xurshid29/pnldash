import { useEffect, type ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useScreenerStream } from '../hooks/useScreenerStream';
import { useScreenerAlerts } from '../hooks/useScreenerAlerts';
import { useTabTitleFlash } from '../hooks/useTabTitleFlash';
import { useEdge } from '../hooks/useEdge';
import { useEdgeAlerts } from '../hooks/useEdgeAlerts';
import { AlertToasts } from '../components/dashboard/AlertToasts';
import { ScreenerPanel } from '../components/screener/ScreenerPanel';
import { SelectedStockPanel } from '../components/screener/SelectedStockPanel';
import { NewsRoomPanel } from '../components/news/NewsRoomPanel';
import { ChartGrid } from '../components/charts/ChartGrid';
import { IgnitionSidebar } from '../components/screener/IgnitionSidebar';
import { TvSetupsSidebar } from '../components/screener/TvSetupsSidebar';
import { SelectionProvider, useSelection } from '../context/SelectionContext';
import { useLayout } from '../context/LayoutContext';
import { LEAN_COMPONENT_FLAGS, type CyclePayload } from '../api/types';

// All panel sizes are persisted to localStorage by react-resizable-panels using
// the autoSaveId. Per-user persistence to /api/prefs/layout is a future bonus —
// localStorage already gives "remembered across sessions" on the same device.

export function DashboardPage() {
  const { payload, connected } = useScreenerStream();
  useScreenerAlerts(payload);
  // Edge is parked by default (COMPONENTS_DISABLED); only poll + alert when
  // the API reports it enabled. Before the first cycle arrives we assume lean.
  const edgeEnabled = (payload?.components ?? LEAN_COMPONENT_FLAGS).edge === true;
  const { events: edgeEvents, isLoading: edgeLoading } = useEdge(edgeEnabled);
  useEdgeAlerts(edgeEvents, edgeEnabled && !edgeLoading);
  useTabTitleFlash(payload);
  const { chartCount, hideNewsRoom } = useLayout();
  const chartsVisible = chartCount > 0;
  // The left rail (back 2026-10-05) holds the 📐 setups list, so it sits next
  // to the Momentum table instead of hiding it behind a tab. Ignition / Live
  // Ticks (parked since 2026-10-01) stack under it when re-enabled.
  const railComponents = payload?.components ?? LEAN_COMPONENT_FLAGS;
  const showIgnition = railComponents.ignition || railComponents.ticks === true;

  return (
    <SelectionProvider>
      <AutoSelectFirstTicker payload={payload} />
      <AlertToasts payload={payload} />
      <div style={{ width: '100%', height: '100%', background: '#0a0a0a' }}>
        <PanelGroup direction="horizontal" autoSaveId="ms-outer">
          <Panel id="ms-pane-rail" order={0} defaultSize={18} minSize={12} maxSize={32}>
            {showIgnition ? (
              <PanelGroup direction="vertical" autoSaveId="ms-rail">
                <Panel defaultSize={55} minSize={20}>
                  <Card><TvSetupsSidebar payload={payload} /></Card>
                </Panel>
                <VHandle />
                <Panel defaultSize={45} minSize={20}>
                  <Card><IgnitionSidebar payload={payload} /></Card>
                </Panel>
              </PanelGroup>
            ) : (
              <Card><TvSetupsSidebar payload={payload} /></Card>
            )}
          </Panel>
          <HHandle />
          <Panel
            id="ms-pane-left"
            order={1}
            defaultSize={82 - (chartsVisible ? 42 : 0)}
            minSize={25}
          >
            {/* The news room is hidden by default (2026-10-09, header News
                switch); hidden, it unmounts, so its feed stops polling. Ids +
                order let the saved sizes follow whichever panels are shown. */}
            <PanelGroup direction="vertical" autoSaveId="ms-left">
              <Panel id="ms-left-screener" order={0} defaultSize={hideNewsRoom ? 60 : 45} minSize={20}>
                <Card><ScreenerPanel payload={payload} connected={connected} /></Card>
              </Panel>
              <VHandle />
              <Panel id="ms-left-quote" order={1} defaultSize={hideNewsRoom ? 40 : 30} minSize={15}>
                <Card><SelectedStockPanel payload={payload} /></Card>
              </Panel>
              {!hideNewsRoom && <VHandle />}
              {!hideNewsRoom && (
                <Panel id="ms-left-news" order={2} defaultSize={25} minSize={15}>
                  <Card><NewsRoomPanel payload={payload} /></Card>
                </Panel>
              )}
            </PanelGroup>
          </Panel>
          {/* Charts collapse entirely at count 0 — the chart pane unmounts so
              the TradingView iframes are torn down, not just hidden. */}
          {chartsVisible && <HHandle />}
          {chartsVisible && (
            <Panel id="ms-pane-charts" order={2} defaultSize={42} minSize={25}>
              <Card>
                <ChartGrid />
              </Card>
            </Panel>
          )}
        </PanelGroup>
      </div>
    </SelectionProvider>
  );
}

// On dashboard mount, pick the first ticker from the screener so charts and
// the Quote Details panel start with content. Only fires while nothing is
// selected — the first user click locks selection in.
function AutoSelectFirstTicker({ payload }: { payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const firstTicker = payload?.rows?.[0]?.ticker ?? null;
  useEffect(() => {
    if (selected != null) return;
    if (firstTicker) setSelected(firstTicker);
  }, [selected, firstTicker, setSelected]);
  return null;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: '#1a1a1a',
        border: '1px solid #303030',
        borderRadius: 4,
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}

function HHandle() {
  return (
    <PanelResizeHandle
      style={{ width: 4, background: '#0a0a0a', cursor: 'col-resize', transition: 'background 0.15s' }}
      className="ms-handle ms-handle-h"
    />
  );
}

function VHandle() {
  return (
    <PanelResizeHandle
      style={{ height: 4, background: '#0a0a0a', cursor: 'row-resize', transition: 'background 0.15s' }}
      className="ms-handle ms-handle-v"
    />
  );
}
