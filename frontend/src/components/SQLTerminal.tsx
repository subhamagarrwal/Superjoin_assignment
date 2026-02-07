import { useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import axios from 'axios';
import { useConnectivity } from '../context/ConnectivityContext';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface Props {
  onQueryExecuted: () => void;
}

interface QueryResult {
  success: boolean;
  data?: any[];
  error?: string;
  rowsAffected?: number;
}

const SAMPLE_QUERIES = [
  "SELECT * FROM users;",
  "INSERT INTO users (row_num, col_name, cell_value, last_modified_by) VALUES (1, 'A', 'Hello', 'sql_terminal');",
  "UPDATE users SET cell_value = 'Updated' WHERE row_num = 1 AND col_name = 'A';",
  "SELECT row_num, col_name, cell_value FROM users ORDER BY row_num, col_name;",
  "DELETE FROM users WHERE row_num = 1 AND col_name = 'A';",
];

export default function SQLTerminal({ onQueryExecuted }: Props) {
  const [query, setQuery] = useState('SELECT * FROM users;');
  const [results, setResults] = useState<QueryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const editorRef = useRef<any>(null);
  const { isBackendOnline, addToOfflineQueue, offlineQueue } = useConnectivity();

  const handleEditorMount = (editor: any) => {
    editorRef.current = editor;

    editor.addAction({
      id: 'execute-query',
      label: 'Execute Query',
      keybindings: [2048 | 3],
      run: () => {
        executeQuery();
      },
    });
  };

  const executeQuery = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    if (!isBackendOnline) {
      addToOfflineQueue(trimmed);
      const result: QueryResult = {
        success: false,
        error: `⏳ Backend offline - Query queued for execution when backend comes online`,
      };
      setResults(prev => [result, ...prev].slice(0, 20));
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/api/sql/execute`, {
        query: trimmed,
      });

      const result: QueryResult = response.data;
      setResults(prev => [result, ...prev].slice(0, 20));
      onQueryExecuted();
    } catch (error: any) {
      const result: QueryResult = {
        success: false,
        error: error.response?.data?.error || error.message,
      };
      setResults(prev => [result, ...prev].slice(0, 20));
    }
    setLoading(false);
  };

  const loadSample = (sample: string) => {
    setQuery(sample);
  };

  const clearResults = () => {
    setResults([]);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="bg-[#1e1e1e] px-4 py-3 flex items-center justify-between border-b border-[#333]">
        <div className="flex items-center gap-3">
          <span className="text-gray-200 text-sm font-semibold tracking-wide">SQL Terminal</span>
          <select
            onChange={(e) => loadSample(e.target.value)}
            className="bg-[#2d2d2d] text-gray-300 text-xs px-2 py-1.5 rounded border border-[#444] hover:border-[#666] transition-colors focus:outline-none focus:border-blue-500"
            defaultValue=""
          >
            <option value="" disabled>Sample Queries</option>
            {SAMPLE_QUERIES.map((q, i) => (
              <option key={i} value={q}>{q.slice(0, 50)}...</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearResults}
            className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1 rounded text-xs"
          >
            Clear
          </button>
          <button
            onClick={executeQuery}
            disabled={loading}
            className={`${
              isBackendOnline 
                ? 'bg-green-600 hover:bg-green-700' 
                : 'bg-orange-600 hover:bg-orange-700'
            } text-white px-4 py-1 rounded text-sm font-medium disabled:opacity-50`}
          >
            {loading ? '⏳ Running...' : isBackendOnline ? '▶ Run (Ctrl+Enter)' : '📥 Queue (Offline)'}
          </button>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="h-2/5">
        <Editor
          height="100%"
          defaultLanguage="sql"
          theme="vs-dark"
          value={query}
          onChange={(value) => setQuery(value || '')}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            padding: { top: 10 },
          }}
        />
      </div>

      {/* Results Panel */}
      <div className="flex-1 bg-[#1e1e1e] border-t border-[#333] overflow-auto">
        <div className="px-4 py-2 bg-[#252526] border-b border-[#333] sticky top-0 flex items-center gap-2">
          <span className="text-gray-300 text-xs font-semibold uppercase tracking-wider">
            Query Results {results.length > 0 && <span className="text-gray-500 font-normal normal-case ml-1">({results.length} results)</span>}
          </span>
        </div>
        <div className="p-3 space-y-3">
          {results.length === 0 && (
            <div className="text-gray-500 text-sm text-center py-8">
              Run a query to see results
            </div>
          )}
          {results.map((result, i) => (
            <div key={i} className={`rounded border ${result.success ? 'border-green-800' : 'border-red-800'}`}>
              {result.success ? (
                <div>
                  <div className="px-3 py-1 bg-green-900/30 text-green-400 text-xs">
                    ✅ Query executed successfully
                    {result.rowsAffected !== undefined && ` — ${result.rowsAffected} rows affected`}
                  </div>
                  {result.data && result.data.length > 0 ? (
                    <ResultTable data={result.data} />
                  ) : (
                    <div className="px-3 py-2 text-gray-400 text-sm">No rows returned</div>
                  )}
                </div>
              ) : (
                <div className="px-3 py-2 bg-red-900/30 text-red-400 text-sm font-mono">
                  ❌ {result.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultTable({ data }: { data: any[] }) {
  const columns = Object.keys(data[0]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="bg-gray-700/50">
            <th className="px-3 py-2 text-gray-400 font-medium border-b border-gray-700 text-xs">#</th>
            {columns.map((col) => (
              <th key={col} className="px-3 py-2 text-gray-400 font-medium border-b border-gray-700 text-xs">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="hover:bg-gray-700/30">
              <td className="px-3 py-1.5 text-gray-500 border-b border-gray-800 text-xs">{i + 1}</td>
              {columns.map((col) => (
                <td key={col} className="px-3 py-1.5 text-gray-300 border-b border-gray-800">
                  {row[col]?.toString() ?? <span className="text-gray-600">NULL</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-1 text-gray-500 text-xs bg-gray-800/50">
        {data.length} row{data.length !== 1 ? 's' : ''} returned
      </div>
    </div>
  );
}