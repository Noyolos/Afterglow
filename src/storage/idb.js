const DB_NAME = "memory-particles";
const DB_VERSION = 1;
const STORE_MEMORIES = "memories";
const STORE_ASSETS = "assets";
export const SCHEMA_VERSION = 1;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function getCrypto() {
  if (typeof globalThis !== "undefined" && globalThis.crypto) return globalThis.crypto;
  if (typeof crypto !== "undefined") return crypto;
  return null;
}

function uuidv4() {
  const cryptoObj = getCrypto();
  if (!cryptoObj?.getRandomValues) {
    throw new Error("crypto.getRandomValues is required to generate UUIDs");
  }
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return (
    `${HEX[bytes[0]]}${HEX[bytes[1]]}${HEX[bytes[2]]}${HEX[bytes[3]]}-` +
    `${HEX[bytes[4]]}${HEX[bytes[5]]}-` +
    `${HEX[bytes[6]]}${HEX[bytes[7]]}-` +
    `${HEX[bytes[8]]}${HEX[bytes[9]]}-` +
    `${HEX[bytes[10]]}${HEX[bytes[11]]}${HEX[bytes[12]]}${HEX[bytes[13]]}${HEX[bytes[14]]}${HEX[bytes[15]]}`
  );
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
        const store = db.createObjectStore(STORE_MEMORIES, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createMemoryId() {
  const cryptoObj = getCrypto();
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return uuidv4();
}

export class WebStorageProvider {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;
    this.db = await openDatabase();
    return this.db;
  }

  async saveMemory(record, { thumbBlob, renderBlob }) {
    if (!thumbBlob || !renderBlob) throw new Error("Missing blobs for saveMemory");
    const db = await this.init();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_ASSETS, STORE_MEMORIES], "readwrite");
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);

      const assets = tx.objectStore(STORE_ASSETS);
      assets.put({ key: record.assets.thumbKey, mime: thumbBlob.type, blob: thumbBlob });
      assets.put({ key: record.assets.renderKey, mime: renderBlob.type, blob: renderBlob });

      const memories = tx.objectStore(STORE_MEMORIES);
      memories.put(record);
    });
  }

  async getMemories() {
    const db = await this.init();
    const tx = db.transaction(STORE_MEMORIES, "readonly");
    const store = tx.objectStore(STORE_MEMORIES);
    const index = store.index("createdAt");

    return new Promise((resolve, reject) => {
      const results = [];
      const request = index.openCursor(null, "prev");

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAsset(key) {
    if (!key) return null;
    const db = await this.init();
    const tx = db.transaction(STORE_ASSETS, "readonly");
    const store = tx.objectStore(STORE_ASSETS);
    const request = store.get(key);
    return promisifyRequest(request);
  }

  async upsertMemory(record) {
    if (!record || !record.id) throw new Error("Missing memory record");
    const db = await this.init();
    const tx = db.transaction(STORE_MEMORIES, "readwrite");
    const store = tx.objectStore(STORE_MEMORIES);
    const request = store.put(record);
    await promisifyRequest(request);
    return record;
  }
}

const sharedProvider = new WebStorageProvider();

export const idb = {
  init() {
    return sharedProvider.init();
  },
  getAllMemories() {
    return sharedProvider.getMemories();
  },
  getAsset(key) {
    return sharedProvider.getAsset(key);
  },
  updateMemory(record) {
    return sharedProvider.upsertMemory(record);
  },
};
