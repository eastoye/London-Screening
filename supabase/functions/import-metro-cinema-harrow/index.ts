import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import CryptoJS from "npm:crypto-js@4.2.0";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  normaliseProjectionFormats,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
} from "../_shared/screeningMetadata.ts";

const CINEMA_NAME = "Metro Cinema";
const LOCATION_ID = "4";
const LOCATION_SLUG = "metro-cinema";
const WIDGET_ID = "movie_calendar";
const EXTERNAL_URL = "https://www.metrocinema.co.uk/api/external";
const SITE_ORIGIN = "https://www.metrocinema.co.uk";
const SOURCE_PREFIX = "metro-cinema";

// This passphrase is shipped publicly in Metro/CineSync's browser JavaScript.
// It is only used to format requests to their public website proxy.
const CINESYNC_PASSPHRASE =
  "ascvdWD34_GKIbnDVBONKE23GZLpMgA34567890";

const MIN_SCREENINGS = 5;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const MAX_PROGRAMME_DATES = 45;
const LIST_CONCURRENCY = 6;

type Tag = {
  id?: string | number;
  name?: string | null;
  short_name?: string | null;
  description?: string | null;
};

type CineSyncShowtime = {
  show_time_id?: string;
  show_time_uuid?: string;
  page_link?: string;
  session_start_date?: string;
  show_time_slots?: string;
  show_time_hours?: string;
  time_sorting?: number | string;
  sold_out?: boolean;
  sold_out_text?: string;
  screen_name?: string;
  screen_tags?: Tag[];
  show_times_tags?: Tag[];
  member_only?: boolean;
  seat_plan_status?: string;
  theater_experience_name?: string;
  is_this_sold_by_third_party_system?: string;
  third_party_system_url?: string;
};

type CineSyncMovie = {
  movie_id?: string;
  type?: string;
  movie_name?: string;
  url_key?: string;
  is_booking_open?: boolean;
  movie_tags?: Tag[];
  show_times?: CineSyncShowtime[];
};

type ParsedScreening = {
  movie_title: string;
  start_time_iso: string;
  booking_url: string | null;
  source_reference: string;
  sold_out: boolean;
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
  display_format: string | null;
};

function encryptPayload(data: unknown): string {
  const envelope = {
    endpoint: "cms_widget/index",
    method: "POST",
    data,
    headers: {},
    langId: "",
  };

  return CryptoJS.AES.encrypt(
    JSON.stringify(envelope),
    CINESYNC_PASSPHRASE,
  ).toString();
}

async function cineSyncRequest(data: unknown): Promise<any> {
  const response = await fetch(EXTERNAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; London-Screenings/1.0)",
    },
    body: JSON.stringify({
      payload: encryptPayload(data),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Metro CineSync proxy returned HTTP ${response.status}`,
    );
  }

  const payload = await response.json();

  if (payload?.status !== true || !payload?.data) {
    throw new Error(
      `Metro CineSync returned an invalid response: ${
        JSON.stringify(payload).slice(0, 500)
      }`,
    );
  }

  return payload.data;
}

function absoluteUrl(
  value?: string | null,
): string | null {
  if (!value) return null;

  try {
    return new URL(value, SITE_ORIGIN).toString();
  } catch {
    return null;
  }
}

function parseFallbackTime(
  show: CineSyncShowtime,
): string | null {
  const date = show.session_start_date?.match(
    /^(\d{4})-(\d{2})-(\d{2})$/,
  );
  const time = show.show_time_hours?.match(
    /^(\d{1,2})[.:](\d{2})$/,
  );

  if (!date || !time) return null;

  return londonToUtc(
    Number(date[1]),
    Number(date[2]),
    Number(date[3]),
    Number(time[1]),
    Number(time[2]),
  ).toISOString();
}

function startTime(
  show: CineSyncShowtime,
): string | null {
  const epoch = Number(show.time_sorting);

  if (
    Number.isFinite(epoch) &&
    epoch > 1_000_000_000
  ) {
    return new Date(epoch * 1000).toISOString();
  }

  return parseFallbackTime(show);
}

function explicitLabels(
  movie: CineSyncMovie,
  show: CineSyncShowtime,
): string[] {
  const tags = [
    ...(movie.movie_tags ?? []),
    ...(show.screen_tags ?? []),
    ...(show.show_times_tags ?? []),
  ];

  const values = tags.flatMap((tag) => [
    tag.name,
    tag.short_name,
    tag.description,
  ]);

  if (show.theater_experience_name) {
    values.push(show.theater_experience_name);
  }

  return values.filter(
    (value): value is string =>
      Boolean(value && value.trim()),
  );
}

function metadata(
  movie: CineSyncMovie,
  show: CineSyncShowtime,
) {
  const labels = explicitLabels(movie, show);
  const joined = labels.join(" | ");

  const projection_formats =
    normaliseProjectionFormats(labels);

  const accessibility_features:
    AccessibilityFeature[] = [];

  const programme_types: ProgrammeType[] = [];

  // Do not classify ordinary translated subtitles
  // (for example "English Subs") as accessibility captions.
  if (
    /\b(?:captioned|HOH|hard of hearing|SDH)\b/i.test(
      joined,
    )
  ) {
    accessibility_features.push("captioned");
  }

  if (
    /\b(?:audio described|audio description)\b/i.test(
      joined,
    )
  ) {
    accessibility_features.push("audio_described");
  }

  if (/\brelaxed\b/i.test(joined)) {
    accessibility_features.push("relaxed");
  }

  if (
    show.member_only === true ||
    /\bmembers? only\b/i.test(joined)
  ) {
    programme_types.push("members_only");
  }

  if (
    /\bparent\s*(?:&|and)\s*baby\b/i.test(joined)
  ) {
    programme_types.push("parent_and_baby");
  }

  if (/\bchild required\b/i.test(joined)) {
    programme_types.push("child_required");
  }

  if (
    /\b(?:senior|silver screening)\b/i.test(joined)
  ) {
    programme_types.push("seniors");
  }

  const display = [
    ...new Set(
      [
        show.theater_experience_name,
        ...(show.screen_tags ?? []).map(
          (tag) => tag.name,
        ),
        ...(show.show_times_tags ?? []).map(
          (tag) => tag.name,
        ),
      ].filter(
        (value): value is string =>
          Boolean(value && value.trim()),
      ),
    ),
  ];

  return {
    projection_formats,
    accessibility_features,
    programme_types,
    display_format:
      display.length > 0
        ? display.join(", ")
        : null,
  };
}

function bookingUrl(
  movie: CineSyncMovie,
  show: CineSyncShowtime,
): string | null {
  if (
    show.is_this_sold_by_third_party_system === "1"
  ) {
    return absoluteUrl(
      show.third_party_system_url,
    );
  }

  if (
    show.is_this_sold_by_third_party_system === "0"
  ) {
    return null;
  }

  const direct = absoluteUrl(show.page_link);

  if (direct) return direct;

  if (
    !show.show_time_uuid ||
    !movie.url_key ||
    !show.session_start_date
  ) {
    return null;
  }

  const step =
    show.seat_plan_status === "1"
      ? "seat-plan"
      : "select-tickets";

  return (
    `${SITE_ORIGIN}/movies/` +
    `${encodeURIComponent(movie.url_key)}/showtimes/` +
    `${show.session_start_date}/${LOCATION_SLUG}/${step}` +
    `?showtime=${encodeURIComponent(show.show_time_uuid)}`
  );
}

function parseMovies(
  movies: CineSyncMovie[],
): ParsedScreening[] {
  const found =
    new Map<string, ParsedScreening>();

  for (const movie of movies) {
    if (
      movie.type &&
      movie.type !== "movie"
    ) {
      continue;
    }

    const title = movie.movie_name?.trim();

    if (!title) continue;

    for (const show of movie.show_times ?? []) {
      const id =
        show.show_time_uuid?.trim() ||
        show.show_time_id?.trim();

      const start = startTime(show);

      if (!id || !start) continue;

      const ref =
        `${SOURCE_PREFIX}:showtime:${id}`;

      const soldOut =
        show.sold_out === true;

      const url = bookingUrl(movie, show);
      const meta = metadata(movie, show);

      const availability_status:
        AvailabilityStatus = soldOut
          ? "sold_out"
          : movie.is_booking_open === true &&
              Boolean(url)
          ? "available"
          : "unknown";

      found.set(ref, {
        movie_title: title,
        start_time_iso: start,
        booking_url: url,
        source_reference: ref,
        sold_out: soldOut,
        projection_formats:
          meta.projection_formats,
        accessibility_features:
          meta.accessibility_features,
        programme_types:
          meta.programme_types,
        availability_status,
        display_format:
          meta.display_format,
      });
    }
  }

  return [...found.values()];
}

async function loadProgramme(): Promise<{
  dates: string[];
  screenings: ParsedScreening[];
}> {
  const dateData = await cineSyncRequest({
    api: "dates",
    sales_channel_id: 1,
    cinema_location_id: LOCATION_ID,
    page_number: "1",
    url_key: "",
    widget_id: WIDGET_ID,
    calendar_date_picker_option: "1",
  });

  const dates = (
    Array.isArray(dateData?.dates)
      ? dateData.dates
      : []
  )
    .map(
      (item: any) =>
        item?.session_start_date,
    )
    .filter(
      (value: unknown): value is string =>
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value),
    )
    .slice(0, MAX_PROGRAMME_DATES);

  if (dates.length === 0) {
    throw new Error(
      "Metro CineSync returned no programme dates.",
    );
  }

  const allMovies: CineSyncMovie[] = [];

  for (
    let i = 0;
    i < dates.length;
    i += LIST_CONCURRENCY
  ) {
    const batch = dates.slice(
      i,
      i + LIST_CONCURRENCY,
    );

    const results = await Promise.all(
      batch.map((sessionDate) =>
        cineSyncRequest({
          sales_channel_id: 1,
          cinema_location_id: LOCATION_ID,
          widget_id: WIDGET_ID,
          api: "list",
          session_date: sessionDate,
          has_limit: 0,
          per_page: 100,
          page_number: 1,
          url_key: "",
          theater_experiance: "",
          group_to_theater_experiance:
            false,
          sort_by: "showtime",
        })
      ),
    );

    for (const data of results) {
      if (Array.isArray(data?.movies)) {
        allMovies.push(...data.movies);
      }
    }
  }

  return {
    dates,
    screenings: parseMovies(allMovies),
  };
}

async function previousActiveCount(
  ctx: ImportRunContext,
  nowUtc: Date,
): Promise<number> {
  const { count, error } =
    await ctx.supabase
      .from("screenings")
      .select(
        "id",
        { count: "exact", head: true },
      )
      .eq("cinema_name", CINEMA_NAME)
      .eq("active", true)
      .gt(
        "start_time",
        nowUtc.toISOString(),
      );

  if (error) {
    throw new Error(
      `Could not read previous Metro screening count: ${error.message}`,
    );
  }

  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(
      null,
      {
        status: 200,
        headers: corsHeaders,
      },
    );
  }

  const startedAt = new Date();

  const supabaseUrl =
    Deno.env.get("SUPABASE_URL");

  const serviceRoleKey =
    Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    );

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      {
        success: false,
        error:
          "Missing Supabase credentials.",
      },
      500,
    );
  }

  const supabase = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const ctx: ImportRunContext = {
    supabase,
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(ctx);

  if (runStart.blocked) {
    return jsonResponse(
      {
        success: false,
        blocked: true,
        error: "Import already running.",
      },
      409,
    );
  }

  if (
    runStart.error ||
    !runStart.runId
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          runStart.error ??
          "Could not start run.",
      },
      500,
    );
  }

  const runId = runStart.runId;

  try {
    const nowUtc = new Date();

    const programme =
      await loadProgramme();

    const future =
      programme.screenings
        .filter(
          (screening) =>
            new Date(
              screening.start_time_iso,
            ) > nowUtc,
        )
        .sort((a, b) =>
          a.start_time_iso.localeCompare(
            b.start_time_iso,
          )
        );

    const previous =
      await previousActiveCount(
        ctx,
        nowUtc,
      );

    if (
      previous >=
        RATIO_GUARD_MIN_EXISTING &&
      future.length <
        Math.ceil(
          previous *
            MIN_EXPECTED_RATIO,
        )
    ) {
      throw new Error(
        `Count-drop guard blocked import: ${future.length} new future screenings vs ${previous} currently active.`,
      );
    }

    if (
      future.length < MIN_SCREENINGS
    ) {
      throw new Error(
        `Unusually low screening count (${future.length}); database left untouched.`,
      );
    }

    const records =
      future.map((screening) => ({
        cinema_name: CINEMA_NAME,
        movie_title:
          screening.movie_title,
        start_time:
          screening.start_time_iso,
        booking_url:
          screening.booking_url,
        format:
          screening.display_format,
        sold_out:
          screening.sold_out,
        projection_formats:
          screening.projection_formats,
        accessibility_features:
          screening.accessibility_features,
        programme_types:
          screening.programme_types,
        availability_status:
          screening.availability_status,
        source_reference:
          screening.source_reference,
        last_seen_at:
          new Date().toISOString(),
      })) as ScreeningRecord[];

    const { saved, errors } =
      await commitImport(
        ctx,
        records,
        nowUtc,
      );

    if (errors.length > 0) {
      throw new Error(
        `Import errors: ${errors.join("; ")}`,
      );
    }

    await endRun(
      ctx,
      runId,
      "success",
      future.length,
      saved,
    );

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: "official-cinesync-api",
      programme_dates:
        programme.dates,
      screenings_found:
        future.length,
      screenings_saved: saved,
      previous_active: previous,
      screenings: future.map(
        (screening) => ({
          title:
            screening.movie_title,
          start_time:
            screening.start_time_iso,
          booking_url:
            screening.booking_url,
          sold_out:
            screening.sold_out,
          source_reference:
            screening.source_reference,
        }),
      ),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await endRun(
      ctx,
      runId,
      "failed",
      0,
      0,
      message,
    );

    return jsonResponse(
      {
        success: false,
        cinema: CINEMA_NAME,
        error: message,
      },
      500,
    );
  }
});
