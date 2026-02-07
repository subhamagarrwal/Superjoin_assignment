import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { useConnectivity } from '../context/ConnectivityContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface CellData {
  row_num: number;
  col_name: string;
  cell_value: string;
  last_modified_by?: string;
  updated_at?: string;
}

interface Props {
  sheetId: string | null;
  refreshKey: number;
}

const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H','I'];
const DEFAULT_ROWS = 30;

export default function SheetViewer({ sheetId, refreshKey }: Props) {
  const [cells, setCells] = useState<CellData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isBackendOnline } = useConnectivity();

  const fetchData = useCallback(async () => {
    if (!isBackendOnline) {
      setError('Backend is offline');
      setLoading(false);
      return;
    }

    try {
      const response = await axios.post(`${API_URL}/api/sql/execute`, {
        query: 'SELECT row_num, col_name, cell_value, last_modified_by, updated_at FROM users ORDER BY row_num, col_name',
      });
      if (response.data.success) {
        setCells(response.data.data || []);
        setLastUpdated(new Date().toLocaleTimeString());
        setError(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to connect to backend');
      console.error('Failed to fetch data:', err);
    }
    setLoading(false);
  }, [isBackendOnline]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey, isBackendOnline]);

  useEffect(() => {
    if (!autoRefresh || !isBackendOnline) return;
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData, isBackendOnline]);

  const maxRow = Math.max(DEFAULT_ROWS, ...cells.map(c => c.row_num), 0);

  const getCellValue = (row: number, col: string): string => {
    const cell = cells.find(c => c.row_num === row && c.col_name === col);
    return cell?.cell_value || '';
  };

  const embedUrl = sheetId
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit?rm=minimal`
    : null;

  return (
    <div className="h-full flex flex-col">
      {embedUrl && (
        <div className={`${!isBackendOnline ? 'flex-1' : 'h-1/2'} flex flex-col border-b border-[#333]`}>
          <div className="px-4 py-3 bg-[#1e1e1e] border-b border-[#333] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-gray-200 text-sm font-semibold tracking-wide">Google Sheet (Live)</span>
            </div>
            <a
              href={`https://docs.google.com/spreadsheets/d/${sheetId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-xs underline"
            >
              Open in new tab ↗
            </a>
          </div>
          <iframe
            src={embedUrl}
            className="flex-1 w-full border-0"
            title="Google Sheet"
            allow="clipboard-read; clipboard-write"
          />
        </div>
      )}

      {isBackendOnline && (
      <div className={`${embedUrl ? 'h-1/2' : 'h-full'} flex flex-col bg-[#1e1e1e]`}>
        <div className="px-4 py-2 border-b border-[#333] flex justify-between items-center bg-[#252526]">
          <div className="flex items-center gap-3">
            <span className="text-gray-300 text-xs font-semibold uppercase tracking-wider">Database View</span>
            <span className="text-gray-500 text-xs bg-[#333] px-2 py-0.5 rounded-full">
              {cells.length} cells
            </span>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer group">
              <div className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-8 h-4 bg-gray-600 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-600"></div>
              </div>
              <span className="text-xs font-medium text-gray-400 group-hover:text-gray-300 transition-colors">Auto-sync</span>
            </label>
            
            <div className="h-4 w-px bg-[#444]"></div>

            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-[10px] font-mono">{lastUpdated}</span>
              <button
                onClick={fetchData}
                className="text-gray-400 hover:text-white hover:bg-[#333] p-1.5 rounded transition-all"
                title="Refresh Data"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="w-10 bg-gray-700 border border-gray-600 p-1 text-gray-400 text-xs"></th>
                {COLUMNS.map((col) => (
                  <th key={col} className="bg-gray-700 border border-gray-600 p-1.5 text-gray-300 font-medium text-xs min-w-[80px]">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: maxRow }, (_, i) => i + 1).map((row) => (
                <tr key={row} className="group">
                  <td className="bg-gray-700 border border-gray-600 p-1 text-gray-400 text-center text-xs font-mono">
                    {row}
                  </td>
                  {COLUMNS.map((col) => {
                    const value = getCellValue(row, col);
                    const hasValue = value !== '';

                    return (
                      <td
                        key={`${row}-${col}`}
                        className={`border border-gray-700 p-1.5 min-w-[80px] ${
                          hasValue ? 'bg-gray-900 text-gray-200' : 'bg-gray-850 text-gray-600'
                        }`}
                      >
                        {value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}