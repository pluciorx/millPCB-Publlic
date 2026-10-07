// One writer per resource. Expired locks are dropped on the next acquire.

export function createLockManager({ now = () => Date.now(), ttlMs = 120000 } = {}) {
    const locks = [];

    function sweep() {
        const t = now();
        for (let i = locks.length - 1; i >= 0; i--) {
            if (Date.parse(locks[i].expiresAt) <= t) locks.splice(i, 1);
        }
    }

    return {
        acquire({ resource, ownerAgentId, taskId, acquiredVersion }) {
            sweep();
            const existing = locks.find(l => l.resource === resource);
            if (existing && !(existing.ownerAgentId === ownerAgentId && existing.taskId === taskId)) {
                return { ok: false, error: 'LOCK_HELD', lock: { ...existing } };
            }
            if (existing) return { ok: true, lock: existing };
            const lock = {
                resource,
                ownerAgentId,
                taskId,
                acquiredVersion,
                expiresAt: new Date(now() + ttlMs).toISOString()
            };
            locks.push(lock);
            return { ok: true, lock };
        },
        releaseAll(taskId) {
            for (let i = locks.length - 1; i >= 0; i--) {
                if (locks[i].taskId === taskId) locks.splice(i, 1);
            }
        },
        list() {
            sweep();
            return locks.map(l => ({ ...l }));
        }
    };
}
