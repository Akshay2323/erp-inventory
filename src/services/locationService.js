const { httpError } = require('./common');

const INDIA_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const STATE_ALIASES = {
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  uttaranchal: 'Uttarakhand',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
};

/** Rough India bounding box (incl. islands) — rejects pins clearly outside India. */
const INDIA_BOUNDS = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 98 };

const GEOCODER_URL = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const GEOCODER_USER_AGENT = process.env.GEOCODER_USER_AGENT || 'inventory-app/1.0';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function normalizeState(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ');
  if (STATE_ALIASES[key]) return STATE_ALIASES[key];
  return INDIA_STATES.find((s) => s.toLowerCase() === key) || null;
}

function isInIndia(lat, lng) {
  return lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat
    && lng >= INDIA_BOUNDS.minLng && lng <= INDIA_BOUNDS.maxLng;
}

function mapPlace(p) {
  const a = p.address || {};
  return {
    label: p.display_name,
    latitude: Number(p.lat),
    longitude: Number(p.lon),
    address: [a.house_number, a.building, a.road, a.neighbourhood, a.suburb].filter(Boolean).join(', ') || null,
    city: a.city || a.town || a.village || a.state_district || a.county || null,
    state: normalizeState(a.state) || a.state || null,
    pincode: a.postcode || null,
  };
}

async function geocoderGet(pathAndQuery) {
  const url = `${GEOCODER_URL}${pathAndQuery}`;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': GEOCODER_USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw httpError(502, `Location service not reachable: ${err.message}`);
  }
  if (!res.ok) throw httpError(502, `Location service error (${res.status})`);
  const data = await res.json();

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, { data, expires: Date.now() + CACHE_TTL_MS });
  return data;
}

/** Search places in India (frontend should debounce typing — public geocoder allows ~1 request/second). */
async function searchLocations(q) {
  const query = String(q || '').trim();
  if (query.length < 3) throw httpError(400, 'Type at least 3 characters to search');
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', countrycodes: 'in', addressdetails: '1', limit: '8',
  });
  const rows = await geocoderGet(`/search?${params}`);
  return rows.map(mapPlace);
}

/** Address for a map pin (when user drags/clicks the marker). */
async function reverseLocation(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw httpError(400, 'lat and lng are required numbers');
  }
  if (!isInIndia(latitude, longitude)) throw httpError(400, 'Location must be within India');
  const params = new URLSearchParams({
    lat: String(latitude), lon: String(longitude), format: 'jsonv2', addressdetails: '1',
  });
  const place = await geocoderGet(`/reverse?${params}`);
  if (place.error) throw httpError(404, 'No address found for this location');
  if (place.address?.country_code && place.address.country_code !== 'in') {
    throw httpError(400, 'Location must be within India');
  }
  return mapPlace(place);
}

module.exports = {
  INDIA_STATES,
  normalizeState,
  isInIndia,
  searchLocations,
  reverseLocation,
};
