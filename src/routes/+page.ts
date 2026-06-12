import type { PageLoad } from './$types';
import { base } from '$app/paths';

const getDateGames = (dt) => {
	const url = `https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=soccer&dates=${dt.replaceAll('-', '')}&limit=999&d=${(new Date()).toISOString()}`;
	return fetch(url).then(res => res.json());
}

const dateNDaysFromNow = (n) => {
	const tzoffset = (new Date()).getTimezoneOffset() * 60000;
	return new Date(new Date(Date.now() - tzoffset).setDate(new Date().getDate() + n)).toISOString().slice(0, 10);
}

export const load: PageLoad = async ({ fetch }) => {
	let days: Record<string, Promise<any>> = {};
	for (let i = 0; i <= 6; i++) {
		const dt = dateNDaysFromNow(i);
		days[dt] = getDateGames(dt);
	}
	const broadcasts = fetch(`${base}/broadcasts.json?d=${new Date().toISOString()}`)
		.then(res => res.json())
		.catch(() => ({ games: [] }));
	// ESPN's master league prominence order (slug -> rank), baked by the scraper.
	const leagueOrder = fetch(`${base}/league_order.json?d=${new Date().toISOString()}`)
		.then(res => res.json())
		.then((d) => {
			const rank: Record<string, number> = {};
			(d.leagues ?? []).forEach((slug: string, i: number) => { rank[slug] = i; });
			return rank;
		})
		.catch(() => ({}));
	return { days, broadcasts, leagueOrder };
};
