import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

interface StopSummary {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  lines: number[];
}

interface ArrivalBus {
  bus_id: number;
  eta_minutes: number | null;
  distance_meters: number | null;
  status: number | null;
  last_stop_id: number | null;
}

interface LineArrivals {
  line_id: number;
  line_name: string | null;
  color_hex: string | null;
  buses: ArrivalBus[];
}

interface ArrivalsResponse {
  stop_id: number;
  lines: LineArrivals[];
  fetched_at: string;
  source: "live" | "cache" | "stale";
}

interface SearchToolPayload {
  total: number;
  stops: StopSummary[];
}

interface ArrivalsToolPayload {
  stop: StopSummary | null;
  arrivals: ArrivalsResponse | null;
  message?: string;
}

interface ToolResultLike {
  structuredContent?: unknown;
  isError?: boolean;
}

const DEFAULT_LOCALE = "es-ES";
const app = new App({
  name: "Buses A Coruna MCP App",
  version: "1.0.0",
});

const mainEl = document.querySelector("main");
const searchInput = document.getElementById("stop-search") as HTMLInputElement | null;
const resultsList = document.getElementById("stop-results") as HTMLUListElement | null;
const resultsStatusEl = document.getElementById("results-status");
const currentStopLabel = document.getElementById("current-stop-label");
const stopNameEl = document.getElementById("stop-name");
const stopHelperEl = document.getElementById("stop-helper");
const arrivalsEl = document.getElementById("arrivals");
const statusEl = document.getElementById("status");
const refreshButton = document.getElementById("refresh-button") as HTMLButtonElement | null;

let currentStopId: number | null = null;
let allStops: StopSummary[] = [];
let filteredStops: StopSummary[] = [];
let requestGeneration = 0;
let activeArrivalsController: AbortController | undefined;
let hasRenderedArrivals = false;
let hasUserSelectedStop = false;
let isConnected = false;
let isTornDown = false;
let appLocale = DEFAULT_LOCALE;
let appTimeZone: string | undefined;
const busyOwners = new Set<string>();

searchInput?.addEventListener("input", handleSearchInput);
searchInput?.addEventListener("keydown", handleSearchKeydown);
searchInput?.addEventListener("blur", () => {
  window.setTimeout(() => {
    if (document.activeElement !== searchInput) {
      clearSearchResults();
    }
  }, 100);
});
resultsList?.addEventListener("pointerdown", (event) => event.preventDefault());
resultsList?.addEventListener("click", handleResultClick);
refreshButton?.addEventListener("click", () => {
  if (currentStopId !== null) {
    void loadArrivals(currentStopId, { manual: true });
  }
});
document.addEventListener("visibilitychange", handleVisibilityChange);

app.ontoolresult = (result) => {
  applyIncomingToolResult(result as ToolResultLike);
};

app.onhostcontextchanged = (context) => {
  applyHostContext(context);
};

app.onteardown = async () => {
  isTornDown = true;
  isConnected = false;
  requestGeneration += 1;
  activeArrivalsController?.abort();
  activeArrivalsController = undefined;
  busyOwners.clear();
  renderBusyState();
  return {};
};

void initialize();

async function initialize(): Promise<void> {
  setBusyOwner("initialize", true);
  setStatus("Conectando con el servidor MCP...");
  try {
    await app.connect();
    if (isTornDown) {
      return;
    }
    isConnected = true;
    applyHostContext(app.getHostContext());
    setStatus("Cargando paradas...");
    await bootstrapStops();
  } catch {
    if (!isTornDown) {
      setStatus("No se pudo conectar con el servidor MCP.");
    }
  } finally {
    if (!isTornDown) {
      setBusyOwner("initialize", false);
    }
  }
}

function applyIncomingToolResult(result: ToolResultLike): void {
  const searchPayload = parseSearchPayload(result.structuredContent);
  if (searchPayload) {
    applySearchPayload(searchPayload);
    return;
  }

  const arrivalsPayload = parseArrivalsPayload(result.structuredContent);
  if (!arrivalsPayload) {
    if (result.structuredContent !== undefined) {
      setStatus("El servidor devolvió datos con un formato no válido.");
    }
    return;
  }

  const resultStopId = arrivalsPayload.stop?.id ?? arrivalsPayload.arrivals?.stop_id;
  if (
    hasUserSelectedStop &&
    (resultStopId === undefined || resultStopId !== currentStopId)
  ) {
    return;
  }
  applyArrivalsPayload(arrivalsPayload);
}

async function bootstrapStops(): Promise<void> {
  try {
    const result = (await app.callServerTool({
      name: "search_stops",
      arguments: {},
    })) as ToolResultLike;
    const payload = parseSearchPayload(result.structuredContent);
    if (!payload) {
      throw new Error("invalid_search_payload");
    }
    applySearchPayload(payload);
  } catch {
    setStatus("No se pudo cargar el listado de paradas.");
  }
}

function applySearchPayload(payload: SearchToolPayload): void {
  allStops = [...payload.stops].sort((a, b) =>
    a.name.localeCompare(b.name, appLocale, { sensitivity: "base" }),
  );
  filteredStops = allStops;
  if (!hasRenderedArrivals && !hasUserSelectedStop) {
    showSelectionState();
  }
}

function applyArrivalsPayload(payload: ArrivalsToolPayload): void {
  hasRenderedArrivals = true;
  if (!payload.stop) {
    showUnavailableState(payload.message ?? "stop_not_found");
    return;
  }

  currentStopId = payload.stop.id;
  updateCurrentStopLabel(payload.stop);
  updateStopSummary(payload.stop);
  if (refreshButton) {
    refreshButton.disabled = false;
  }

  if (!payload.arrivals) {
    renderArrivalError(payload.message ?? "transit_api_unavailable");
    return;
  }

  renderArrivals(payload.arrivals);
  setFreshnessStatus(payload.arrivals);
}

function handleSearchInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const value = target.value.trim().toLocaleLowerCase(appLocale);
  if (!allStops.length) {
    clearSearchResults();
    return;
  }
  filteredStops = value
    ? allStops.filter(
        (stop) =>
          stop.name.toLocaleLowerCase(appLocale).includes(value) ||
          String(stop.id).includes(value),
      )
    : allStops;
  renderResults(filteredStops.slice(0, 4));
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    clearSearchResults();
    return;
  }
  if (!resultsList || !resultsList.children.length) {
    return;
  }

  const options = Array.from(resultsList.querySelectorAll<HTMLLIElement>('li[role="option"]'));
  if (!options.length) {
    return;
  }
  const currentIndex = options.findIndex(
    (item) => item.getAttribute("aria-selected") === "true",
  );

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveOption(options, currentIndex < options.length - 1 ? currentIndex + 1 : 0);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveOption(options, currentIndex > 0 ? currentIndex - 1 : options.length - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    setActiveOption(options, 0);
  } else if (event.key === "End") {
    event.preventDefault();
    setActiveOption(options, options.length - 1);
  } else if (event.key === "Enter" && currentIndex >= 0) {
    event.preventDefault();
    selectResultOption(options[currentIndex]);
  }
}

function handleResultClick(event: Event): void {
  const target = event.target as HTMLElement;
  const listItem = target.closest<HTMLLIElement>('li[role="option"][data-stop-id]');
  if (listItem) {
    selectResultOption(listItem);
  }
}

function selectResultOption(option: HTMLLIElement): void {
  const stopId = Number(option.dataset.stopId);
  const stop = findStopById(stopId);
  if (stop) {
    void selectStop(stop);
  }
}

function renderResults(stops: StopSummary[]): void {
  if (!resultsList) {
    return;
  }
  resultsList.replaceChildren();
  if (!stops.length) {
    const item = document.createElement("li");
    item.className = "no-results";
    item.textContent = "Sin resultados";
    resultsList.appendChild(item);
    setResultsOpen(true);
    announceResults("No se encontraron paradas.");
    return;
  }

  stops.forEach((stop, index) => {
    const item = document.createElement("li");
    item.id = `stop-option-${stop.id}`;
    item.dataset.stopId = String(stop.id);
    item.role = "option";
    item.setAttribute("aria-selected", index === 0 ? "true" : "false");
    const label = document.createElement("strong");
    label.textContent = `${stop.id} - ${stop.name}`;
    item.appendChild(label);
    resultsList.appendChild(item);
  });
  setResultsOpen(true);
  setActiveOption(Array.from(resultsList.querySelectorAll<HTMLLIElement>('li[role="option"]')), 0);
  announceResults(`${stops.length} ${stops.length === 1 ? "parada encontrada" : "paradas encontradas"}.`);
}

function setActiveOption(options: HTMLLIElement[], index: number): void {
  options.forEach((item, itemIndex) => {
    item.setAttribute("aria-selected", itemIndex === index ? "true" : "false");
  });
  const active = options[index];
  if (active) {
    searchInput?.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
  setResultsOpen(true);
}

function findStopById(stopId: number): StopSummary | undefined {
  return allStops.find((stop) => stop.id === stopId);
}

async function selectStop(stop: StopSummary): Promise<void> {
  hasUserSelectedStop = true;
  currentStopId = stop.id;
  if (searchInput) {
    searchInput.value = "";
  }
  clearSearchResults();
  updateCurrentStopLabel(stop);
  updateStopSummary(stop);
  await loadArrivals(stop.id, { manual: true });
}

async function loadArrivals(
  stopId: number,
  options: { manual?: boolean } = {},
): Promise<void> {
  if (!isConnected || isTornDown || document.hidden) {
    return;
  }

  const generation = ++requestGeneration;
  const busyOwner = `arrivals:${generation}`;
  activeArrivalsController?.abort();
  const controller = new AbortController();
  activeArrivalsController = controller;
  setBusyOwner(busyOwner, true);
  setStatus(options.manual ? "Actualizando bajo pedido..." : "Buscando datos frescos...");

  try {
    const result = (await app.callServerTool(
      {
        name: "show_bus_arrivals",
        arguments: { stopId },
      },
      { signal: controller.signal, timeout: 20_000 },
    )) as ToolResultLike;

    if (!isCurrentRequest(generation, stopId)) {
      return;
    }
    const payload = parseArrivalsPayload(result.structuredContent);
    if (!payload || (payload.stop?.id ?? payload.arrivals?.stop_id) !== stopId) {
      renderArrivalError("invalid_server_response");
      return;
    }
    applyArrivalsPayload(payload);
  } catch {
    if (isCurrentRequest(generation, stopId)) {
      renderArrivalError("transit_api_unavailable");
    }
  } finally {
    if (activeArrivalsController === controller) {
      activeArrivalsController = undefined;
    }
    setBusyOwner(busyOwner, false);
  }
}

function isCurrentRequest(generation: number, stopId: number): boolean {
  return generation === requestGeneration && stopId === currentStopId && !isTornDown;
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    requestGeneration += 1;
    activeArrivalsController?.abort();
    activeArrivalsController = undefined;
    busyOwners.clear();
    renderBusyState();
  }
}

function renderArrivals(arrivals: ArrivalsResponse): void {
  if (!arrivalsEl) {
    return;
  }
  arrivalsEl.replaceChildren();
  if (!arrivals.lines.length) {
    arrivalsEl.appendChild(createEmptyState("Sin datos de llegadas para esta parada."));
    return;
  }

  arrivals.lines.forEach((line, lineIndex) => {
    const row = document.createElement("div");
    row.className = "line-row";
    row.style.animationDelay = `${Math.min(lineIndex * 35, 210)}ms`;
    applyLineColor(row, line.color_hex);

    const identity = document.createElement("div");
    identity.className = "line-identity";
    const color = document.createElement("span");
    color.className = "line-color";
    color.setAttribute("aria-hidden", "true");
    const title = document.createElement("div");
    title.className = "line-title";
    title.textContent = line.line_name ?? `Línea ${line.line_id}`;
    identity.append(color, title);

    const busContainer = document.createElement("div");
    busContainer.className = "bus-times";
    line.buses.forEach((bus, busIndex) => {
      const badge = document.createElement("div");
      badge.className = `time-chip${busIndex === 0 ? " is-next" : ""}`;
      badge.appendChild(document.createTextNode(formatEtaLabel(bus.eta_minutes)));
      const absolute = formatAbsoluteTime(bus.eta_minutes);
      if (absolute) {
        const absoluteEl = document.createElement("span");
        absoluteEl.textContent = absolute;
        badge.appendChild(absoluteEl);
      }
      busContainer.appendChild(badge);
    });

    if (!line.buses.length) {
      const empty = document.createElement("div");
      empty.className = "time-chip";
      empty.textContent = "Sin buses en ruta";
      busContainer.appendChild(empty);
    }
    row.append(identity, busContainer);
    arrivalsEl.appendChild(row);
  });
}

function updateStopSummary(stop: StopSummary): void {
  if (stopNameEl) {
    stopNameEl.textContent = stop.name;
  }
  if (stopHelperEl) {
    const lineCount = stop.lines.length;
    stopHelperEl.textContent =
      lineCount > 0
        ? `${lineCount} línea${lineCount === 1 ? "" : "s"} con servicio en esta parada`
        : "Sin líneas asociadas a esta parada";
  }
}

function showSelectionState(): void {
  currentStopId = null;
  currentStopLabel?.setAttribute("hidden", "");
  arrivalsEl?.replaceChildren(
    createEmptyState("Busca una parada para consultar sus tiempos."),
  );
  if (refreshButton) {
    refreshButton.disabled = true;
  }
  if (stopNameEl) {
    stopNameEl.textContent = "Selecciona una parada";
  }
  if (stopHelperEl) {
    stopHelperEl.textContent = `${allStops.length} ${allStops.length === 1 ? "parada disponible" : "paradas disponibles"}`;
  }
  setStatus("Busca y selecciona una parada para consultar sus llegadas.");
}

function showUnavailableState(reason: string): void {
  arrivalsEl?.replaceChildren(createEmptyState("Selecciona otra parada para continuar."));
  if (stopNameEl) {
    stopNameEl.textContent = `Parada no disponible (${reason})`;
  }
  if (stopHelperEl) {
    stopHelperEl.textContent = "Sin datos";
  }
  setStatus("No se encontró la parada.");
}

function renderArrivalError(reason: string): void {
  arrivalsEl?.replaceChildren(createEmptyState("No hay datos disponibles en este momento."));
  mainEl?.setAttribute("data-freshness", "error");
  setStatus(`No se pudo actualizar (${reason}).`);
}

function updateCurrentStopLabel(stop: StopSummary): void {
  if (!currentStopLabel) {
    return;
  }
  currentStopLabel.removeAttribute("hidden");
  currentStopLabel.textContent = `Parada ${stop.id}`;
}

function createEmptyState(text: string): HTMLDivElement {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

function applyLineColor(element: HTMLElement, color: string | null): void {
  if (color && isSafeHexColor(color)) {
    element.style.setProperty("--line-color", color);
  }
}

function clearSearchResults(): void {
  resultsList?.replaceChildren();
  setResultsOpen(false);
  announceResults("");
}

function setResultsOpen(open: boolean): void {
  if (resultsList) {
    resultsList.hidden = !open;
  }
  searchInput?.setAttribute("aria-expanded", String(open));
  if (!open) {
    searchInput?.removeAttribute("aria-activedescendant");
  }
}

function announceResults(text: string): void {
  if (resultsStatusEl) {
    resultsStatusEl.textContent = text;
  }
}

function setBusyOwner(owner: string, busy: boolean): void {
  if (busy) {
    busyOwners.add(owner);
  } else {
    busyOwners.delete(owner);
  }
  renderBusyState();
}

function renderBusyState(): void {
  const busy = busyOwners.size > 0 && !isTornDown;
  mainEl?.setAttribute("aria-busy", String(busy));
  arrivalsEl?.setAttribute("aria-busy", String(busy));
  if (refreshButton) {
    refreshButton.disabled = busy || currentStopId === null;
  }
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setFreshnessStatus(arrivals: ArrivalsResponse): void {
  const observedAt = new Date(arrivals.fetched_at);
  const ageSeconds = Math.max(0, Math.round((Date.now() - observedAt.getTime()) / 1000));
  mainEl?.setAttribute("data-freshness", arrivals.source);

  if (arrivals.source === "stale") {
    setStatus(
      `Última lectura disponible: ${formatClockTime(observedAt)} · hace ${formatAge(ageSeconds)}`,
    );
    return;
  }
  if (arrivals.source === "cache") {
    setStatus(`Lectura reciente: ${formatClockTime(observedAt)} · hace ${formatAge(ageSeconds)}`);
    return;
  }
  setStatus(`Datos en tiempo real · ${formatClockTime(observedAt)}`);
}

function formatAge(seconds: number): string {
  if (seconds < 5) {
    return "unos segundos";
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (!context) {
    return;
  }
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
  if (context.locale && isValidLocale(context.locale)) {
    appLocale = context.locale;
    document.documentElement.lang = context.locale;
  }
  if (context.timeZone && isValidTimeZone(context.timeZone)) {
    appTimeZone = context.timeZone;
  }
  if (context.safeAreaInsets) {
    const { top, right, bottom, left } = context.safeAreaInsets;
    document.documentElement.style.setProperty("--safe-top", `${Math.max(0, top)}px`);
    document.documentElement.style.setProperty("--safe-right", `${Math.max(0, right)}px`);
    document.documentElement.style.setProperty("--safe-bottom", `${Math.max(0, bottom)}px`);
    document.documentElement.style.setProperty("--safe-left", `${Math.max(0, left)}px`);
  }
}

function formatEtaLabel(value: number | null): string {
  if (value === null) {
    return "Sin dato";
  }
  if (value <= 0) {
    return "Llegando";
  }
  if (value === 1) {
    return "En 1 minuto";
  }
  return `En ${value} minutos`;
}

function formatAbsoluteTime(value: number | null): string {
  if (value === null) {
    return "";
  }
  return formatClockTime(new Date(Date.now() + value * 60_000));
}

function formatClockTime(date: Date): string {
  return new Intl.DateTimeFormat(appLocale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(appTimeZone ? { timeZone: appTimeZone } : {}),
  }).format(date);
}

function parseSearchPayload(raw: unknown): SearchToolPayload | null {
  if (!isRecord(raw) || !isNonNegativeInteger(raw.total) || !Array.isArray(raw.stops)) {
    return null;
  }
  if (raw.stops.length > 1_000) {
    return null;
  }
  const stops: StopSummary[] = [];
  for (const candidate of raw.stops) {
    if (!isStopSummary(candidate)) {
      return null;
    }
    stops.push(candidate);
  }
  if (raw.total !== stops.length) {
    return null;
  }
  return {
    total: raw.total,
    stops,
  };
}

function parseArrivalsPayload(raw: unknown): ArrivalsToolPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.stop !== null && !isStopSummary(raw.stop)) {
    return null;
  }
  if (raw.arrivals !== null && !isArrivalsResponse(raw.arrivals)) {
    return null;
  }
  if (raw.message !== undefined && (typeof raw.message !== "string" || raw.message.length > 500)) {
    return null;
  }
  const stop = raw.stop as StopSummary | null;
  const arrivals = raw.arrivals as ArrivalsResponse | null;
  if (stop && arrivals && stop.id !== arrivals.stop_id) {
    return null;
  }
  return {
    stop,
    arrivals,
    message: raw.message as string | undefined,
  };
}

function isArrivalsResponse(value: unknown): value is ArrivalsResponse {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.stop_id) ||
    !Array.isArray(value.lines) ||
    !isIsoDateString(value.fetched_at) ||
    (value.source !== "live" && value.source !== "cache" && value.source !== "stale")
  ) {
    return false;
  }
  return value.lines.length <= 100 && value.lines.every(isLineArrivals);
}

function isLineArrivals(value: unknown): value is LineArrivals {
  if (!isRecord(value) || !isPositiveInteger(value.line_id) || !Array.isArray(value.buses)) {
    return false;
  }
  if (
    value.line_name !== null &&
    (typeof value.line_name !== "string" || value.line_name.length > 300)
  ) {
    return false;
  }
  if (value.color_hex !== null && !isSafeHexColor(value.color_hex)) {
    return false;
  }
  return value.buses.length <= 100 && value.buses.every(isArrivalBus);
}

function isArrivalBus(value: unknown): value is ArrivalBus {
  if (!isRecord(value) || !isNonNegativeInteger(value.bus_id)) {
    return false;
  }
  return (
    isNullableIntegerInRange(value.eta_minutes, 0, 1_000_000) &&
    isNullableIntegerInRange(value.distance_meters, 0, 1_000_000_000) &&
    isNullableInteger(value.status) &&
    isNullableNonNegativeInteger(value.last_stop_id)
  );
}

function isStopSummary(value: unknown): value is StopSummary {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 300 ||
    !isFiniteNumber(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    !isFiniteNumber(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    !Array.isArray(value.lines) ||
    value.lines.length > 100
  ) {
    return false;
  }
  return value.lines.every(isPositiveInteger);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && Number.isSafeInteger(value));
}

function isNullableIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return (
    value === null ||
    (isFiniteNumber(value) &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum)
  );
}

function isSafeHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isValidLocale(locale: string): boolean {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length === 1;
  } catch {
    return false;
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
