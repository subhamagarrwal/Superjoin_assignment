import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';

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

const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const DEFAULT_ROWS = 15;

export default function SheetViewer({ sheetId, refreshKey }: Props) {
  const [cells, setCells] = useState<CellData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const maxRow = Math.max(DEFAULT_ROWS, ...cells.map(c => c.row_num), 0);

  const getCellValue = (row: number, col: string): string => {
    const cell = cells.find(c => c.row_num === row && c.col_name === col);
    return cell?.cell_value || '';
  };

  // Error state
  if (error && cells.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {/* Google Sheet iframe */}
        {sheetId && (
          <div className="h-1/2 flex flex-col border-b border-gray-700">
            <div className="px-3 py-2 bg-gray-800 border-b border-gray-700">
              <span className="text-gray-300 text-sm font-medium">📊 Google Sheet (Live)</span>
            </div>
            <iframe
              src={`https://docs.google.com/spreadsheets/d/${sheetId}/edit?rm=minimal`}
              className="flex-1 w-full border-0"
              title="Google Sheet"
            />
          </div>
        )}
        <div className="flex-1 flex items-center justify-center bg-gray-800">
          <div className="text-center">
            <p className="text-red-400 text-sm mb-2">❌ {error}</p>
            <p className="text-gray-500 text-xs">Make sure backend is running on {API_URL}</p>
            <button
              onClick={fetchData}
              className="mt-3 bg-blue-600 hover:bg-blue-700 text-white px-4 py-1 rounded text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-800">
        <div className="text-gray-400 flex items-center gap-2">
          <div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full"></div>
          Connecting to backend...
        </div>
      </div>
    );
  }

  const embedUrl = sheetId
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit?rm=minimal`
    : null;

  return (
    <div className="h-full flex flex-col">
      {/* Top: Embedded Google Sheet */}
      {embedUrl && (
        <div className="h-1/2 flex flex-col border-b border-gray-700">
          <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
            <span className="text-gray-300 text-sm font-medium">📊 Google Sheet (Live)</span>
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

      {/* Bottom: Database View */}
      <div className={`${embedUrl ? 'h-1/2' : 'h-full'} flex flex-col bg-gray-800`}>
        <div className="px-3 py-2 border-b border-gray-700 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-gray-300 text-sm font-medium">🗄️ Database View</span>
            <span className="text-gray-500 text-xs">
              {cells.length} cell{cells.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh
            </label>
            <span className="text-gray-500 text-xs">{lastUpdated}</span>
            <button
              onClick={fetchData}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs"
            >
              🔄
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2">
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
    </div>
  );
}