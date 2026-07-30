/*
# Add structured screening metadata

The existing `format` and `sold_out` columns remain unchanged for backwards
compatibility and display. These additive fields support dependable filters
without parsing display labels in the frontend.

- `projection_formats`: explicit 35mm, 70mm and IMAX source values
- `accessibility_features`: explicit captioned, audio-described and relaxed values
- `programme_types`: explicit members-only, parent-and-baby, child-required and
  seniors values
- `availability_status`: tri-state availability so unknown is not treated as
  confirmed available
*/

ALTER TABLE public.screenings
  ADD COLUMN IF NOT EXISTS projection_formats text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS accessibility_features text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS programme_types text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.screenings
  ADD CONSTRAINT screenings_projection_formats_allowed
    CHECK (
      projection_formats
      <@ ARRAY['35mm', '70mm', 'imax']::text[]
    ),
  ADD CONSTRAINT screenings_accessibility_features_allowed
    CHECK (
      accessibility_features
      <@ ARRAY['captioned', 'audio_described', 'relaxed']::text[]
    ),
  ADD CONSTRAINT screenings_programme_types_allowed
    CHECK (
      programme_types
      <@ ARRAY[
        'members_only',
        'parent_and_baby',
        'child_required',
        'seniors'
      ]::text[]
    ),
  ADD CONSTRAINT screenings_availability_status_allowed
    CHECK (
      availability_status IN ('available', 'sold_out', 'unknown')
    );

UPDATE public.screenings
SET availability_status = 'sold_out'
WHERE sold_out = true
  AND availability_status = 'unknown';

COMMENT ON COLUMN public.screenings.projection_formats IS
  'Explicit projection formats supplied by the cinema source.';
COMMENT ON COLUMN public.screenings.accessibility_features IS
  'Explicit accessibility features supplied by the cinema source.';
COMMENT ON COLUMN public.screenings.programme_types IS
  'Explicit audience or programme types supplied by the cinema source.';
COMMENT ON COLUMN public.screenings.availability_status IS
  'Explicit availability: available, sold_out, or unknown.';