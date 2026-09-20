export const FORMAT_OPTIONS = Object.freeze([
  { value: "16mm", label: "16mm" },
  { value: "35mm", label: "35mm" },
  { value: "70mm", label: "70mm" },
  { value: "imax", label: "IMAX" },
  { value: "4k", label: "4K" },
  { value: "3d", label: "3D" },
  { value: "dolby_cinema", label: "Dolby Cinema" },
  { value: "vhs", label: "VHS" },
]);

export const ACCESSIBILITY_OPTIONS = Object.freeze([
  { value: "captioned", label: "Captioned" },
  { value: "audio_described", label: "Audio described" },
  { value: "relaxed", label: "Relaxed" },
]);

export const PROGRAMME_OPTIONS = Object.freeze([
  { value: "parent_and_baby", label: "Parent & baby" },
  { value: "members_only", label: "Members only" },
  { value: "seniors", label: "Seniors" },
  { value: "child_required", label: "Child required" },
]);

const HEADLINE_TAG_OPTIONS = Object.freeze([
  { value: "q_and_a", label: "Q&A" },
  { value: "introduction", label: "Introduction" },
  { value: "discussion", label: "Discussion" },
  { value: "preview", label: "Preview" },
  { value: "premiere", label: "Premiere" },
  { value: "live_music", label: "Live music" },
  { value: "singalong", label: "Sing-along" },
  { value: "double_bill", label: "Double bill" },
  { value: "anniversary", label: "Anniversary" },
  { value: "restoration", label: "Restoration" },
]);

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function addStructuredFormat(value, found) {
  const normalised = String(value ?? "").trim().toLowerCase();

  if (/^16\s*mm$/.test(normalised)) found.add("16mm");
  if (/^35\s*mm$/.test(normalised)) found.add("35mm");
  if (/^70\s*mm$/.test(normalised)) found.add("70mm");
  if (normalised === "imax") found.add("imax");
  if (normalised === "4k") found.add("4k");
  if (normalised === "3d") found.add("3d");
  if (normalised === "dolby cinema") found.add("dolby_cinema");
  if (normalised === "vhs") found.add("vhs");
}

function legacyFormatText(screening) {
  return typeof screening?.format === "string" ? screening.format.trim() : "";
}

function hasAmbiguous35mmDcp(screening) {
  return /\b35\s*mm\s*\/\s*dcp\b/i.test(legacyFormatText(screening));
}

export function getScreeningFormatValues(screening = {}) {
  const found = new Set();

  for (const value of stringArray(screening.projection_formats)) {
    addStructuredFormat(value, found);
  }

  const legacy = legacyFormatText(screening);

  if (legacy) {
    if (/\b16\s*mm\b/i.test(legacy)) found.add("16mm");
    if (!hasAmbiguous35mmDcp(screening) && /\b35\s*mm\b/i.test(legacy)) {
      found.add("35mm");
    }
    if (/\b70\s*mm\b/i.test(legacy)) found.add("70mm");
    if (/\bimax\b/i.test(legacy)) found.add("imax");
    if (/\b4\s*k\b/i.test(legacy)) found.add("4k");
    if (/\b3\s*d\b/i.test(legacy)) found.add("3d");
    if (/\bdolby\s+cinema\b/i.test(legacy)) found.add("dolby_cinema");
    if (/\bvhs\b/i.test(legacy)) found.add("vhs");
  }

  return FORMAT_OPTIONS.map((option) => option.value).filter((value) =>
    found.has(value)
  );
}

function getFormatChips(screening) {
  const values = new Set(getScreeningFormatValues(screening));
  const chips = [];
  const ambiguous35mmDcp = hasAmbiguous35mmDcp(screening) && !values.has("35mm");

  for (const option of FORMAT_OPTIONS) {
    if (option.value === "35mm" && ambiguous35mmDcp) {
      chips.push({
        key: "format:35mm-dcp",
        label: "35mm / DCP",
        kind: "format",
      });
    }

    if (values.has(option.value)) {
      chips.push({
        key: `format:${option.value}`,
        label: option.label,
        kind: "format",
      });
    }
  }

  return chips;
}

function chipsFromKnownValues(values, options, kind) {
  const selected = new Set(stringArray(values));

  return options
    .filter((option) => selected.has(option.value))
    .map((option) => ({
      key: `${kind}:${option.value}`,
      label: option.label,
      kind,
    }));
}

export function getScreeningDisplayChips(screening = {}) {
  return [
    ...getFormatChips(screening),
    ...chipsFromKnownValues(
      screening.accessibility_features,
      ACCESSIBILITY_OPTIONS,
      "accessibility"
    ),
    ...chipsFromKnownValues(
      screening.programme_types,
      PROGRAMME_OPTIONS,
      "programme"
    ),
    ...chipsFromKnownValues(screening.screening_tags, HEADLINE_TAG_OPTIONS, "tag"),
  ];
}
