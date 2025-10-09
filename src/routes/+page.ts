import type { PageLoad } from './$types';

const getDateGames = (dt) => {
	const url = `https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=soccer&dates=${dt.replaceAll('-', '')}&limit=999`;
	return fetch(url).then(res => res.json());
}

const dateNDaysFromNow = (n) => {
	const tzoffset = (new Date()).getTimezoneOffset() * 60000;
	return new Date(new Date(Date.now() - tzoffset).setDate(new Date().getDate() + n)).toISOString().slice(0, 10);
}

export const load: PageLoad = async () => {
	let data = {};
	for (let i = 0; i <= 6; i++) {
		const dt = dateNDaysFromNow(i);
		data[dt] = await getDateGames(dt);
	}
	return data
};
