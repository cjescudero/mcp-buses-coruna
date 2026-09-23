// Stop names mix Spanish and Galician, accents and abbreviations ("Pza.",
// "Av.", "Rda."). Both the server and the widget match queries through this
// module so that "plaza de pontevedra" finds "Pza. de Pontevedra, 8" and
// "marina" finds "Av. da Mariña".

const EQUIVALENT_WORDS: ReadonlyArray<readonly string[]> = [
  ["avenida", "av", "avda"],
  ["praza", "plaza", "pza"],
  ["ronda", "rolda", "rda"],
  ["glorieta", "glor"],
  ["estrada", "carretera", "carret"],
  ["edificio", "edif"],
  ["urbanizacion", "urb"],
];

const CANONICAL_WORD = new Map<string, string>(
  EQUIVALENT_WORDS.flatMap((group) => group.map((word) => [word, group[0]] as const)),
);

// Articles and prepositions that change between the Spanish and Galician
// spellings of the same stop ("de"/"da", "y"/"e") or are simply omitted.
const IGNORED_QUERY_WORDS = new Set([
  "de", "da", "do", "das", "dos", "del",
  "a", "o", "os", "as", "el", "la", "los", "las",
  "y", "e",
]);

function normalizeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => CANONICAL_WORD.get(word) ?? word);
}

/**
 * Returns a predicate that tells whether a stop matches the query. Every
 * significant word of the query must appear inside some word of the stop
 * name, ignoring case, accents and the abbreviations listed above. A query
 * that contains the stop id also matches, as before.
 */
export function createStopMatcher(query: string): (stop: { id: number; name: string }) => boolean {
  const trimmed = query.trim();
  const words = normalizeWords(trimmed);
  const significant = words.filter((word) => !IGNORED_QUERY_WORDS.has(word));
  const required = significant.length > 0 ? significant : words;

  return (stop) => {
    if (String(stop.id).includes(trimmed)) {
      return true;
    }
    if (required.length === 0) {
      return false;
    }
    const nameWords = normalizeWords(stop.name);
    return required.every((queryWord) => nameWords.some((nameWord) => nameWord.includes(queryWord)));
  };
}
