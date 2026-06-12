import { writable } from 'svelte/store';

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

export const goodBcsts = persisted('goodBcsts', []);
export const allBcsts = writable([]);
export const filterBcsts = persisted('filterBcsts', false);
export const goodStatuses = persisted('goodStatuses', ['in', 'pre']);
export const sortMode = persisted('sortMode', 'league');
export const windowInfo = writable({
    screenWidth: 0,
    gameContentWidth: 0
})
export const accordionShow = writable({});
