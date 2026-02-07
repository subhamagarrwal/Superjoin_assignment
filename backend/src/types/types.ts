export interface WebhookPayload{
    row : number;
    col : string;
    value: string;
    sheetId: string;
}

export interface SQLPayload{
    query: string;
}

export interface SyncEvent {
    type: 'INSERT' | 'UPDATE' | 'DELETE' ;
    row? : number;
    col? : string; 
    oldValue? : string;
    newValue? : string;
    source: 'sheet' | 'db';
    timestamp : number;
    metadata? : {
        action? : 'ADD_ROW' | 'DELETE_ROW' | 'ADD_COL' | 'DELETE_COL';
        affectedRange? : string;
    };
}

export interface JobData{
    row: number;
    col: string;
    value: string;
    sheetId: string;
    timestamp: number;
}

export interface SQLResult{
    success: boolean;
    data?: any;
    error?: string;
    rowsAffected?: number;
}