import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const HEALTH_CHECK_INTERVAL = 3000;
const OFFLINE_QUEUE_KEY = 'superjoin_offline_queue';
const HEALTH_CHECK_TIMEOUT = 5000;

interface QueuedQuery {
  id: string;
  query: string;
  timestamp: number;
}

interface ConnectivityContextType {
  isBackendOnline: boolean;
  lastChecked: string;
  offlineQueue: QueuedQuery[];
  addToOfflineQueue: (query: string) => void;
  clearOfflineQueue: () => void;
  processOfflineQueue: () => Promise<void>;
  isProcessingQueue: boolean;
}

const ConnectivityContext = createContext<ConnectivityContextType | null>(null);

function getInitialQueue(): QueuedQuery[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(OFFLINE_QUEUE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return [];
    }
  }
  return [];
}

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [isBackendOnline, setIsBackendOnline] = useState(false);
  const [lastChecked, setLastChecked] = useState<string>('');
  const [offlineQueue, setOfflineQueue] = useState<QueuedQuery[]>(getInitialQueue);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  const offlineQueueRef = useRef<QueuedQuery[]>(getInitialQueue());
  const isProcessingRef = useRef(false);
  const isOnlineRef = useRef(false);
  const healthCheckIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    offlineQueueRef.current = offlineQueue;
  }, [offlineQueue]);
  useEffect(() => {
    isOnlineRef.current = isBackendOnline;
  }, [isBackendOnline]);

  useEffect(() => {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
  }, [offlineQueue]);

  const checkHealth = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/health`, { 
        timeout: HEALTH_CHECK_TIMEOUT 
      });
      if (response.data.status === 'ok') {
        setIsBackendOnline(true);
        setLastChecked(new Date().toLocaleTimeString());
        
        if (wasOffline) {
          setWasOffline(false);
        }
        return true;
      }
    } catch {
      setIsBackendOnline(false);
      setLastChecked(new Date().toLocaleTimeString());
      setWasOffline(true);
    }
    return false;
  }, [wasOffline]);

  useEffect(() => {
    checkHealth();
    
    healthCheckIntervalRef.current = setInterval(() => {
      checkHealth();
    }, HEALTH_CHECK_INTERVAL);
    
    return () => {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
    };
  }, [checkHealth]);

  const addToOfflineQueue = useCallback((query: string) => {
    const queuedQuery: QueuedQuery = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      query,
      timestamp: Date.now(),
    };
    setOfflineQueue(prev => [...prev, queuedQuery]);
    console.log('📥 Query queued for offline execution:', query);
  }, []);

  const clearOfflineQueue = useCallback(() => {
    setOfflineQueue([]);
    localStorage.removeItem(OFFLINE_QUEUE_KEY);
  }, []);

  const processOfflineQueue = useCallback(async () => {
    const currentQueue = offlineQueueRef.current;
    if (currentQueue.length === 0 || !isOnlineRef.current || isProcessingRef.current) return;
    
    isProcessingRef.current = true;
    setIsProcessingQueue(true);
    console.log(`🔄 Processing ${currentQueue.length} queued queries...`);
    
    const successIds: string[] = [];
    
    for (const item of currentQueue) {
      try {
        await axios.post(`${API_URL}/api/sql/execute`, { query: item.query });
        successIds.push(item.id);
        console.log(`✅ Queued query executed: ${item.query.slice(0, 80)}`);
      } catch (err) {
        console.error(`❌ Failed to execute queued query: ${item.query.slice(0, 80)}`, err);
      }
    }
    
    setOfflineQueue(prev => prev.filter(q => !successIds.includes(q.id)));

    isProcessingRef.current = false;
    setIsProcessingQueue(false);
  }, []);

  useEffect(() => {
    if (isBackendOnline && offlineQueue.length > 0 && !isProcessingQueue) {
      const timeout = setTimeout(() => {
        processOfflineQueue();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isBackendOnline, offlineQueue.length, isProcessingQueue, processOfflineQueue]);

  return (
    <ConnectivityContext.Provider 
      value={{ 
        isBackendOnline, 
        lastChecked, 
        offlineQueue, 
        addToOfflineQueue, 
        clearOfflineQueue, 
        processOfflineQueue,
        isProcessingQueue 
      }}
    >
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity() {
  const context = useContext(ConnectivityContext);
  if (!context) {
    throw new Error('useConnectivity must be used within a ConnectivityProvider');
  }
  return context;
}
