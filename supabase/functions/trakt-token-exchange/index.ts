import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type TokenAction = "exchange" | "refresh";
type JsonObject = Record<string, unknown>;

type TraktToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  created_at: number;
};

const TRAKT_TOKEN_ENDPOINT = "https://api.trakt.tv/oauth/token";
const MAX_CREDENTIAL_LENGTH = 4096;

function configuredRedirectUris(): Set<string> {
  const values = [
    Deno.env.get("TRAKT_REDIRECT_URI") ?? "",
    ...(Deno.env.get("TRAKT_REDIRECT_URIS") ?? "").split(","),
  ];

  return new Set(
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

function allowedOrigins(redirectUris: Set<string>): Set<string> {
  const origins = new Set<string>();

  for (const redirectUri of redirectUris) {
    try {
      origins.add(new URL(redirectUri).origin);
    } catch {
      console.error(
        `[trakt-token-exchange] Ignoring invalid configured redirect URI: ${redirectUri}`
      );
    }
  }

  return origins;
}

function corsHeaders(
  origin: string | null,
  permittedOrigins: Set<string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };

  if (origin && permittedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readCredential(
  value: unknown
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const credential = value.trim();

  if (
    credential.length === 0 ||
    credential.length > MAX_CREDENTIAL_LENGTH
  ) {
    return null;
  }

  return credential;
}

function normaliseTokenResponse(value: unknown): TraktToken | null {
  if (!isJsonObject(value)) {
    return null;
  }

  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length === 0
  ) {
    return null;
  }

  const expiresIn = Number(value.expires_in);
  const createdAt = Number(value.created_at);

  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    return null;
  }

  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    token_type:
      typeof value.token_type === "string" && value.token_type.length > 0
        ? value.token_type
        : "bearer",
    expires_in: expiresIn,
    scope:
      typeof value.scope === "string" && value.scope.length > 0
        ? value.scope
        : "public",
    created_at: createdAt,
  };
}

function traktErrorResponse(
  action: TokenAction,
  status: number,
  headers: Record<string, string>
): Response {
  if (status === 429) {
    return jsonResponse(
      { error: "Trakt is temporarily limiting requests. Please try again." },
      429,
      headers
    );
  }

  if (status >= 500) {
    return jsonResponse(
      { error: "Trakt is temporarily unavailable. Please try again." },
      502,
      headers
    );
  }

  if (action === "refresh") {
    return jsonResponse(
      { error: "Your Trakt connection has expired. Please reconnect." },
      401,
      headers
    );
  }

  return jsonResponse(
    { error: "Trakt rejected the connection. Please try connecting again." },
    400,
    headers
  );
}

Deno.serve(async (request: Request) => {
  const redirectUris = configuredRedirectUris();
  const permittedOrigins = allowedOrigins(redirectUris);
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin, permittedOrigins);

  if (request.method === "OPTIONS") {
    if (origin && !permittedOrigins.has(origin)) {
      return jsonResponse({ error: "Origin not allowed." }, 403, headers);
    }

    return new Response(null, {
      status: 204,
      headers,
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
      headers
    );
  }

  if (origin && !permittedOrigins.has(origin)) {
    return jsonResponse(
      { error: "Origin not allowed." },
      403,
      headers
    );
  }

  const clientId = Deno.env.get("TRAKT_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("TRAKT_CLIENT_SECRET")?.trim();

  if (
    !clientId ||
    !clientSecret ||
    redirectUris.size === 0 ||
    permittedOrigins.size === 0
  ) {
    console.error(
      "[trakt-token-exchange] Missing or invalid Trakt configuration."
    );

    return jsonResponse(
      { error: "Trakt is not configured for this site yet." },
      503,
      headers
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "The request body must be valid JSON." },
      400,
      headers
    );
  }

  if (!isJsonObject(body)) {
    return jsonResponse(
      { error: "Invalid request body." },
      400,
      headers
    );
  }

  if (body.action !== "exchange" && body.action !== "refresh") {
    return jsonResponse(
      { error: 'Action must be either "exchange" or "refresh".' },
      400,
      headers
    );
  }

  const action: TokenAction = body.action;

  if (
    typeof body.redirect_uri !== "string" ||
    !redirectUris.has(body.redirect_uri)
  ) {
    return jsonResponse(
      { error: "Redirect address not allowed." },
      400,
      headers
    );
  }

  const redirectUri = body.redirect_uri;

  const credential =
    action === "exchange"
      ? readCredential(body.code)
      : readCredential(body.refresh_token);

  if (!credential) {
    return jsonResponse(
      {
        error:
          action === "exchange"
            ? "Missing authorization code."
            : "Missing refresh token.",
      },
      400,
      headers
    );
  }

  const tokenRequest: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type:
      action === "exchange"
        ? "authorization_code"
        : "refresh_token",
  };

  if (action === "exchange") {
    tokenRequest.code = credential;
  } else {
    tokenRequest.refresh_token = credential;
  }

  let traktResponse: Response;

  try {
    traktResponse = await fetch(TRAKT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tokenRequest),
    });
  } catch (error) {
    console.error(
      "[trakt-token-exchange] Trakt request failed:",
      error instanceof Error ? error.message : String(error)
    );

    return jsonResponse(
      { error: "Trakt could not be reached. Please try again." },
      502,
      headers
    );
  }

  if (!traktResponse.ok) {
    console.error(
      `[trakt-token-exchange] Trakt returned HTTP ${traktResponse.status} for ${action}.`
    );

    return traktErrorResponse(
      action,
      traktResponse.status,
      headers
    );
  }

  let traktData: unknown;

  try {
    traktData = await traktResponse.json();
  } catch {
    return jsonResponse(
      { error: "Trakt returned an invalid response." },
      502,
      headers
    );
  }

  const token = normaliseTokenResponse(traktData);

  if (!token) {
    console.error(
      "[trakt-token-exchange] Trakt returned an incomplete token response."
    );

    return jsonResponse(
      { error: "Trakt returned an invalid response." },
      502,
      headers
    );
  }

  return jsonResponse(token, 200, headers);
});