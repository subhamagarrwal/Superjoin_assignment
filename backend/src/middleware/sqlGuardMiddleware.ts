import {Request, Response, NextFunction} from 'express';
import pino from 'pino';

const logger = pino();

// ── Maximum query length to prevent oversized payloads ──
const MAX_QUERY_LENGTH = 2000;

// ── DDL / DCL / administrative keywords that should never come from the terminal ──
const BLOCKED_KEYWORDS = [
    'DROP',
    'TRUNCATE',
    'ALTER',
    'CREATE DATABASE',
    'DROP DATABASE',
    'CREATE TABLE',
    'RENAME',
    'GRANT',
    'REVOKE',
    'LOCK TABLES',
    'UNLOCK TABLES',
    'FLUSH',
    'RESET',
    'PURGE',
    'HANDLER',
    'CALL',           // stored-procedure invocation
    'PREPARE',         // prepared statement abuse
    'EXECUTE',         // prepared statement abuse
    'DEALLOCATE',      // prepared statement abuse
];

// ── Dangerous MySQL functions / patterns (regex, case-insensitive) ──
const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
    // File-system access
    { pattern: /LOAD_FILE\s*\(/i,          label: 'LOAD_FILE()' },
    { pattern: /LOAD\s+DATA/i,             label: 'LOAD DATA' },
    { pattern: /INTO\s+OUTFILE/i,          label: 'INTO OUTFILE' },
    { pattern: /INTO\s+DUMPFILE/i,         label: 'INTO DUMPFILE' },

    // Time-based / DoS
    { pattern: /SLEEP\s*\(/i,              label: 'SLEEP()' },
    { pattern: /BENCHMARK\s*\(/i,          label: 'BENCHMARK()' },
    { pattern: /WAITFOR\s+DELAY/i,         label: 'WAITFOR DELAY' },

    // System / metadata probing
    { pattern: /@@\w+/i,                   label: 'System variables (@@...)' },
    { pattern: /INFORMATION_SCHEMA/i,       label: 'INFORMATION_SCHEMA' },
    { pattern: /mysql\s*\./i,              label: 'mysql.* system tables' },
    { pattern: /performance_schema/i,       label: 'performance_schema' },

    // Stacked queries (semicolon followed by another statement keyword)
    { pattern: /;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|SET)/i,
                                            label: 'Stacked queries' },

    // Comment-based obfuscation (inline comments hiding keywords)
    { pattern: /\/\*[\s\S]*?\*\//,         label: 'Inline SQL comments' },
    { pattern: /--\s/,                      label: 'SQL line comments' },

    // Hex / char obfuscation often used to bypass keyword filters
    { pattern: /0x[0-9a-fA-F]{6,}/,        label: 'Hex-encoded strings' },
    { pattern: /CHAR\s*\(\s*\d+/i,         label: 'CHAR() obfuscation' },
    { pattern: /CONCAT\s*\(/i,             label: 'CONCAT() (potential obfuscation)' },
];

// ── Only the `users` table may be written to ──
const ALLOWED_WRITE_TABLE = 'users';

export function sqlGuard(req: Request, res: Response, next: NextFunction) {
    const { query } = req.body;

    // ── 1. Type check ──
    if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Invalid SQL query' });
        return;
    }

    const trimmed = query.trim();

    // ── 2. Length check ──
    if (trimmed.length > MAX_QUERY_LENGTH) {
        logger.warn({ length: trimmed.length }, 'Query exceeds maximum length');
        res.status(400).json({ error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` });
        return;
    }

    // ── 3. Must not be empty after trim ──
    if (trimmed.length === 0) {
        res.status(400).json({ error: 'Query is empty' });
        return;
    }

    const upperQuery = trimmed.toUpperCase();

    // ── 4. Only allow SELECT / INSERT / UPDATE / DELETE ──
    const allowedStarters = /^\s*(SELECT|INSERT|UPDATE|DELETE|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
    if (!allowedStarters.test(trimmed)) {
        logger.warn({ query: trimmed }, 'Blocked query — only SELECT/INSERT/UPDATE/DELETE allowed');
        res.status(403).json({ error: 'Only SELECT, INSERT, UPDATE, and DELETE statements are allowed' });
        return;
    }

    // ── 5. Keyword blocklist ──
    for (const keyword of BLOCKED_KEYWORDS) {
        if (upperQuery.includes(keyword)) {
            logger.warn({ query: trimmed }, `Blocked SQL containing: ${keyword}`);
            res.status(403).json({ error: `"${keyword}" is not allowed` });
            return;
        }
    }

    // ── 6. Dangerous pattern detection ──
    for (const { pattern, label } of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            logger.warn({ query: trimmed, pattern: label }, `Blocked dangerous SQL pattern: ${label}`);
            res.status(403).json({ error: `Blocked: ${label} is not allowed` });
            return;
        }
    }

    // ── 7. Write queries must target the `users` table only ──
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(trimmed);
    if (isWrite) {
        const tablePattern = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(\w+)`?/i;
        const tableMatch = trimmed.match(tablePattern);
        if (tableMatch) {
            const targetTable = tableMatch[1].toLowerCase();
            if (targetTable !== ALLOWED_WRITE_TABLE) {
                logger.warn({ query: trimmed, table: targetTable }, 'Write to non-allowed table blocked');
                res.status(403).json({ error: `Writes are only allowed on the "${ALLOWED_WRITE_TABLE}" table` });
                return;
            }
        }
    }

    next();
}