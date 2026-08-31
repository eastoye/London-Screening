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

const CINEMA_NAME = "Lumiere Romford";
const LOCATION_ID = "4";
const LOCATION_SLUG = "romford";
const WIDGET_ID = "movie_calendar";
const SITE_ORIGIN = "https://www.lumiereromford.com";
const EXTERNAL_URL = `${SITE_ORIGIN}/api/external`;
const SOURCE_PREFIX = "lumiere-romford";

// This passphrase is shipped publicly in Lumiere/CineSync's browser JavaScript.
// It is only used to format requests to their public website proxy.
const CINESYNC_PASSPHRASE =
  "ascvdWD34_GKIbnDVBONKE23GZLpMgA34567890";

const MIN_SCREENINGS = 8;
const RATIO_GUARD_MIN_EXISTING = 15;
const MIN_EXPECTED_RATIO = 0.5;
const MAX_PROGRAMME_DATES = 45;
const LIST_CONCURRENCY = 6;

type Tag = {
  name?: string | null;
  short_name?: string | null;
  description?: string | null;
};

type Showtime = {
  show_time_id?: string;
  show_time_uuid?: string;
  page_link?: string;
  session_start_date?: string;
  show_time_hours?: string;
  time_sorting?: number | string;
  sold_out?: boolean;
  screen_name?: string;
  screen_tags?: Tag[];
  show_times_tags?: Tag[];
  member_only?: boolean;
  seat_plan_status?: string;
  theater_experience_name?: string;
  is_this_sold_by_third_party_system?: string;
  third_party_system_url?: string;
};

type Movie = {
  type?: string;
  movie_name?: string;
  url_key?: string;
  is_booking_open?: boolean;
  movie_tags?: Tag[];
  show_times?: Showtime[];
};

type Parsed = {
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
  return CryptoJS.AES.encrypt(
    JSON.stringify({
      endpoint: "cms_widget/index",
      method: "POST",
      data,
      headers: {},
      langId: "",
    }),
    CINESYNC_PASSPHRASE,
  ).toString();
}

async function cineSync(data: unknown): Promise<any> {
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
      `Lumiere CineSync proxy returned HTTP ${response.status}`,
    );
  }

  const payload = await response.json();

  if (payload?.status !== true || !payload?.data) {
    throw new Error(
      `Invalid Lumiere CineSync response: ${
        JSON.stringify(payload).slice(0, 400)
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

function startTime(
  show: Showtime,
): string | null {
  const epoch = Number(show.time_sorting);

  if (
    Number.isFinite(epoch) &&
    epoch > 1_000_000_000
  ) {
    return new Date(epoch * 1000).toISOString();
  }

  const d = show.session_start_date?.match(
    /^(\d{4})-(\d{2})-(\d{2})$/,
  );
  const t = show.show_time_hours?.match(
    /^(\d{1,2})[.:](\d{2})$/,
  );

  if (!d || !t) return null;

  return londonToUtc(
    Number(d[1]),
    Number(d[2]),
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  ).toISOString();
}

function isNamedNonFilmEvent(title: string): boolean {
  return /^(?:NT\s*Live|National Theatre Live|Royal Ballet|Royal Opera|ROH Live|Met Opera)\b/i.test(title)
    || /\bFilm Quiz\b/i.test(title)
    || /\bFilm Festival\b/i.test(title);
}

function labels(
  movie: Movie,
  show: Showtime,
): string[] {
  const all = [
    ...(movie.movie_tags ?? []),
    ...(show.screen_tags ?? []),
    ...(show.show_times_tags ?? []),
  ];

  const values = all.flatMap((tag) => [
    tag.name,
    tag.short_name,
    tag.description,
  ]);

  if (show.theater_experience_name) {
    values.push(show.theater_experience_name);
  }

  return values.filter(
    (v): v is string =>
      Boolean(v && v.trim()),
  );
}

function metadata(
  movie: Movie,
  show: Showtime,
) {
  const l = labels(movie, show);
  const joined = l.join(" | ");

  const projection_formats =
    normaliseProjectionFormats(l);

  const accessibility_features:
    AccessibilityFeature[] = [];

  const programme_types:
    ProgrammeType[] = [];

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
        (v): v is string =>
          Boolean(v && v.trim()),
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
  movie: Movie,
  show: Showtime,
): string | null {
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
  movies: Movie[],
): Parsed[] {
  const found =
    new Map<string, Parsed>();

  for (const movie of movies) {
    if (
      movie.type &&
      movie.type !== "movie"
    ) {
      continue;
    }

    const title =
      movie.movie_name?.trim();

    if (!title || isNamedNonFilmEvent(title)) continue;

    for (
      const show of
        movie.show_times ?? []
    ) {
      // Lumiere uses third-party URLs for mixed events, classes, quizzes,
      // festival passes and private screenings whose listed time may be doors/event start.
      // Exclude them rather than importing an uncertain movie start time.
      if (show.is_this_sold_by_third_party_system === "1") continue;
      const id =
        show.show_time_uuid?.trim() ||
        show.show_time_id?.trim();

      const start =
        startTime(show);

      if (!id || !start) continue;

      const ref =
        `${SOURCE_PREFIX}:showtime:${id}`;

      const sold_out =
        show.sold_out === true;

      const url =
        bookingUrl(movie, show);

      const m =
        metadata(movie, show);

      const availability_status:
        AvailabilityStatus =
          sold_out
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
        sold_out,
        projection_formats:
          m.projection_formats,
        accessibility_features:
          m.accessibility_features,
        programme_types:
          m.programme_types,
        availability_status,
        display_format:
          m.display_format,
      });
    }
  }

  return [...found.values()];
}

async function loadProgramme(): Promise<{
  dates: string[];
  screenings: Parsed[];
}> {
  const dateData =
    await cineSync({
      api: "dates",
      sales_channel_id: 1,
      cinema_location_id:
        LOCATION_ID,
      page_number: "1",
      url_key: "",
      widget_id: WIDGET_ID,
      calendar_date_picker_option:
        "1",
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
      (value: unknown):
        value is string =>
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(
            value,
          ),
    )
    .slice(
      0,
      MAX_PROGRAMME_DATES,
    );

  if (dates.length === 0) {
    throw new Error(
      "Lumiere CineSync returned no programme dates.",
    );
  }

  const movies: Movie[] = [];

  for (
    let i = 0;
    i < dates.length;
    i += LIST_CONCURRENCY
  ) {
    const batch = dates.slice(
      i,
      i + LIST_CONCURRENCY,
    );

    const results =
      await Promise.all(
        batch.map(
          (session_date) =>
            cineSync({
              sales_channel_id: 1,
              cinema_location_id:
                LOCATION_ID,
              widget_id:
                WIDGET_ID,
              api: "list",
              session_date,
              has_limit: 0,
              per_page: 100,
              page_number: 1,
              url_key: "",
              theater_experiance: "",
              group_to_theater_experiance:
                false,
              sort_by: "showtime",
            }),
        ),
      );

    for (const data of results) {
      if (
        Array.isArray(data?.movies)
      ) {
        movies.push(
          ...data.movies,
        );
      }
    }
  }

  return {
    dates,
    screenings:
      parseMovies(movies),
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
        {
          count: "exact",
          head: true,
        },
      )
      .eq(
        "cinema_name",
        CINEMA_NAME,
      )
      .eq("active", true)
      .gt(
        "start_time",
        nowUtc.toISOString(),
      );

  if (error) {
    throw new Error(
      `Could not read previous Lumiere screening count: ${error.message}`,
    );
  }

  return count ?? 0;
}

Deno.serve(
  async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(
        null,
        {
          status: 200,
          headers:
            corsHeaders,
        },
      );
    }

    const startedAt =
      new Date();

    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    if (
      !supabaseUrl ||
      !serviceRoleKey
    ) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing Supabase credentials.",
        },
        500,
      );
    }

    const supabase =
      createClient(
        supabaseUrl,
        serviceRoleKey,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        },
      );

    const ctx:
      ImportRunContext = {
        supabase,
        cinemaName:
          CINEMA_NAME,
        minScreenings:
          MIN_SCREENINGS,
        startedAt,
      };

    const runStart =
      await startRun(ctx);

    if (runStart.blocked) {
      return jsonResponse(
        {
          success: false,
          blocked: true,
          error:
            "Import already running.",
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

    const runId =
      runStart.runId;

    try {
      const nowUtc =
        new Date();

      const programme =
        await loadProgramme();

      const future =
        programme.screenings
          .filter(
            (screening) =>
              new Date(
                screening
                  .start_time_iso,
              ) > nowUtc,
          )
          .sort((a, b) =>
            a.start_time_iso
              .localeCompare(
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
        future.length <
          MIN_SCREENINGS
      ) {
        throw new Error(
          `Unusually low screening count (${future.length}); database left untouched.`,
        );
      }

      const records =
        future.map(
          (screening) => ({
            cinema_name:
              CINEMA_NAME,
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
              new Date()
                .toISOString(),
          }),
        ) as ScreeningRecord[];

      const {
        saved,
        errors,
      } =
        await commitImport(
          ctx,
          records,
          nowUtc,
        );

      if (
        errors.length > 0
      ) {
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
        source:
          "official-cinesync-api",
        programme_dates:
          programme.dates,
        screenings_found:
          future.length,
        screenings_saved:
          saved,
        previous_active:
          previous,
        screenings:
          future.map(
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
          cinema:
            CINEMA_NAME,
          error: message,
        },
        500,
      );
    }
  },
);
