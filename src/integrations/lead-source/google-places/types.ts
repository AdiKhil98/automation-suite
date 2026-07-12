/**
 * Minimal typing of the Places API (New) Text Search response for the ID-only
 * field mask (`places.id,nextPageToken`). We deliberately type nothing else —
 * no display content is requested or handled in Phase 2.
 */
export interface PlacesTextSearchResponse {
  places?: Array<{ id: string }>;
  nextPageToken?: string;
}

export const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Phase 2 discovery field mask — Place IDs + pagination token only (IDs-only SKU). */
export const DISCOVERY_FIELD_MASK = 'places.id,nextPageToken';
