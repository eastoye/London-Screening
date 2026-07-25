import { supabase, SUPABASE_CONFIGURED } from "./supabaseClient.js";

const PAGE_SIZE = 500;

// Fetch every active, future screening ordered by start_time ascending.
// Supabase caps per-request rows, so we paginate until the final page.
export async function fetchAllUpcomingScreenings() {
  if (!SUPABASE_CONFIGURED) {
    throw new Error(
      "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const nowIso = new Date().toISOString();
  const all = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("screenings")
      .select(
        "id, cinema_name, movie_title, start_time, booking_url, format, sold_out, movie_id, movies!movie_id(normalised_title, display_title, poster_path, match_status, tmdb_id)"
      )
      .eq("active", true)
      .gt("start_time", nowIso)
      .order("start_time", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(
        `Supabase query failed: ${error.message} (code ${error.code ?? "?"})`
      );
    }

    if (!data || data.length === 0) break;

    all.push(...data);

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}