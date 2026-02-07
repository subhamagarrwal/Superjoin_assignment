import { useState, useEffect } from 'react';
import axios from 'axios';
import SQLTerminal from './components/SQLTerminal';
import SheetViewer from './components/SheetViewer';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [sheetId, setSheetId] = useState<string | null>(null);

  useEffect(() => {
    axios.get(`${API_URL}/api/config/sheet-id`)
      .then(res => setSheetId(res.data.sheetId))
      .catch(err => console.error('Failed to fetch sheet ID:', err));
  }, []);

  const handleQueryExecuted = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-gray-900">
      <header className="bg-gray-800 px-6 py-3 border-b border-gray-700 flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">
          ⚡ Superjoin - Sheet & DB Sync
        </h1>
        <span className="text-gray-400 text-sm">
          Google Sheets ↔ MySQL Real-time Sync
        </span>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/2 border-r border-gray-700 flex flex-col">
          <SQLTerminal onQueryExecuted={handleQueryExecuted} />
        </div>
        <div className="flex-1 flex flex-col">
          <SheetViewer sheetId={sheetId} refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}

export default App;
