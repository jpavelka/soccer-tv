// Canonical broadcaster registry.
//
// ESPN and livesoccertv name the same channels differently ("FS1" vs
// "Fox Sports 1", "Telemundo" vs "Telemundo Deportes En Vivo"), so the raw
// strings from both sources are funneled through `canonicalBcst` before they
// reach any store or the picker. Edits to the merge behavior live entirely in
// this table — mirroring the curated `crosswalk_overrides.json` approach.
//
// `aliases` merges only true equivalents; genuinely different channels (FOX vs
// FS1 vs FOX One) stay distinct. `hidden` flags low-value / noise sources that
// the picker collapses behind a "show more".
interface BroadcasterDef {
    canonical: string;
    aliases: string[];
    hidden?: boolean;
}

const REGISTRY: BroadcasterDef[] = [
    // Fox family — each surface is a distinct channel.
    { canonical: 'FOX', aliases: ['FOX', 'FOX Network'] },
    { canonical: 'FS1', aliases: ['FS1', 'Fox Sports 1'] },
    { canonical: 'FS2', aliases: ['FS2', 'Fox Sports 2'] },
    { canonical: 'FOX Deportes', aliases: ['FOX Deportes', 'Fox Deportes'] },
    { canonical: 'FOX One', aliases: ['FOX One'] },
    { canonical: 'Foxsports.com', aliases: ['Foxsports.com'], hidden: true },

    // ESPN / Disney. ESPN App and ESPN Select are ESPN+ streaming surfaces.
    { canonical: 'ESPN', aliases: ['ESPN'] },
    { canonical: 'ESPN2', aliases: ['ESPN2'] },
    { canonical: 'ESPN Deportes', aliases: ['ESPN Deportes'] },
    { canonical: 'ESPN+', aliases: ['ESPN+', 'ESPN Plus', 'ESPN App', 'ESPN Select'] },

    // NBC / Telemundo.
    { canonical: 'NBC', aliases: ['NBC'] },
    { canonical: 'NBCSN', aliases: ['NBCSN', 'NBC Sports Network'] },
    { canonical: 'USA', aliases: ['USA', 'USA Network'] },
    { canonical: 'Peacock', aliases: ['Peacock'] },
    { canonical: 'Telemundo', aliases: ['Telemundo', 'Telemundo Deportes En Vivo', 'Tele'] },
    { canonical: 'Universo', aliases: ['UNIVERSO', 'Universo'] },

    // CBS / Paramount.
    { canonical: 'CBS', aliases: ['CBS'] },
    { canonical: 'CBSSN', aliases: ['CBS Sports Network', 'CBSSN'] },
    { canonical: 'CBS Sports Golazo', aliases: ['CBS Sports Golazo', 'Golazo Network'] },
    { canonical: 'Paramount+', aliases: ['Paramount+', 'Paramount Plus'] },
    { canonical: 'TNT', aliases: ['TNT', 'TNT USA']},

    // Streaming / other.
    { canonical: 'DAZN', aliases: ['DAZN', 'DAZN USA'] },
    { canonical: 'fuboTV', aliases: ['fuboTV', 'Fubo'] },
    { canonical: 'MSG', aliases: ['MSG'] },
    { canonical: 'Prime Video', aliases: ['Prime Video', 'Amazon Prime Video']},
    { canonical: 'TUDN', aliases: ['TUDN', 'TUDN USA']},
    { canonical: 'ION', aliases: ['ION', 'ion']},

    // Noise — low-tier / amateur streaming surfaces.
    { canonical: 'SportsEngine Play', aliases: ['SportsEngine Play'], hidden: true },
    { canonical: 'Premiere', aliases: ['Premiere'], hidden: true },
];

const ALIAS_TO_CANONICAL = new Map<string, string>();
const HIDDEN = new Set<string>();
for (const def of REGISTRY) {
    for (const alias of def.aliases) {
        ALIAS_TO_CANONICAL.set(alias.toLowerCase(), def.canonical);
    }
    if (def.hidden) HIDDEN.add(def.canonical);
}

// Map a raw source channel name to its canonical display name. Unknown channels
// pass through (trimmed) and are never treated as hidden.
export function canonicalBcst(raw: string): string {
    const trimmed = (raw ?? '').trim();
    return ALIAS_TO_CANONICAL.get(trimmed.toLowerCase()) ?? trimmed;
}

// Whether a canonical name is a low-value / noise source the picker collapses.
export function isHiddenBcst(canonical: string): boolean {
    return HIDDEN.has(canonical);
}
