const initiatives = JSON.parse(document.getElementById("initiative-data").textContent);
const translations = JSON.parse(document.getElementById("translation-data").textContent);
const languages = JSON.parse(document.getElementById("language-data").textContent);
const languageSwitcher = document.getElementById("language-switcher");
const locator = document.getElementById("locator");
const locationInput = document.getElementById("location");
const placeSuggestions = document.getElementById("place-suggestions");
const useLocation = document.getElementById("use-location");
const locationStatus = document.getElementById("location-status");
const transitPreferences = document.getElementById("transit-preferences");
const enableTransitButton = document.getElementById("enable-transit");
const declineTransitButton = document.getElementById("decline-transit");
const transitSettingsButton = document.getElementById("transit-settings");
const results = document.getElementById("results");
const nearest = document.getElementById("nearest");
const nearestGrid = document.getElementById("nearest-grid");
const nearestCount = document.getElementById("nearest-count");
const sortNearestButton = document.getElementById("sort-nearest");
const loadMoreButton = document.getElementById("load-more");
const showMapButton = document.getElementById("show-map");
const mapStatus = document.getElementById("map-status");
const mapElement = document.getElementById("map");
const search = document.getElementById("search");
const region = document.getElementById("region");
const list = document.getElementById("list");
const listCount = document.getElementById("list-count");
const noResults = document.getElementById("no-results");
const filters = document.getElementById("filters");
const GEOCODE_API_URL = "/geocode";
const TRANSITOUS_URL = "https://api.transitous.org/api/v6/plan";
const TRANSIT_PREFERENCE_KEY = "anti-socialcard-transit-preference-v1";
const ROUTE_CACHE_KEY = "anti-socialcard-transitous-city-v8";
const LEGACY_CACHE_KEYS = [
  "anti-socialcard-transitous-city-v7",
  "anti-socialcard-origin-labels-v1"
];
const BERLIN_TIME_ZONE = "Europe/Berlin";
let currentLanguage = chooseInitialLanguage();
let transitPreference = readTransitPreference();
let currentOrigin = null;
let originRouteLabel = "";
let map = null;
let markerLayer = null;
let originLayer = null;
let leafletLoading = null;
let locationRequestPending = false;
let rankedNearest = [];
let nearestVisibleCount = 5;
let nearestSortMode = "distance";
let routingGeneration = 0;
let routingController = new AbortController();
const cityStationCache = new Map();
const reverseGeocodeCache = new Map();

init();

function init() {
  renderLanguageSwitcher();
  applyLanguage(currentLanguage);
  renderList(initiatives);
  bindEvents();
}

function bindEvents() {
  search.addEventListener("input", applyFilters);
  region.addEventListener("change", applyFilters);
  filters.addEventListener("reset", () => requestAnimationFrame(applyFilters));
  loadMoreButton.addEventListener("click", () => {
    nearestVisibleCount += 5;
    nearestSortMode = "distance";
    renderNearest();
    routeVisibleInitiatives();
  });
  sortNearestButton.addEventListener("click", () => {
    nearestSortMode = nearestSortMode === "transit" ? "distance" : "transit";
    renderNearest();
  });
  locator.addEventListener("submit", async (event) => {
    event.preventDefault();
    const place = locationInput.value.trim();
    if (!place) return;
    clearPlaceSuggestions();
    setStatus("statusSearchingPlace");
    try {
      const places = await geocodePlaces(place);
      if (places.length === 1) {
        await selectPlace(place, places[0]);
      } else {
        renderPlaceSuggestions(places);
        setStatus("statusChoosePlace");
      }
    } catch (error) {
      locationStatus.textContent = error.message;
    }
  });
  placeSuggestions.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-place-index]");
    if (!button) return;
    const place = locationInput.value.trim();
    const selected = placeSuggestions.currentPlaces?.[Number(button.dataset.placeIndex)];
    if (!selected) return;
    await selectPlace(place, selected);
  });
  locationInput.addEventListener("input", clearPlaceSuggestions);
  enableTransitButton.addEventListener("click", enableTransit);
  declineTransitButton.addEventListener("click", disableTransit);
  transitSettingsButton.addEventListener("click", () => {
    renderTransitPreferences(true);
    transitPreferences.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  useLocation.addEventListener("click", () => {
    clearPlaceSuggestions();
    if (locationRequestPending) return;
    if (!window.isSecureContext) {
      setStatus("statusLocationInsecure");
      return;
    }
    if (!navigator.geolocation) {
      setStatus("statusLocationUnsupported");
      return;
    }
    locationRequestPending = true;
    useLocation.disabled = true;
    useLocation.setAttribute("aria-busy", "true");
    setStatus("statusWaitingLocation");
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          finishLocationRequest();
          const origin = {
            lat: position.coords.latitude,
            lon: position.coords.longitude
          };
          showNearest(origin, t("yourLocation"));
          resolveOriginLabel(origin);
        },
        (error) => {
          finishLocationRequest();
          if (error.code === error.PERMISSION_DENIED) {
            setStatus("statusLocationDenied");
          } else if (error.code === error.TIMEOUT) {
            setStatus("statusLocationTimeout");
          } else {
            setStatus("statusLocationFailed");
          }
        },
        { enableHighAccuracy: false, timeout: 30000, maximumAge: 300000 }
      );
    } catch {
      finishLocationRequest();
      setStatus("statusLocationFailed");
    }
  });
  showMapButton.addEventListener("click", () => enableMap());
}

function finishLocationRequest() {
  locationRequestPending = false;
  useLocation.disabled = false;
  useLocation.removeAttribute("aria-busy");
}

function chooseInitialLanguage() {
  const params = new URLSearchParams(location.search);
  const requested = params.get("lang") || navigator.language.slice(0, 2);
  if (languages.some((language) => language.code === requested)) return requested;
  if (requested === "ku") return "kmr";
  return "de";
}

function renderLanguageSwitcher() {
  languageSwitcher.innerHTML = languages.map((language) =>
    '<button type="button" data-lang="' + escapeHtml(language.code) + '">' + escapeHtml(language.label) + '</button>'
  ).join("");
  languageSwitcher.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-lang]");
    if (!button) return;
    applyLanguage(button.dataset.lang);
  });
}

function applyLanguage(code) {
  currentLanguage = translations[code] ? code : "de";
  const language = languages.find((item) => item.code === currentLanguage);
  document.documentElement.lang = currentLanguage;
  document.documentElement.dir = language?.dir || "ltr";
  const url = new URL(location.href);
  url.searchParams.set("lang", currentLanguage);
  history.replaceState(null, "", url);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  languageSwitcher.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === currentLanguage));
  });
  applyFilters();
  renderTransitPreferences(!transitPreferences.hidden);
  if (currentOrigin) {
    renderNearest();
    locationStatus.textContent = t("statusSortedPrefix") + " " + currentOrigin.label + ".";
  }
}

function t(key) {
  return translations[currentLanguage]?.[key] ?? translations.de[key] ?? key;
}

function setStatus(key) {
  locationStatus.textContent = t(key);
}

function readTransitPreference() {
  try {
    const value = localStorage.getItem(TRANSIT_PREFERENCE_KEY);
    return value === "enabled" || value === "disabled" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function writeTransitPreference(value) {
  transitPreference = value;
  try {
    localStorage.setItem(TRANSIT_PREFERENCE_KEY, value);
  } catch {
    // The preference remains active for this page view when storage is unavailable.
  }
}

function renderTransitPreferences(forceOpen = false) {
  const shouldShow = forceOpen || (currentOrigin && transitPreference === "unknown");
  transitPreferences.hidden = !shouldShow;
  enableTransitButton.hidden = transitPreference === "enabled";
  declineTransitButton.textContent = transitPreference === "enabled"
    ? t("transitDisable")
    : t("transitDecline");
}

function enableTransit() {
  writeTransitPreference("enabled");
  resetRoutingGeneration();
  transitPreferences.hidden = true;
  markRoutesPending();
  renderNearest();
  routeVisibleInitiatives();
}

function disableTransit() {
  resetRoutingGeneration();
  writeTransitPreference("disabled");
  try {
    localStorage.removeItem(ROUTE_CACHE_KEY);
    for (const key of LEGACY_CACHE_KEYS) localStorage.removeItem(key);
  } catch {
    // There may be no accessible cache to remove.
  }
  nearestSortMode = "distance";
  for (const item of rankedNearest) item.routeState = { status: "disabled" };
  transitPreferences.hidden = true;
  renderNearest();
}

function resetRoutingGeneration() {
  routingController.abort();
  routingController = new AbortController();
  routingGeneration += 1;
  cityStationCache.clear();
}

function isCurrentRoutingGeneration(generation, signal) {
  return transitPreference === "enabled" &&
    generation === routingGeneration &&
    !signal.aborted;
}

function assertCurrentRoutingGeneration(generation, signal) {
  if (isCurrentRoutingGeneration(generation, signal)) return;
  const error = new Error("Stale routing request");
  error.name = "AbortError";
  throw error;
}

function markRoutesPending() {
  for (const item of rankedNearest) {
    if (item.routeState.status !== "success") {
      item.routeState = { status: transitPreference === "enabled" ? "pending" : "disabled" };
    }
  }
}

function renderList(items) {
  const grouped = groupBy(items, (item) => item.region);
  const regions = [...grouped.keys()].sort((a, b) => a.localeCompare(b, "de"));
  list.innerHTML = regions.map((name) => {
    const entries = grouped.get(name);
    return '<section class="section region-section" data-region="' + escapeHtml(name) + '">' +
      '<div class="section-head"><h2>' + escapeHtml(name) + '</h2><span class="count">' + formatEntries(entries.length) + '</span></div>' +
      '<div class="grid">' + entries.map((item) => renderCard(item)).join("") + '</div>' +
      '</section>';
  }).join("");
  listCount.textContent = formatEntries(items.length);
}

function renderCard(item, distance, routeState) {
  const links = [];
  if (item.url) links.push('<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' + t("website") + '</a>');
  for (const link of item.transitLinks || []) {
    links.push('<a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(link.label || t("transit")) + '</a>');
  }
  const title = item.city || item.name;
  const initiativeName = item.city ? '<p class="initiative-name">' + escapeHtml(item.name) + '</p>' : "";
  const initiativeNotes = item.notes ? renderNotes(item.notes) : "";
  const locations = (item.locations || []).map((location) =>
    renderLocationDetails(location, item, Number.isFinite(distance))
  ).filter(Boolean).join("");
  const locationDetails = locations ? '<div class="locations">' + locations + '</div>' : "";
  const events = renderEvents(item.events || []);
  const proximity = Number.isFinite(distance) ? renderProximity(distance, routeState) : "";
  const updatedAt = item.updatedAt ? '<span class="updated-at">' + escapeHtml(t("updatedLabel") + ": " + formatDate(item.updatedAt)) + '</span>' : "";
  return '<article class="initiative" data-id="' + escapeHtml(item.id) + '">' +
    '<div><h3>' + escapeHtml(title) + '</h3>' + initiativeName + initiativeNotes + locationDetails + events + '</div>' + proximity +
    '<div class="card-footer"><div class="links">' + links.join("") + '</div>' + updatedAt + '</div>' +
    '</article>';
}

function renderProximity(distance, routeState) {
  const distanceText = '<span class="distance">' + Math.round(distance) + ' ' + escapeHtml(t("distanceKm")) + '</span>';
  if (!routeState || routeState.status === "disabled") {
    return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div></div>';
  }
  if (routeState.status === "pending") {
    return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitWaiting")) + '</span></div>';
  }
  if (routeState.status === "loading") {
    return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitLoading")) + '</span></div>';
  }
  if (routeState.status === "error") {
    return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitUnavailable")) + '</span></div>';
  }
  return '<div class="proximity"><div class="proximity-summary">' + distanceText + '<span>' +
    escapeHtml(t("cityTravelTime") + ": " + formatDuration(routeState.duration)) +
    '</span></div><span class="proximity-status">' +
    escapeHtml(routeState.fromStation + " → " + routeState.toStation) +
    '</span></div>';
}

function renderLocationDetails(location, item, includeRoute) {
  const title = [location.name, location.address].filter(Boolean).join(" · ");
  const openingHourRows = formatOpeningSlots(location.openingSlots);
  const openingHours = openingHourRows.length
    ? '<div class="opening-hours"><span class="opening-hours-label">' + escapeHtml(t("openingHoursLabel")) + '</span><span class="opening-hours-value">' +
      openingHourRows.map((row) => '<span class="opening-hours-row">' + escapeHtml(row.schedule) +
        (row.notes ? '<span class="slot-notes">' + escapeHtml(row.notes) + '</span>' : "") + '</span>').join("") + '</span></div>'
    : "";
  const notes = location.notes ? renderNotes(location.notes) : "";
  const events = renderEvents((item.events || []).filter((event) =>
    event.locationName && normalizePlace(event.locationName) === normalizePlace(location.name)
  ));
  const routeLink = transitPreference === "enabled" && includeRoute && location.coordinates
    ? '<div class="links"><a class="transitous-link" href="' + escapeHtml(buildTransitousUrl(item, location)) +
      '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t("transitousRoute")) + '</a></div>'
    : "";
  if (!title && !openingHours && !notes && !events && !routeLink) return "";
  return '<div class="location"><p class="location-name">' + escapeHtml(title) + '</p>' +
    openingHours + notes + events + routeLink + '</div>';
}

function renderEvents(events) {
  if (!events.length) return "";
  return '<div class="events">' + events.map((event) => {
    const place = [event.locationName, event.address].filter(Boolean).join(" · ");
    return '<div class="event"><p class="event-title">' + escapeHtml(event.title) + '</p>' +
      '<p><strong>' + escapeHtml(t("eventDateLabel")) + ':</strong> ' +
      escapeHtml(formatDate(event.date) + " · " + event.start + "–" + event.end) + '</p>' +
      (place ? '<p>' + escapeHtml(place) + '</p>' : "") +
      (event.notes ? renderNotes(event.notes) : "") + '</div>';
  }).join("") + '</div>';
}

function renderNotes(value) {
  return '<p class="notes"><strong>' + escapeHtml(t("notesLabel")) + ':</strong> ' + escapeHtml(value) + '</p>';
}

function formatOpeningSlots(slots = []) {
  return slots.map((slot) => {
    const weekdays = new Intl.ListFormat(currentLanguage, { style: "long", type: "conjunction" }).format(
      slot.weekdays.map(formatWeekday)
    );
    const recurrence = slot.weeksOfMonth?.length
      ? formatMonthlyRecurrence(slot, weekdays)
      : t("openingSlotWeekly").replace("{weekday}", weekdays);
    const [startHour, startMinute] = slot.start.split(":").map(Number);
    const [endHour, endMinute] = slot.end.split(":").map(Number);
    return {
      schedule: recurrence + " · " + formatTimeRange(startHour, startMinute, endHour, endMinute),
      notes: slot.notes || ""
    };
  });
}

function formatMonthlyRecurrence(slot, weekdays) {
  const ordinalKey = usesFeminineOrdinals(slot)
    ? "openingSlotOrdinalsFeminine"
    : "openingSlotOrdinals";
  const ordinalValues = t(ordinalKey);
  const ordinals = new Intl.ListFormat(currentLanguage, { style: "long", type: "conjunction" }).format(
    slot.weeksOfMonth.map((week) => ordinalValues[week - 1])
  );
  return capitalizeFirst(t("openingSlotMonthly")
    .replace("{ordinals}", ordinals)
    .replace("{weekday}", weekdays));
}

function usesFeminineOrdinals(slot) {
  if (slot.weekdays.length !== 1) return false;
  const weekday = slot.weekdays[0];
  return ((currentLanguage === "ru" || currentLanguage === "uk") && [3, 5].includes(weekday)) ||
    (currentLanguage === "ar" && weekday === 5);
}

function capitalizeFirst(value) {
  return value ? value.charAt(0).toLocaleUpperCase(currentLanguage) + value.slice(1) : value;
}

function formatWeekday(weekday) {
  const date = new Date(Date.UTC(2024, 0, Number(weekday)));
  return new Intl.DateTimeFormat(currentLanguage, { weekday: "long", timeZone: "UTC" }).format(date);
}

function formatTime(hour, minute) {
  const value = timeValue(hour, minute);
  return timeFormatter24().format(value) + " / " + timeFormatter12().format(value);
}

function formatTimeRange(startHour, startMinute, endHour, endMinute) {
  const start = timeValue(startHour, startMinute);
  const end = timeValue(endHour, endMinute, endHour * 60 + endMinute <= startHour * 60 + startMinute ? 2 : 1);
  return formatRange(timeFormatter24(), start, end) + " / " + formatRange(timeFormatter12(), start, end);
}

function formatRange(formatter, start, end) {
  return typeof formatter.formatRange === "function"
    ? formatter.formatRange(start, end)
    : formatter.format(start) + "–" + formatter.format(end);
}

function timeFormatter24() {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC"
  });
}

function timeFormatter12() {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: "UTC"
  });
}

function timeValue(hour, minute, day = 1) {
  return new Date(Date.UTC(2000, 0, day, hour, minute));
}

function formatDate(value) {
  const date = new Date(value + (value.length === 10 ? "T00:00:00Z" : ""));
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(currentLanguage).format(date);
}

function formatDuration(seconds) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!hours) return minutes + " " + t("minutesShort");
  return hours + " " + t("hoursShort") + (remaining ? " " + remaining + " " + t("minutesShort") : "");
}

function applyFilters() {
  const term = normalize(search.value.trim());
  const selectedRegion = region.value;
  const filtered = initiatives.filter((item) => {
    const haystack = normalize([
      item.name,
      item.city,
      item.region,
      item.country,
      item.domain,
      item.notes,
      ...getLocations(item).flatMap((location) => [
        location.name,
        location.address,
        location.notes,
        ...(location.openingSlots || []).map((slot) => slot.notes)
      ])
    ].join(" "));
    return (!term || haystack.includes(term)) && (!selectedRegion || item.region === selectedRegion);
  });
  renderList(filtered);
  noResults.style.display = filtered.length === 0 ? "block" : "none";
}

function showNearest(origin, label, options = {}) {
  resetRoutingGeneration();
  nearestSortMode = "distance";
  currentOrigin = { ...origin, label };
  originRouteLabel = origin.label || "";
  rankedNearest = initiatives
    .map((item) => {
      const nearestLocation = getLocations(item)
        .filter((location) => location.coordinates)
        .map((location) => ({
          ...location,
          distance: distanceInKm(origin.lat, origin.lon, location.coordinates.lat, location.coordinates.lon)
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      return nearestLocation ? {
        ...item,
        nearestLocation,
        distance: nearestLocation.distance,
        cityKey: cityRouteKey(item),
        routeState: { status: transitPreference === "enabled" ? "pending" : "disabled" }
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
  markRoutesPending();
  if (!options.preserveScroll) nearestVisibleCount = 5;
  renderNearest();
  routeVisibleInitiatives();
  nearestGrid.before(transitPreferences);
  renderTransitPreferences();

  results.hidden = false;
  locationStatus.textContent = t("statusSortedPrefix") + " " + label + ".";
  if (!options.preserveScroll) nearest.scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderNearest() {
  const visible = sortedVisibleInitiatives();
  nearestGrid.innerHTML = visible.map((item) => renderCard(item, item.distance, item.routeState)).join("");
  nearestCount.textContent = formatEntries(visible.length);
  updateNearestSortButton();
  loadMoreButton.hidden = nearestVisibleCount >= rankedNearest.length;
  if (map && currentOrigin) updateMap(visible, currentOrigin);
}

function sortedVisibleInitiatives() {
  const visible = rankedNearest.slice(0, nearestVisibleCount);
  if (nearestSortMode === "distance") return visible;
  return visible.sort((left, right) => {
    const leftDuration = transitSortDuration(left);
    const rightDuration = transitSortDuration(right);
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    const leftFailed = left.routeState.status === "error";
    const rightFailed = right.routeState.status === "error";
    if (leftFailed !== rightFailed) return leftFailed ? 1 : -1;
    return left.distance - right.distance;
  });
}

function transitSortDuration(item) {
  if (item.routeState.status === "success") return item.routeState.duration;
  const originCity = normalizePlace(currentOrigin?.stationQuery || "");
  const destinationCity = normalizePlace(item.city || "");
  if (item.routeState.status === "error" && originCity && originCity === destinationCity) return 0;
  return Infinity;
}

function updateNearestSortButton() {
  sortNearestButton.hidden = transitPreference !== "enabled";
  if (transitPreference !== "enabled") {
    sortNearestButton.disabled = true;
    return;
  }
  const visible = rankedNearest.slice(0, nearestVisibleCount);
  const routingComplete = visible.length > 0 &&
    visible.every((item) => item.routeState.status === "success" || item.routeState.status === "error");
  sortNearestButton.disabled = !routingComplete;
  sortNearestButton.setAttribute("aria-pressed", String(nearestSortMode === "transit"));
  sortNearestButton.textContent = nearestSortMode === "transit"
    ? t("sortByDistance")
    : routingComplete
      ? t("sortByTransit")
      : t("sortByTransitLoading");
}

async function routeVisibleInitiatives() {
  if (transitPreference !== "enabled") return;
  const generation = routingGeneration;
  const signal = routingController.signal;
  const visible = rankedNearest.slice(0, nearestVisibleCount);
  const pending = [...new Map(visible
    .filter((item) => item.routeState.status === "pending")
    .map((item) => [item.cityKey, item])).values()];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pending.length && isCurrentRoutingGeneration(generation, signal)) {
      const item = pending[nextIndex++];
      setCityRouteState(item.cityKey, { status: "loading" });
      renderNearest();
      try {
        const route = await fetchCityTravelTime(item, generation, signal);
        if (!isCurrentRoutingGeneration(generation, signal)) return;
        setCityRouteState(item.cityKey, { status: "success", ...route });
      } catch {
        if (!isCurrentRoutingGeneration(generation, signal)) return;
        setCityRouteState(item.cityKey, { status: "error" });
      }
      if (!isCurrentRoutingGeneration(generation, signal)) return;
      renderNearest();
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));
}

function setCityRouteState(cityKey, state) {
  for (const item of rankedNearest) {
    if (item.cityKey === cityKey) item.routeState = state;
  }
}

async function fetchCityTravelTime(item, generation, signal) {
  const fromStation = originRoutingPoint();
  const toStation = await resolveCityStation(item.city, signal);
  assertCurrentRoutingGeneration(generation, signal);
  if (!fromStation || !toStation) throw new Error("No city station");
  if (fromStation.id === toStation.id) {
    return { duration: 0, fromStation: fromStation.name, toStation: toStation.name };
  }
  const routeTime = representativeRouteTime();
  const cacheKey = transitCacheKey(fromStation, toStation, routeTime);
  const cached = readRouteCache(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    fromPlace: fromStation.id,
    toPlace: toStation.id,
    time: routeTime.time.toISOString(),
    arriveBy: "false",
    timetableView: "false",
    numItineraries: "3",
    maxItineraries: "3",
    detailedLegs: "false",
    detailedTransfers: "false",
    language: currentLanguage
  });
  const response = await fetch(TRANSITOUS_URL + "?" + params, { signal });
  assertCurrentRoutingGeneration(generation, signal);
  if (!response.ok) throw new Error("Transitous " + response.status);
  const data = await response.json();
  assertCurrentRoutingGeneration(generation, signal);
  const candidates = (data.itineraries || [])
    .map(typicalTransitDuration)
    .filter((candidate) => Number.isFinite(candidate.duration) && candidate.duration >= 0);
  if (!candidates.length) throw new Error("No transit itinerary");
  const railCandidates = candidates.filter((candidate) => candidate.hasRail);
  const durations = (railCandidates.length ? railCandidates : candidates)
    .map((candidate) => candidate.duration);
  const result = {
    duration: Math.min(...durations),
    fromStation: fromStation.name,
    toStation: toStation.name
  };
  assertCurrentRoutingGeneration(generation, signal);
  writeRouteCache(cacheKey, result, true);
  return result;
}

function originRoutingPoint() {
  if (!currentOrigin) return null;
  return {
    id: transitousOriginPlace(),
    name: originRouteLabel || currentOrigin.label || t("yourLocation")
  };
}

function typicalTransitDuration(itinerary) {
  const transitLegs = (itinerary.legs || []).filter((leg) => leg.mode !== "WALK");
  if (!transitLegs.length) return { duration: Number(itinerary.duration), hasRail: false };
  const start = new Date(transitLegs[0].startTime);
  const end = new Date(transitLegs[transitLegs.length - 1].endTime);
  const duration = (end - start) / 1000;
  return {
    duration: Number.isFinite(duration) && duration >= 0 ? duration : Number(itinerary.duration),
    hasRail: transitLegs.some((leg) => /RAIL|SUBURBAN/.test(leg.mode))
  };
}

function cityRouteKey(item) {
  return normalizePlace([item.city, item.region, item.country].filter(Boolean).join("|"));
}

function representativeRouteTime() {
  const now = new Date();
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = berlinDateParts(candidate);
    const weekday = isoWeekday(parts.year, parts.month, parts.day);
    if (weekday <= 5) {
      return { time: berlinLocalDate(parts.year, parts.month, parts.day, "10:00") };
    }
  }
  return { time: now };
}

async function resolveCityStation(city, signal = routingController.signal) {
  if (transitPreference !== "enabled") return null;
  const key = normalizePlace(city);
  if (!key) return null;
  if (cityStationCache.has(key)) return cityStationCache.get(key);
  const promise = fetchCityStation(city, key, signal)
    .then((station) => {
      if (!station && cityStationCache.get(key) === promise) cityStationCache.delete(key);
      return station;
    })
    .catch((error) => {
      if (cityStationCache.get(key) === promise) cityStationCache.delete(key);
      throw error;
    });
  cityStationCache.set(key, promise);
  return promise;
}

async function fetchCityStation(city, cityKey, signal) {
  const params = new URLSearchParams({ text: city + " Hauptbahnhof" });
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("https://api.transitous.org/api/v1/geocode?" + params, { signal });
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500) return null;
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") throw error;
      // Retry transient network failures once.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!response?.ok) return null;
  const results = await response.json();
  const matchingStops = results.filter((result) =>
    result.type === "STOP" && stationMatchesCity(result, cityKey)
  );
  const station =
    matchingStops.find((result) => /\b(hauptbahnhof|hbf)\b/i.test(result.name)) ||
    matchingStops.find((result) => /\bbahnhof\b/i.test(result.name)) ||
    matchingStops.find((result) => /\b(zob|central bus station)\b/i.test(result.name)) ||
    matchingStops[0];
  return station ? { id: station.id, name: station.name, lat: Number(station.lat), lon: Number(station.lon) } : null;
}

function stationMatchesCity(station, cityKey) {
  return normalizePlace(station.name).includes(cityKey) ||
    station.areas?.some((area) => normalizePlace(area.name) === cityKey);
}

function transitCacheKey(fromStation, toStation, routeTime) {
  const parts = berlinDateParts(routeTime.time);
  return ["city-v7", fromStation.id, toStation.id, parts.year, parts.month, parts.day].join("|");
}

function readRouteCache(key) {
  try {
    const cache = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY) || "{}");
    const entry = cache[key];
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.route;
  } catch {
    return null;
  }
}

function writeRouteCache(key, route, future) {
  try {
    const cache = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY) || "{}");
    const now = Date.now();
    for (const [entryKey, entry] of Object.entries(cache)) {
      if (!entry?.expiresAt || entry.expiresAt <= now) delete cache[entryKey];
    }
    cache[key] = {
      createdAt: now,
      expiresAt: now + (future ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000),
      route
    };
    const entries = Object.entries(cache).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 200);
    localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Routing still works when storage is disabled or full.
  }
}

async function geocodePlaces(place) {
  const params = new URLSearchParams({
    q: place,
    format: "jsonv2",
    limit: "6",
    countrycodes: "de,at",
    addressdetails: "1",
    namedetails: "1"
  });
  let response;
  try {
    response = await fetch(GEOCODE_API_URL + "/search?" + params);
  } catch {
    const localMatch = findLocalPlace(place);
    if (localMatch) return [localMatch];
    throw new Error(t("statusPlaceError"));
  }
  if (!response.ok) {
    const localMatch = findLocalPlace(place);
    if (localMatch) return [localMatch];
    throw new Error(t("statusPlaceError"));
  }
  const results = await response.json();
  const places = results.map((result) => formatGeocodeResult(result, place))
    .filter((result, index, entries) =>
      entries.findIndex((entry) => entry.lat === result.lat && entry.lon === result.lon) === index);
  if (!places.length) {
    const localMatch = findLocalPlace(place);
    if (localMatch) return [localMatch];
    throw new Error(t("statusPlaceNotFound"));
  }
  return places;
}

function formatGeocodeResult(result, fallback) {
  const address = result.address || {};
  const placeName = result.namedetails?.name ||
    result.name ||
    address.village ||
    address.town ||
    address.city ||
    address.suburb ||
    address.municipality ||
    fallback;
  const postcode = address.postcode || "";
  const state = address.state || "";
  const nearby = [
    address.city,
    address.town,
    address.municipality,
    address.county
  ].find((value) => value && normalizePlace(value) !== normalizePlace(placeName)) || "";
  return {
    lat: Number(result.lat),
    lon: Number(result.lon),
    label: [placeName, postcode].filter(Boolean).join(" "),
    detail: [state, nearby].filter(Boolean).join(" · "),
    stationQuery: address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      postcode ||
      fallback
  };
}

function renderPlaceSuggestions(places) {
  placeSuggestions.currentPlaces = places;
  placeSuggestions.innerHTML = places.map((place, index) =>
    '<li><button type="button" data-place-index="' + index + '">' +
    escapeHtml(place.label) +
    (place.detail ? '<small>' + escapeHtml(place.detail) + '</small>' : "") +
    '</button></li>'
  ).join("");
  placeSuggestions.hidden = false;
  placeSuggestions.querySelector("button")?.focus();
}

function clearPlaceSuggestions() {
  placeSuggestions.hidden = true;
  placeSuggestions.innerHTML = "";
  placeSuggestions.currentPlaces = null;
}

async function selectPlace(query, place) {
  clearPlaceSuggestions();
  locationInput.value = place.label;
  setStatus("statusSearchingPlace");
  const origin = await preferCentralStation(query, place);
  showNearest(origin, place.label);
}

async function preferCentralStation(place, fallback) {
  if (transitPreference !== "enabled") return fallback;
  if (looksLikeFullAddress(place)) return fallback;
  try {
    const city = fallback.stationQuery || fallback.label || place;
    const station = await resolveCityStation(city);
    if (!station) return fallback;
    return {
      lat: Number(station.lat),
      lon: Number(station.lon),
      label: station.name,
      stationQuery: city,
      transitousPlace: station.id
    };
  } catch {
    return fallback;
  }
}

function looksLikeFullAddress(value) {
  const input = String(value).trim();
  const withoutPostcode = input.replace(/\b\d{5}\b/, "");
  const hasHouseNumber = /\b\d+[a-z]?\b/i.test(withoutPostcode);
  const hasStreet = /\b(stra(?:ße|sse|ss|ße)|str\.?|weg|allee|platz|gasse|ufer|chaussee|damm|ring)\b/i.test(input);
  return hasHouseNumber && hasStreet;
}

function transitousOriginPlace() {
  return currentOrigin.transitousPlace || currentOrigin.lat + "," + currentOrigin.lon;
}

async function resolveOriginLabel(origin) {
  const key = origin.lat.toFixed(4) + "," + origin.lon.toFixed(4);
  try {
    if (reverseGeocodeCache.has(key)) {
      const cached = reverseGeocodeCache.get(key);
      originRouteLabel = cached.label;
      currentOrigin.stationQuery = cached.city || "";
      retryCityRouting();
      renderNearest();
      return;
    }
    const params = new URLSearchParams({
      lat: origin.lat,
      lon: origin.lon,
      format: "jsonv2",
      zoom: "16",
      addressdetails: "1"
    });
    const response = await fetch(GEOCODE_API_URL + "/reverse?" + params);
    if (!response.ok) return;
    const result = await response.json();
    const label = result.display_name?.split(",").slice(0, 3).join(", ").trim();
    if (!label) return;
    originRouteLabel = label;
    const city = result.address?.city ||
      result.address?.town ||
      result.address?.village ||
      result.address?.municipality ||
      "";
    currentOrigin.stationQuery = city;
    reverseGeocodeCache.set(key, { label, city });
    retryCityRouting();
    renderNearest();
  } catch {
    // Coordinates keep the Transitous link usable without reverse geocoding.
  }
}

function retryCityRouting() {
  if (transitPreference !== "enabled") return;
  if (!currentOrigin.stationQuery) return;
  for (const item of rankedNearest.slice(0, nearestVisibleCount)) {
    if (item.routeState.status === "error") item.routeState = { status: "pending" };
  }
  routeVisibleInitiatives();
}

function buildTransitousUrl(item, location) {
  const destination = [location.name, location.address].filter(Boolean).join(" · ") ||
    location.coordinates?.label ||
    item.city ||
    item.name;
  const routeTime = routeTimeForLocation(location);
  const params = new URLSearchParams({
    fromPlace: transitousOriginPlace(),
    toPlace: location.coordinates.lat + "," + location.coordinates.lon,
    fromName: originRouteLabel || currentOrigin.label || t("yourLocation"),
    toName: destination,
    time: formatTransitousDateTime(routeTime.time),
    arriveBy: String(routeTime.arriveBy)
  });
  return "https://api.transitous.org?" + params;
}

function routeTimeForLocation(location) {
  const now = new Date();
  const slots = location.openingSlots || [];
  if (!slots.length) return { time: now, arriveBy: false };
  const current = berlinDateParts(now);
  for (const slot of slots) {
    const interval = slotInterval(current, slot);
    if (interval && now >= interval.start && now < interval.end) {
      return { time: now, arriveBy: false };
    }
  }
  for (let offset = 0; offset <= 56; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = berlinDateParts(candidate);
    const nextInterval = slots
      .map((slot) => slotInterval(parts, slot))
      .filter((interval) => interval?.start > now)
      .sort((left, right) => left.start - right.start)[0];
    if (nextInterval) {
      return { time: new Date(nextInterval.start.getTime() - 10 * 60 * 1000), arriveBy: true };
    }
  }
  return { time: now, arriveBy: false };
}

function slotInterval(parts, slot) {
  const weekday = isoWeekday(parts.year, parts.month, parts.day);
  const weekOfMonth = Math.ceil(parts.day / 7);
  if (!slot.weekdays.includes(weekday)) return null;
  if (slot.weeksOfMonth?.length && !slot.weeksOfMonth.includes(weekOfMonth)) return null;
  return {
    start: berlinLocalDate(parts.year, parts.month, parts.day, slot.start),
    end: berlinLocalDate(parts.year, parts.month, parts.day, slot.end)
  };
}

function berlinDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day };
}

function berlinLocalDate(year, month, day, time) {
  const [hour, minute] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(guess);
  const local = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return new Date(guess.getTime() - (represented - guess.getTime()));
}

function isoWeekday(year, month, day) {
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dayOfWeek === 0 ? 7 : dayOfWeek;
}

function formatTransitousDateTime(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return value.year + "-" + value.month + "-" + value.day + "T" + value.hour + ":" + value.minute;
}

function findLocalPlace(place) {
  const query = normalizePlace(place);
  if (!query) return null;

  const exactMatch = initiatives.find((item) => {
    if (!getLocations(item).some((location) => location.coordinates)) return false;
    return localPlaceKeys(item).some((key) => normalizePlace(key) === query);
  });
  if (exactMatch) return localOrigin(exactMatch);

  const partialMatch = initiatives.find((item) => {
    if (query.length < 4 || !getLocations(item).some((location) => location.coordinates)) return false;
    return localPlaceKeys(item).some((key) => normalizePlace(key).includes(query));
  });
  return partialMatch ? localOrigin(partialMatch) : null;
}

function localPlaceKeys(item) {
  return [
    item.name,
    item.city,
    item.region,
    ...getLocations(item).flatMap((location) => [location.name, location.address, location.coordinates?.label]),
    ...(item.aliases || [])
  ].filter(Boolean);
}

function localOrigin(item) {
  const location = getLocations(item).find((entry) => entry.coordinates);
  if (!location) return null;
  return {
    lat: location.coordinates.lat,
    lon: location.coordinates.lon,
    label: item.city || item.name,
    stationQuery: item.city || item.name
  };
}

function getLocations(item) {
  const locations = item.locations?.length
    ? [...item.locations]
    : item.coordinates
      ? [{ name: "", address: item.address || "", openingSlots: [], notes: "", coordinates: item.coordinates }]
      : [];
  for (const event of item.events || []) {
    if (!event.coordinates) continue;
    locations.push({
      name: event.title,
      address: event.address,
      openingSlots: [],
      notes: [formatDate(event.date) + " · " + event.start + "–" + event.end, event.notes].filter(Boolean).join("\n"),
      coordinates: event.coordinates
    });
  }
  return locations;
}

async function enableMap() {
  mapStatus.textContent = t("mapLoading");
  await loadLeaflet();
  mapElement.style.display = "block";
  const origin = currentOrigin;
  if (!map) {
    map = L.map(mapElement, { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    originLayer = L.layerGroup().addTo(map);
  }
  updateMap(origin ? null : initiatives.slice(0, 200), origin);
  mapStatus.textContent = t("mapReady");
  setTimeout(() => {
    map.invalidateSize();
    if (origin) map.setView([origin.lat, origin.lon], 12);
  }, 0);
}

function updateMap(items, origin) {
  if (!map) return;
  const visible = items ?? initiatives
    .filter((item) => getLocations(item).some((location) => location.coordinates))
    .map((item) => currentOrigin ? {
      ...item,
      distance: Math.min(...getLocations(item)
        .filter((location) => location.coordinates)
        .map((location) => distanceInKm(currentOrigin.lat, currentOrigin.lon, location.coordinates.lat, location.coordinates.lon)))
    } : item)
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    .slice(0, currentOrigin ? 80 : 200);
  markerLayer.clearLayers();
  originLayer.clearLayers();
  const bounds = [];
  for (const item of visible) {
    for (const location of getLocations(item)) {
      if (!location.coordinates) continue;
      const latLng = [location.coordinates.lat, location.coordinates.lon];
      bounds.push(latLng);
      L.marker(latLng).addTo(markerLayer).bindPopup(renderPopup(item, location));
    }
  }
  if (origin) {
    const originLatLng = [origin.lat, origin.lon];
    bounds.push(originLatLng);
    L.circleMarker(originLatLng, { radius: 8, color: "#0f6760", fillOpacity: 0.8 }).addTo(originLayer).bindPopup(t("yourLocation"));
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
}

function renderPopup(item, location) {
  const locationLabel = location.coordinates?.label || location.address || [item.city, item.region].filter(Boolean).join(" · ");
  const openingHours = formatOpeningSlots(location.openingSlots);
  return '<strong>' + escapeHtml(item.name) + '</strong><br>' +
    (location.name ? escapeHtml(location.name) + '<br>' : "") +
    escapeHtml(locationLabel) +
    (openingHours.length ? '<br><br><strong>' + escapeHtml(t("openingHoursLabel")) + '</strong><br>' +
      openingHours.map((row) => escapeHtml(row.schedule) + (row.notes ? '<br><small>' + escapeHtml(row.notes) + '</small>' : "")).join("<br>") : "") +
    (location.notes ? '<br><br><strong>' + escapeHtml(t("notesLabel")) + '</strong><br>' + escapeHtml(location.notes) : "") +
    (item.url ? '<br><a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' + t("website") + '</a>' : "");
}

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "assets/leaflet/leaflet.css";
    document.head.append(link);
    const script = document.createElement("script");
    script.src = "assets/leaflet/leaflet.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return leafletLoading;
}

function formatEntries(count) {
  return count === 1 ? t("oneEntry") : count + " " + t("entries");
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function normalize(value) {
  return value.toLocaleLowerCase(currentLanguage === "de" ? "de-DE" : undefined);
}

function normalizePlace(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-DE")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distanceInKm(lat1, lon1, lat2, lon2) {
  const radius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
