import { writable } from 'svelte/store';

const storedGoodBcsts = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem('goodBcsts') || '[]') : [];
export const goodBcsts = writable(storedGoodBcsts);
goodBcsts.subscribe((value) => {
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('goodBcsts', JSON.stringify(value));
    }
});
export const allBcsts = writable([]);
export const filterBcsts = writable(false);
export const goodStatuses = writable(['in', 'pre']);
export const windowInfo = writable({
    screenWidth: 0,
    gameContentWidth: 0
})
export const accordionShow = writable({});