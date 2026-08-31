const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
const BATCH_SIZE = 100;

async function matcherRequest(payload) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Movie matching is not configured for this site.");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/match-import-movies`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Movies could not be matched."
    );
  }

  return data;
}

export async function matchImportRecords(records) {
  const results = [];
  const validRecords = records.filter((record) => !record.invalidReason);

  for (let index = 0; index < validRecords.length; index += BATCH_SIZE) {
    const batch = validRecords.slice(index, index + BATCH_SIZE).map((record) => ({
      clientId: record.clientId,
      title: record.title,
      year: record.year,
      imdbId: record.imdbId,
      tmdbId: record.tmdbId,
      traktId: record.traktId,
    }));
    const data = await matcherRequest({ action: "match", records: batch });

    if (!Array.isArray(data.results)) {
      throw new Error("The movie matcher returned invalid data.");
    }
    results.push(...data.results);
  }

  const byClientId = new Map(results.map((result) => [result.clientId, result]));
  return records.map((record) => {
    if (record.invalidReason) return { ...record, status: "invalid" };
    const result = byClientId.get(record.clientId);
    return result
      ? {
          ...record,
          ...result,
          selectedTmdbId: result.status === "matched" ? result.match?.tmdbId : null,
        }
      : {
          ...record,
          status: "unmatched",
          match: null,
          candidates: [],
          reason: "No match result was returned.",
          selectedTmdbId: null,
        };
  });
}

export async function searchImportMovie(title, year = null) {
  const data = await matcherRequest({ action: "search", title, year });
  return Array.isArray(data.candidates) ? data.candidates : [];
}
