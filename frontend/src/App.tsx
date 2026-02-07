import { useState, useEffect } from 'react';
import axios from 'axios';
import SQLTerminal from './components/SQLTerminal';
import SheetViewer from './components/SheetViewer';
import { ConnectivityProvider, useConnectivity } from './context/ConnectivityContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface BotResult {
  botName: string;
  cell: string;
  value: string;
  status: 'success' | 'lock_conflict' | 'error';
  message: string;
  lockWaitMs?: number;
}

interface BotSimResponse {
  success: boolean;
  summary: {
    totalBots: number;
    contestedCell: string;
    totalTimeMs: number;
    successes: number;
    lockConflicts: number;
    errors: number;
  };
  results: BotResult[];
}

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [botRunning, setBotRunning] = useState(false);
  const [botResults, setBotResults] = useState<BotSimResponse | null>(null);
  const [botCount, setBotCount] = useState(8);

  useEffect(() => {
    const envSheetId = import.meta.env.VITE_GOOGLE_SHEET_ID;
    if (envSheetId) {
      setSheetId(envSheetId);
    } else {
      const cached = localStorage.getItem('superjoin_sheet_id');
      if (cached) setSheetId(cached);
    }

    axios.get(`${API_URL}/api/config/sheet-id`)
      .then(res => {
        setSheetId(res.data.sheetId);
        localStorage.setItem('superjoin_sheet_id', res.data.sheetId);
      })
      .catch(err => console.error('Failed to fetch sheet ID:', err));
  }, []);

  const handleQueryExecuted = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <ConnectivityProvider>
      <AppContent 
        refreshKey={refreshKey}
        sheetId={sheetId}
        handleQueryExecuted={handleQueryExecuted}
        botRunning={botRunning}
        setBotRunning={setBotRunning}
        botResults={botResults}
        setBotResults={setBotResults}
        botCount={botCount}
        setBotCount={setBotCount}
        setRefreshKey={setRefreshKey}
      />
    </ConnectivityProvider>
  );
}

interface AppContentProps {
  refreshKey: number;
  sheetId: string | null;
  handleQueryExecuted: () => void;
  botRunning: boolean;
  setBotRunning: (v: boolean) => void;
  botResults: BotSimResponse | null;
  setBotResults: (v: BotSimResponse | null) => void;
  botCount: number;
  setBotCount: (v: number) => void;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
}

function AppContent({ 
  refreshKey, sheetId, handleQueryExecuted, botRunning, setBotRunning, 
  botResults, setBotResults, botCount, setBotCount, setRefreshKey 
}: AppContentProps) {
  const { isBackendOnline } = useConnectivity();

  const runBots = async () => {
    if (!isBackendOnline) return;
    setBotRunning(true);
    setBotResults(null);
    try {
      const res = await axios.post(`${API_URL}/api/bots/run`, { botCount });
      setBotResults(res.data);
      setRefreshKey(prev => prev + 1);
    } catch (err: any) {
      console.error('Bot simulation failed:', err);
    }
    setBotRunning(false);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-gray-900">
      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/2 border-r border-gray-700 flex flex-col">
          <SQLTerminal onQueryExecuted={handleQueryExecuted} />

          <div className="border-t border-[#333] bg-[#1e1e1e]">
            <div className="px-4 py-2 bg-[#252526] border-b border-[#333] flex items-center justify-between">
              <span className="text-gray-300 text-xs font-semibold uppercase tracking-wider">Lock Stress Test</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  Bots:
                  <input
                    type="number"
                    min={2}
                    max={50}
                    value={botCount}
                    onChange={(e) => setBotCount(Number(e.target.value))}
                    className="w-12 bg-[#2d2d2d] text-gray-200 text-xs px-2 py-1 rounded border border-[#444] focus:outline-none focus:border-blue-500"
                  />
                </label>
                <button
                  onClick={runBots}
                  disabled={botRunning || !isBackendOnline}
                  className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-xs font-medium transition-all"
                >
                  {botRunning ? 'Running...' : !isBackendOnline ? 'Offline' : 'Launch Bots'}
                </button>
              </div>
            </div>

            {botResults && (
              <div className="max-h-[220px] overflow-auto p-3 space-y-2">
                <div className="flex gap-2 flex-wrap text-[11px]">
                  <span className="bg-[#2d2d2d] text-gray-300 px-2 py-1 rounded">
                    {botResults.summary.totalBots} bots
                  </span>
                  <span className="bg-[#2d2d2d] text-yellow-400 px-2 py-1 rounded">
                    Contested: {botResults.summary.contestedCell}
                  </span>
                  <span className="bg-green-900/40 text-green-400 px-2 py-1 rounded">
                    {botResults.summary.successes} success
                  </span>
                  <span className="bg-red-900/40 text-red-400 px-2 py-1 rounded">
                    {botResults.summary.lockConflicts} blocked
                  </span>
                  <span className="bg-[#2d2d2d] text-gray-400 px-2 py-1 rounded">
                    {botResults.summary.totalTimeMs}ms
                  </span>
                </div>

                <div className="space-y-1">
                  {botResults.results.map((r, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between px-3 py-1.5 rounded text-xs font-mono ${
                        r.status === 'success'
                          ? 'bg-green-900/20 border border-green-900/40'
                          : r.status === 'lock_conflict'
                          ? 'bg-red-900/20 border border-red-900/40'
                          : 'bg-yellow-900/20 border border-yellow-900/40'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          r.status === 'success' ? 'bg-green-500' : r.status === 'lock_conflict' ? 'bg-red-500' : 'bg-yellow-500'
                        }`}></span>
                        <span className="text-gray-300 font-semibold">{r.botName}</span>
                        <span className="text-gray-500">→</span>
                        <span className="text-gray-400">{r.cell}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`${
                          r.status === 'success' ? 'text-green-400' : r.status === 'lock_conflict' ? 'text-red-400' : 'text-yellow-400'
                        }`}>
                          {r.status === 'success' ? `"${r.value}"` : r.status === 'lock_conflict' ? 'BLOCKED' : 'ERROR'}
                        </span>
                        {r.lockWaitMs !== undefined && (
                          <span className="text-gray-600">{r.lockWaitMs}ms</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!botResults && !botRunning && (
              <div className="p-4 text-center text-gray-600 text-xs">
                Launch bots to simulate concurrent cell edits with lock contention
              </div>
            )}

            {botRunning && (
              <div className="p-4 flex items-center justify-center gap-2 text-purple-400 text-xs">
                <div className="animate-spin w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full"></div>
                Bots racing for locks...
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          <SheetViewer sheetId={sheetId} refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}

export default App;
