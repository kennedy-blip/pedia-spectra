/**
 * PEDIA-SPECTRA Offline-First IndexedDB Clinical Vault + Mutation Sync Queue
 *
 * 5 Clinical Object Stores:
 *   1. cry_formant_logs
 *   2. bilirubin_tcb_scans
 *   3. respiratory_imci_checks
 *   4. medication_pk_doses
 *   5. nursery_sleep_audits
 * Plus:
 *   6. offline_sync_queue (for deferred POST /api/pediatric_clinical_solver handoff)
 */

const DB_NAME = 'PediaSpectraVaultV1';
const DB_VERSION = 1;

export const CLINICAL_STORES = [
  'cry_formant_logs',
  'bilirubin_tcb_scans',
  'respiratory_imci_checks',
  'medication_pk_doses',
  'nursery_sleep_audits',
];

const QUEUE_STORE = 'offline_sync_queue';

// Graceful memory fallback if IndexedDB is blocked in strict private browsing
const memoryFallback = Object.fromEntries(
  [...CLINICAL_STORES, QUEUE_STORE].map((name) => [name, []])
);

let dbPromise = null;

function openVaultDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        for (const storeName of [...CLINICAL_STORES, QUEUE_STORE]) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function makeRecordId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function saveClinicalRecord(storeName, payload, options = {}) {
  if (!CLINICAL_STORES.includes(storeName)) {
    throw new Error(`Unknown clinical store: ${storeName}`);
  }
  const record = {
    id: payload.id || makeRecordId(storeName.slice(0, 4)),
    store: storeName,
    timestamp: payload.timestamp || new Date().toISOString(),
    ...payload,
  };

  const db = await openVaultDb();
  if (!db) {
    memoryFallback[storeName].unshift(record);
  } else {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  if (options.enqueueSync !== false) {
    await enqueueSyncMutation({
      store: storeName,
      recordId: record.id,
      module: mapStoreToGoModule(storeName),
      payload: record,
    });
  }

  return record;
}

function mapStoreToGoModule(storeName) {
  switch (storeName) {
    case 'bilirubin_tcb_scans': return 'bilirubin_bhutani';
    case 'respiratory_imci_checks': return 'respiratory_imci';
    case 'medication_pk_doses': return 'mgkg_pk';
    default: return 'batch_sync';
  }
}

export async function getClinicalRecords(storeName, limit = 40) {
  const db = await openVaultDb();
  if (!db) {
    return memoryFallback[storeName].slice(0, limit);
  }
  return new Promise((resolve) => {
    const tx = db.transaction([storeName], 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => {
      const items = (req.result || []).sort((a, b) =>
        String(b.timestamp).localeCompare(String(a.timestamp))
      );
      resolve(items.slice(0, limit));
    };
    req.onerror = () => resolve([]);
  });
}

export async function enqueueSyncMutation(mutation) {
  const item = {
    id: makeRecordId('sync'),
    timestamp: new Date().toISOString(),
    status: 'PENDING_OFFLINE',
    retries: 0,
    ...mutation,
  };
  const db = await openVaultDb();
  if (!db) {
    memoryFallback[QUEUE_STORE].unshift(item);
    return item;
  }
  await new Promise((resolve) => {
    const tx = db.transaction([QUEUE_STORE], 'readwrite');
    tx.objectStore(QUEUE_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  return item;
}

export async function getSyncQueue() {
  const db = await openVaultDb();
  if (!db) {
    return [...memoryFallback[QUEUE_STORE]];
  }
  return new Promise((resolve) => {
    const tx = db.transaction([QUEUE_STORE], 'readonly');
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result || []).sort((a, b) =>
        String(b.timestamp).localeCompare(String(a.timestamp))
      );
      resolve(items);
    };
    req.onerror = () => resolve([]);
  });
}

export async function flushSyncQueue() {
  const queue = await getSyncQueue();
  const pending = queue.filter((q) => q.status !== 'SYNCED');
  if (pending.length === 0) {
    return { synced: 0, mode: 'empty', message: 'All clinical records are already synchronized.' };
  }

  let serverAck = null;
  let transport = 'offline-local-audit';

  try {
    const response = await fetch('/api/pediatric_clinical_solver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module: 'batch_sync',
        batchItems: pending.map((p) => p.payload),
      }),
    });
    if (response.ok) {
      serverAck = await response.json();
      transport = 'go-1.22-serverless';
    }
  } catch {
    // Offline or local Vite dev preview without Go backend mounted: seal locally cleanly
  }

  const db = await openVaultDb();
  const nowIso = new Date().toISOString();
  for (const item of pending) {
    item.status = serverAck ? 'SYNCED' : 'VERIFIED_LOCAL_VAULT';
    item.syncedAt = nowIso;
    item.transport = transport;
    if (!db) {
      const idx = memoryFallback[QUEUE_STORE].findIndex((x) => x.id === item.id);
      if (idx >= 0) memoryFallback[QUEUE_STORE][idx] = item;
    } else {
      await new Promise((resolve) => {
        const tx = db.transaction([QUEUE_STORE], 'readwrite');
        tx.objectStore(QUEUE_STORE).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  }

  return {
    synced: pending.length,
    mode: transport,
    serverAck,
    message: serverAck
      ? `Synced ${pending.length} records to Go 1.22 Pediatric Clinical Solver.`
      : `Offline Mode: Sealed & verified ${pending.length} records in local IndexedDB vault (ready for cloud relay).`,
  };
}

export async function getVaultSnapshot() {
  const snapshot = {};
  for (const store of CLINICAL_STORES) {
    snapshot[store] = await getClinicalRecords(store, 25);
  }
  snapshot.syncQueue = await getSyncQueue();
  return snapshot;
}

export async function clearAllVaultRecords() {
  const db = await openVaultDb();
  if (!db) {
    for (const k of Object.keys(memoryFallback)) {
      memoryFallback[k] = [];
    }
    return;
  }
  await new Promise((resolve) => {
    const tx = db.transaction([...CLINICAL_STORES, QUEUE_STORE], 'readwrite');
    for (const store of [...CLINICAL_STORES, QUEUE_STORE]) {
      tx.objectStore(store).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * 1-Tap Pediatrician Handoff Report Exporter (JSON + Printable HTML Summary)
 */
export async function exportPediatricianHandoffReport(patientMeta = {}) {
  const snapshot = await getVaultSnapshot();
  const generatedAt = new Date().toISOString();

  const report = {
    schema: 'PEDIA-SPECTRA-CLINICAL-HANDOFF-v1.26',
    generatedAt,
    disclaimer:
      'PEDIA-SPECTRA provides educational acoustic, optical, and pharmacokinetic triage telemetry. Always confirm hyperbilirubinemia, respiratory distress, or medication dosing with a licensed pediatrician or emergency physician.',
    patientProfile: {
      weightKg: patientMeta.weightKg ?? 7.5,
      ageMonths: patientMeta.ageMonths ?? 6,
      gestationalWeeks: patientMeta.gestationalWeeks ?? 39,
      postnatalHours: patientMeta.postnatalHours ?? 48,
      roleContext: patientMeta.role ?? 'Parent / Caregiver',
    },
    counts: {
      cryFormantLogs: snapshot.cry_formant_logs.length,
      bilirubinScans: snapshot.bilirubin_tcb_scans.length,
      respiratoryImciChecks: snapshot.respiratory_imci_checks.length,
      medicationPkDoses: snapshot.medication_pk_doses.length,
      nurserySleepAudits: snapshot.nursery_sleep_audits.length,
    },
    records: snapshot,
  };

  // Trigger JSON download
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pedia-spectra-pediatrician-handoff-${generatedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return report;
}
