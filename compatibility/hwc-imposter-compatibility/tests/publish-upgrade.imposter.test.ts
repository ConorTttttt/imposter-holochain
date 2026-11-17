/** Upgrade MUST discard legacy queued publication payloads of unknown visibility. */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { PublishTracker } from './publish-tracker';

const DB = 'hwc_publish_tracker';
function open(version: number, onUpgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, version);
    r.onupgradeneeded = () => onUpgrade?.(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('publish tracker v3 migration', () => {
  it('never retries serialized v2 DHT operations after confidentiality upgrade', async () => {
    const db = await open(2, idb => {
      idb.createObjectStore('pendingPublishes', { keyPath: 'id' });
    });
    const write = db.transaction('pendingPublishes', 'readwrite');
    write.objectStore('pendingPublishes').put({ id: 'legacy-unsafe-record',
      opData: 'synthetic-only-private-fixture', dnaHashStr: 'legacy', status: 'pending' });
    await complete(write);
    db.close();

    const tracker = PublishTracker.getInstance();
    await tracker.init();

    const upgraded = await open(3);
    const tx = upgraded.transaction('pendingPublishes', 'readonly');
    const count = await new Promise<number>((resolve, reject) => {
      const req = tx.objectStore('pendingPublishes').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(count).toBe(0);
    upgraded.close();
  });
});
