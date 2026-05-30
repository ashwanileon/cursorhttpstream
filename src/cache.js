'use strict';

class Cache {
  constructor(sweepIntervalMs = 600000) { // Default sweep every 10 mins
    this.store = new Map();
    // Periodically remove expired items to prevent memory leaks on persistent servers
    this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
    // Ensure the interval doesn't keep the Node process alive if it's shutting down
    if (this.sweepInterval.unref) {
      this.sweepInterval.unref();
    }
  }

  async getOrSet(key, fetchFn, ttlMs = 300000) { // Default TTL 5 mins
    const hit = this.store.get(key);
    if (hit && Date.now() < hit.expiry) {
      return hit.value;
    }
    
    // Fetch new value
    const value = await fetchFn();
    if (value != null) {
      this.store.set(key, {
        value,
        expiry: Date.now() + ttlMs
      });
    }
    return value;
  }

  /**
   * Delete a specific key from the cache (used to clear stale failure entries).
   */
  delete(key) {
    this.store.delete(key);
  }

  sweep() {
    const now = Date.now();
    let swept = 0;
    for (const [key, item] of this.store.entries()) {
      if (now >= item.expiry) {
        this.store.delete(key);
        swept++;
      }
    }
    if (swept > 0) {
      console.log(`[Cache] Swept ${swept} expired items.`);
    }
  }

  clear() {
    this.store.clear();
  }
}

// Export a singleton instance
module.exports = new Cache();
