create table if not exists public.cinemas (
  name text primary key,
  latitude double precision,
  longitude double precision,
  address text,
  coordinate_source text,
  coordinate_source_url text,
  coordinates_verified_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint cinemas_coordinates_together check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  ),
  constraint cinemas_latitude_valid check (
    latitude is null or latitude between -90 and 90
  ),
  constraint cinemas_longitude_valid check (
    longitude is null or longitude between -180 and 180
  )
);

comment on table public.cinemas is
  'Canonical cinema locations used for client-side distance filtering. Names match screenings.cinema_name exactly.';
comment on column public.cinemas.latitude is
  'Cinema latitude in WGS84 decimal degrees. Null means not yet verified.';
comment on column public.cinemas.longitude is
  'Cinema longitude in WGS84 decimal degrees. Null means not yet verified.';
comment on column public.cinemas.coordinate_source is
  'Human-readable provenance for the stored coordinates.';
comment on column public.cinemas.coordinate_source_url is
  'Source record used to verify the stored coordinates.';

alter table public.cinemas enable row level security;

revoke all on table public.cinemas from anon, authenticated;
grant select on table public.cinemas to anon, authenticated;

drop policy if exists "Cinema locations are publicly readable" on public.cinemas;
create policy "Cinema locations are publicly readable"
on public.cinemas
for select
to anon, authenticated
using (true);

insert into public.cinemas (
  name,
  latitude,
  longitude,
  address,
  coordinate_source,
  coordinate_source_url,
  coordinates_verified_at
)
values
  ('ActOne Cinema', 51.5065997, -0.2684113, '119-121 High Street, Acton, London W3 6NA', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/node/9333021746', now()),
  ('ArtHouse Crouch End', 51.5818917, -0.1200548, '159A Tottenham Lane, London N8 9BT', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/12633147070', now()),
  ('Barbican Cinema', 51.5197763, -0.0937556, 'Barbican Centre, Silk Street, London EC2Y 8DS', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/25474641', now()),
  ('Bertha DocHouse', 51.5240584, -0.1231644, 'Curzon Bloomsbury, The Brunswick, London WC1N 1AW', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/291651296', now()),
  ('BFI IMAX', 51.5048209, -0.1136286, '1 Charlie Chaplin Walk, London SE1 8XR', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/123444154', now()),
  ('BFI Southbank', 51.5067272, -0.1151999, 'Belvedere Road, South Bank, London SE1 8XT', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/150702283', now()),
  ('Castle Sidcup', 51.4261534, 0.1011164, '106 High Street, Sidcup DA14 6DS', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/1013873133', now()),
  ('Ciné Lumière', 51.4945949, -0.1771003, '17 Queensberry Place, London SW7 2DT', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/relation/11655272', now()),
  ('Close-Up Film Centre', 51.5236118, -0.0719999, '97-99 Sclater Street, London E1 6HR', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/4145029892', now()),
  ('Coldharbour Blue', 51.4650472, -0.1012788, '259-260 Hardess Street, London SE24 0HN', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/1264390736', now()),
  ('David Lean Cinema', 51.3721316, -0.0990117, 'Croydon Clocktower, Katharine Street, Croydon CR9 1ET', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/299124495', now()),
  ('Electric Cinema Portobello', 51.5155240, -0.2050651, '191 Portobello Road, London W11 2ED', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/357556094', now()),
  ('Electric Cinema White City', 51.5107149, -0.2258670, '2 Television Centre, 101 Wood Lane, London W12 7FR', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/596555235', now()),
  ('Forest Cinema Walthamstow', 51.5849488, -0.0201930, '267 High Street, London E17 7FD', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/3384625336', now()),
  ('Genesis Cinema', 51.5213697, -0.0512128, '93-95 Mile End Road, London E1 4UJ', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/14495071', now()),
  ('ICA Cinema', 51.5061096, -0.1311127, 'The Mall, London SW1Y 5AH', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/10554856531', now()),
  ('JW3 Cinema', 51.5509292, -0.1847394, '341-351 Finchley Road, London NW3 6ET', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/110521967', now()),
  ('Kiln Cinema', 51.5431686, -0.2003532, '269 Kilburn High Road, London NW6 7JR', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/77665068', now()),
  ('Lumiere Romford', 51.5794872, 0.1852042, 'Mercury Gardens, Romford RM1 3EE', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/3193683067', now()),
  ('Metro Cinema', 51.5865654, -0.3324561, 'High Mead, Harrow HA1 2TX', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/209108050', now()),
  ('Olympic Cinema Barnes', 51.4752649, -0.2406378, '117-123 Church Road, Barnes, London SW13 9HL', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/595814487', now()),
  ('Peckhamplex', 51.4708590, -0.0679233, '95A Rye Lane, London SE15 4ST', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/78230879', now()),
  ('Phoenix Cinema', 51.5885079, -0.1637085, '52 High Road, East Finchley, London N2 9PJ', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/299028906', now()),
  ('Prince Charles Cinema', 51.5114907, -0.1302137, '7 Leicester Place, London WC2H 7BY', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/180594287', now()),
  ('Regent Street Cinema', 51.5168155, -0.1428506, '307 Regent Street, London W1B 3BL', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/1710144548', now()),
  ('Rich Mix', 51.5244023, -0.0733464, '35-47 Bethnal Green Road, London E1 6LA', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/274608954', now()),
  ('Rio Cinema', 51.5496199, -0.0755805, '107 Kingsland High Street, London E8 2PB', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/224192326', now()),
  ('Riverside Studios', 51.4887850, -0.2283572, '101 Queen Caroline Street, London W6 9BN', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/11435284025', now()),
  ('Science Museum IMAX', 51.4972100, -0.1777493, 'The Ronson Theatre, Science Museum, London SW7 2DD', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/11709415903', now()),
  ('The Arzner', 51.4976739, -0.0807865, '10 Abbey Street, London SE1 3UN', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/668541398', now()),
  ('The Castle Cinema', 51.5513367, -0.0431123, '64-66 Brooksby''s Walk, London E9 6DA', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/490724409', now()),
  ('The Chiswick Cinema', 51.4930902, -0.2510070, '94-96 Chiswick High Road, London W4 1SH', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/11809363653', now()),
  ('The Cinema at Selfridges', 51.5147736, -0.1519523, '40 Duke Street, London W1U 1AT', 'OpenStreetMap geocode of verified venue entrance', 'https://www.openstreetmap.org/node/4874363522', now()),
  ('The Cinema in the Arches', 51.4825125, -0.1469763, '22 Arches Lane, London SW11 8AB', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/6345003067', now()),
  ('The Cinema in the Power Station', 51.4817738, -0.1445821, 'Battersea Power Station, London SW11 8BZ', 'OpenStreetMap geocode of verified venue building', 'https://www.openstreetmap.org/way/4965216', now()),
  ('The Garden Cinema', 51.5162351, -0.1213420, '39-41 Parker Street, London WC2B 5PQ', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/way/97237929', now()),
  ('The Lexi Cinema', 51.5375275, -0.2224753, '194B Chamberlayne Road, London NW10 3JU', 'OpenStreetMap geocode of verified venue address', 'https://www.openstreetmap.org/way/467469463', now()),
  ('The Nickel', 51.5217117, -0.1117273, '117-119 Clerkenwell Road, London EC1R 5BY', 'OpenStreetMap venue record', 'https://www.openstreetmap.org/node/1236834452', now())
on conflict (name) do update
set
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  address = excluded.address,
  coordinate_source = excluded.coordinate_source,
  coordinate_source_url = excluded.coordinate_source_url,
  coordinates_verified_at = excluded.coordinates_verified_at,
  updated_at = now();
