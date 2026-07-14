/**
 * iCloud Sync Detection Utilities
 *
 * Detects when iCloud sync is in progress or has pending changes,
 * allowing operations to warn users and verify results.
 *
 * Detection methods:
 * 1. Query NoteStore.sqlite for pending sync changes (ZICCLOUDSTATE)
 * 2. Check for recent database transaction activity
 * 3. Monitor WAL file modification time
 *
 * @module utils/syncDetection
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Sync status information.
 */
export interface SyncStatus {
  /** Whether sync activity is detected */
  syncDetected: boolean;
  /** Number of items pending upload to iCloud */
  pendingUpload: number;
  /** Seconds since last database modification */
  secondsSinceLastChange: number;
  /** Whether the database was recently modified (< 5 seconds) */
  recentActivity: boolean;
  /** Human-readable warning message if sync detected */
  warning?: string;
  /** Any error encountered during detection */
  error?: string;
}

/**
 * Result of a sync-aware operation.
 */
export interface SyncAwareResult<T> {
  /** The operation result */
  result: T;
  /** Sync status before the operation */
  syncBefore: SyncStatus;
  /** Sync status after the operation (for verification) */
  syncAfter?: SyncStatus;
  /** Whether sync may have interfered with the operation */
  syncInterference: boolean;
  /** Warning message if sync interference detected */
  interferenceWarning?: string;
}

const NOTES_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
);

const WAL_PATH = `${NOTES_DB_PATH}-wal`;

// How recent (in seconds) activity must be to be considered "active sync"
const RECENT_ACTIVITY_THRESHOLD_SECONDS = 5;

// Delay between operation and verification read (ms)
const VERIFICATION_DELAY_MS = 500;

// Cache TTL in milliseconds (2 seconds default)
const SYNC_STATUS_CACHE_TTL_MS = 2000;

// Cached sync status
let cachedSyncStatus: SyncStatus | null = null;
let cacheTimestamp = 0;

/**
 * Clears the sync status cache.
 * Useful for testing or when forcing a fresh check.
 */
export function clearSyncStatusCache(): void {
  cachedSyncStatus = null;
  cacheTimestamp = 0;
}

/**
 * Gets the current iCloud sync status by querying the Notes database.
 *
 * Results are cached for 2 seconds to avoid excessive database queries
 * during rapid successive operations.
 *
 * @param useCache - Whether to use cached results (default: true)
 * @returns Sync status information
 */
export function getSyncStatus(useCache = true): SyncStatus {
  // Return cached result if valid
  if (useCache && cachedSyncStatus && Date.now() - cacheTimestamp < SYNC_STATUS_CACHE_TTL_MS) {
    return cachedSyncStatus;
  }
  const status: SyncStatus = {
    syncDetected: false,
    pendingUpload: 0,
    secondsSinceLastChange: Infinity,
    recentActivity: false,
  };

  try {
    // Check if database exists
    if (!fs.existsSync(NOTES_DB_PATH)) {
      status.error = "Notes database not found";
      cachedSyncStatus = status;
      cacheTimestamp = Date.now();
      return status;
    }

    // Check WAL file modification time for recent activity
    if (fs.existsSync(WAL_PATH)) {
      const walStats = fs.statSync(WAL_PATH);
      const secondsAgo = (Date.now() - walStats.mtimeMs) / 1000;
      status.secondsSinceLastChange = Math.round(secondsAgo);
      status.recentActivity = secondsAgo < RECENT_ACTIVITY_THRESHOLD_SECONDS;
    }

    // Query for pending sync changes. Core Data can retain orphaned cloud-state
    // rows after their syncing objects are gone, so count only states still
    // referenced by a live ZICCLOUDSYNCINGOBJECT row.
    // Use a read-only connection and timeout to avoid blocking
    const query = `
      SELECT COUNT(*) FROM ZICCLOUDSTATE state
      WHERE state.ZCURRENTLOCALVERSION > state.ZLATESTVERSIONSYNCEDTOCLOUD
      AND state.ZLATESTVERSIONSYNCEDTOCLOUD IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ZICCLOUDSYNCINGOBJECT object
        WHERE object.ZCLOUDSTATE = state.Z_PK
      );
    `;

    // Use execFileSync (argv array, no shell) to match the sibling sqlite callers
    // (checklistParser.ts, noteMetadata.ts). The values here aren't user-controlled,
    // but argv form avoids shell quoting/interpolation entirely.
    const result = execFileSync(
      "sqlite3",
      ["-readonly", NOTES_DB_PATH, query.replace(/\n/g, " ")],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    status.pendingUpload = parseInt(result.trim(), 10) || 0;

    // Determine if sync is detected
    status.syncDetected = status.pendingUpload > 0 || status.recentActivity;

    // Generate warning message
    if (status.syncDetected) {
      const reasons: string[] = [];
      if (status.pendingUpload > 0) {
        reasons.push(`${status.pendingUpload} item(s) pending upload`);
      }
      if (status.recentActivity) {
        reasons.push(`database modified ${status.secondsSinceLastChange}s ago`);
      }
      status.warning = `iCloud sync in progress: ${reasons.join(", ")}. Results may be incomplete or change shortly.`;
    }
  } catch (error) {
    // Don't fail the operation due to sync detection errors
    status.error = error instanceof Error ? error.message : "Failed to check sync status";
  }

  // Cache the result
  cachedSyncStatus = status;
  cacheTimestamp = Date.now();

  return status;
}

/**
 * Logs a sync warning if sync is detected.
 *
 * @param status - The sync status to check
 * @param operation - Name of the operation being performed
 */
export function logSyncWarning(status: SyncStatus, operation: string): void {
  if (status.warning) {
    console.error(`[Sync Warning] ${operation}: ${status.warning}`);
  }
}

/**
 * Wraps an async operation with sync detection and verification.
 *
 * 1. Checks sync status before the operation
 * 2. Logs a warning if sync is detected
 * 3. Executes the operation
 * 4. Waits briefly and checks sync status again
 * 5. Determines if sync may have interfered
 *
 * @param operation - Name of the operation (for logging)
 * @param fn - The async operation to execute
 * @returns Result with sync status information
 */
export async function withSyncAwareness<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<SyncAwareResult<T>> {
  // Check sync status before operation
  const syncBefore = getSyncStatus();

  // Log warning if sync detected
  if (syncBefore.syncDetected) {
    logSyncWarning(syncBefore, operation);
  }

  // Execute the operation
  const result = await fn();

  // Wait briefly for any sync activity to settle
  await new Promise((resolve) => setTimeout(resolve, VERIFICATION_DELAY_MS));

  // Check sync status after operation (bypass cache for fresh data)
  const syncAfter = getSyncStatus(false);

  // Determine if sync may have interfered
  // Interference is likely if:
  // 1. Sync was active before and pending count changed
  // 2. Database was modified during the operation
  const pendingChanged = syncBefore.pendingUpload !== syncAfter.pendingUpload;
  const wasRecentBefore = syncBefore.recentActivity;
  const isRecentAfter = syncAfter.recentActivity;

  const syncInterference =
    (syncBefore.syncDetected && pendingChanged) || (wasRecentBefore && isRecentAfter);

  let interferenceWarning: string | undefined;
  if (syncInterference) {
    interferenceWarning =
      `iCloud sync activity detected during "${operation}". ` +
      `Pending items: ${syncBefore.pendingUpload} → ${syncAfter.pendingUpload}. ` +
      `Results may have been affected by sync.`;
    console.error(`[Sync Interference] ${interferenceWarning}`);
  }

  return {
    result,
    syncBefore,
    syncAfter,
    syncInterference,
    interferenceWarning,
  };
}

/**
 * Wraps a sync operation with sync detection and verification.
 * Synchronous version for AppleScript operations.
 *
 * @param operation - Name of the operation (for logging)
 * @param fn - The sync operation to execute
 * @returns Result with sync status information
 */
export function withSyncAwarenessSync<T>(operation: string, fn: () => T): SyncAwareResult<T> {
  // Check sync status before operation
  const syncBefore = getSyncStatus();

  // Log warning if sync detected
  if (syncBefore.syncDetected) {
    logSyncWarning(syncBefore, operation);
  }

  // Execute the operation
  const result = fn();

  // Check sync status after operation (bypass cache for fresh data)
  const syncAfter = getSyncStatus(false);

  // Determine if sync may have interfered
  const pendingChanged = syncBefore.pendingUpload !== syncAfter.pendingUpload;
  const wasRecentBefore = syncBefore.recentActivity;
  const isRecentAfter = syncAfter.recentActivity;

  const syncInterference =
    (syncBefore.syncDetected && pendingChanged) || (wasRecentBefore && isRecentAfter);

  let interferenceWarning: string | undefined;
  if (syncInterference) {
    interferenceWarning =
      `iCloud sync activity detected during "${operation}". ` +
      `Pending items: ${syncBefore.pendingUpload} → ${syncAfter.pendingUpload}. ` +
      `Results may have been affected by sync.`;
    console.error(`[Sync Interference] ${interferenceWarning}`);
  }

  return {
    result,
    syncBefore,
    syncAfter,
    syncInterference,
    interferenceWarning,
  };
}

/**
 * Checks if sync is currently active.
 * Convenience method for simple sync checks.
 *
 * @returns true if sync activity is detected
 */
export function isSyncActive(): boolean {
  return getSyncStatus().syncDetected;
}

/**
 * Gets a human-readable sync status summary.
 *
 * @returns Status summary string
 */
export function getSyncStatusSummary(): string {
  const status = getSyncStatus();

  if (status.error) {
    return `Sync status unknown: ${status.error}`;
  }

  if (!status.syncDetected) {
    return "iCloud sync: Idle";
  }

  const parts: string[] = ["iCloud sync: Active"];
  if (status.pendingUpload > 0) {
    parts.push(`${status.pendingUpload} pending upload(s)`);
  }
  if (status.recentActivity) {
    parts.push(`last activity ${status.secondsSinceLastChange}s ago`);
  }

  return parts.join(" - ");
}
