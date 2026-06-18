import { writable, derived } from 'svelte/store';
import { canonicalBcst } from './broadcasters';

function persisted<T>(key: string, initial: T) {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const store = writable<T>(stored !== null ? JSON.parse(stored) : initial);
    store.subscribe((value) => {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(key, JSON.stringify(value));
        }
    });
    return store;
}

export const goodBcsts = persisted<string[]>('goodBcsts', []);
// Migrate any legacy raw selections (e.g. "Fox Sports 1") to canonical names
// ("FS1") and dedup, so stored picks survive the move to canonical naming.
goodBcsts.update((l) => [...new Set(l.map(canonicalBcst))]);

// Per-day game counts per canonical broadcaster, keyed by `dt` then by name.
// Each DayGames overwrites its own day's entry (idempotent across effect re-runs);
// `bcstCounts` sums them into the totals the picker shows. The keys are also the
// full universe of seen broadcasters, so no separate `allBcsts` list is needed.
export const bcstCountsByDay = writable<Record<string, Record<string, number>>>({});
export const bcstCounts = derived(bcstCountsByDay, (byDay) => {
    const totals: Record<string, number> = {};
    for (const day of Object.values(byDay)) {
        for (const [name, n] of Object.entries(day)) {
            totals[name] = (totals[name] ?? 0) + n;
        }
    }
    return totals;
});
export const filterBcsts = persisted('filterBcsts', false);
export const goodStatuses = persisted('goodStatuses', ['in', 'pre']);
export const sortMode = persisted('sortMode', 'league');
export const windowInfo = writable({
    screenWidth: 0,
    gameContentWidth: 0
})
export const accordionShow = writable<Record<string, boolean>>({});
