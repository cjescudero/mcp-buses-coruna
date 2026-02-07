import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
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
}

interface SearchToolPayload {
  total: number;
  stops: StopSummary[];
  primaryStopId?: number;
}

interface ArrivalsToolPayload {
  primaryStopId: number;
  stop: StopSummary | null;
  arrivals: ArrivalsResponse | null;
  message?: string;
}

interface ToolResultLike {
  structuredContent?: unknown;
}

const app = new App({
  name: "Buses A Coruna MCP App",
  version: "1.0.0",
});

const searchInput = document.getElementById("stop-search") as HTMLInputElement | null;
const resultsList = document.getElementById("stop-results") as HTMLUListElement | null;
const currentStopLabel = document.getElementById("current-stop-label");
const homeButton = document.getElementById("home-button") as HTMLButtonElement | null;
const stopNameEl = document.getElementById("stop-name");
const stopHelperEl = document.getElementById("stop-helper");
const arrivalsEl = document.getElementById("arrivals");
const statusEl = document.getElementById("status");
const nextArrivalsEl = document.getElementById("next-arrivals");

let primaryStopId = 42;
let currentStopId = 42;
let allStops: StopSummary[] = [];
let filteredStops: StopSummary[] = [];
let refreshTimer: number | undefined;
let nextShownMap = new Map<number, number>();
let hasRenderedArrivals = false;

searchInput?.addEventListener("input", handleSearchInput);
searchInput?.addEventListener("keydown", handleSearchKeydown);
resultsList?.addEventListener("click", handleResultClick);
homeButton?.addEventListener("click", () => {
  const stop = findStopById(primaryStopId) ?? {
    id: primaryStopId,
    name: `Parada ${primaryStopId}`,
    latitude: 0,
    longitude: 0,
    lines: [],
  };
  void selectStop(stop);
});

app.ontoolresult = (result) => {
  applyToolResult(result as ToolResultLike);
};

app.onhostcontextchanged = (context) => {
  if (context.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
  if (context.safeAreaInsets) {
    const { top, right, bottom, left } = context.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
};

app.onteardown = async () => {
  clearRefreshTimer();
  return {};
};

void initialize();

async function initialize(): Promise<void> {
  setStatus("Conectando con el servidor MCP...");
  try {
    await app.connect();
    setStatus("Cargando paradas...");
    await bootstrapStops();
    if (!hasRenderedArrivals) {
      await loadArrivals(currentStopId);
    }
  } catch {
    setStatus("No se pudo conectar con el servidor MCP.");
  }
}

function applyToolResult(result: ToolResultLike): void {
  const searchPayload = parseSearchPayload(result.structuredContent);
  if (searchPayload) {
    applySearchPayload(searchPayload);
    return;
  }

  const arrivalsPayload = parseArrivalsPayload(result.structuredContent);
  if (!arrivalsPayload) {
    return;
  }

  hasRenderedArrivals = true;
  primaryStopId = arrivalsPayload.primaryStopId;
  if (arrivalsPayload.stop) {
    currentStopId = arrivalsPayload.stop.id;
    updateCurrentStopLabel(arrivalsPayload.stop);
    updateStopSummary(arrivalsPayload.stop);
  } else {
    showUnavailableState(arrivalsPayload.message ?? "stop_not_found");
    return;
  }

  if (!arrivalsPayload.arrivals) {
    renderArrivalError(arrivalsPayload.message ?? "transit_api_unavailable");
    return;
  }

  renderNextArrivals(arrivalsPayload.arrivals);
  renderArrivals(arrivalsPayload.arrivals);
  setStatus(
    `Actualizado a las ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`,
  );
}

async function bootstrapStops(): Promise<void> {
  try {
    const result = (await app.callServerTool({
      name: "search_stops",
      arguments: { limit: 400 },
    })) as ToolResultLike;
    const payload = parseSearchPayload(result.structuredContent);
    if (payload) {
      applySearchPayload(payload);
    }
  } catch {
    setStatus("No se pudo cargar el listado de paradas.");
  }
}

function applySearchPayload(payload: SearchToolPayload): void {
  if (typeof payload.primaryStopId === "number") {
    primaryStopId = payload.primaryStopId;
    if (!hasRenderedArrivals) {
      currentStopId = primaryStopId;
    }
  }
  allStops = [...payload.stops].sort((a, b) => a.name.localeCompare(b.name, "es"));
  filteredStops = allStops;
  updateCurrentStopLabel(
    findStopById(currentStopId) ?? {
      id: currentStopId,
      name: `Parada ${currentStopId}`,
      latitude: 0,
      longitude: 0,
      lines: [],
    },
  );
}

function handleSearchInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const value = target.value.trim().toLowerCase();
  if (!allStops.length) {
    return;
  }
  filteredStops = value
    ? allStops.filter(
        (stop) =>
          stop.name.toLowerCase().includes(value) || String(stop.id).includes(value),
      )
    : allStops;
  renderResults(filteredStops.slice(0, 4));
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (!resultsList || !resultsList.children.length) {
    return;
  }
  const options = Array.from(resultsList.children) as HTMLLIElement[];
  const currentIndex = options.findIndex(
    (item) => item.getAttribute("aria-selected") === "true",
  );

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
    setActiveOption(options, nextIndex);
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
    setActiveOption(options, prevIndex);
  }

  if (event.key === "Enter" && currentIndex >= 0) {
    event.preventDefault();
    const stopId = Number(options[currentIndex].dataset.stopId);
    const stop = findStopById(stopId);
    if (stop) {
      void selectStop(stop);
      clearSearchResults();
    }
  }
}

function handleResultClick(event: Event): void {
  const target = event.target as HTMLElement;
  const listItem = target.closest("li[data-stop-id]") as HTMLLIElement | null;
  if (!listItem) {
    return;
  }
  const stopId = Number(listItem.dataset.stopId);
  const stop = findStopById(stopId);
  if (stop) {
    void selectStop(stop);
    clearSearchResults();
  }
}

function renderResults(stops: StopSummary[]): void {
  if (!resultsList) {
    return;
  }
  resultsList.innerHTML = "";
  if (!stops.length) {
    const item = document.createElement("li");
    item.textContent = "Sin resultados";
    item.setAttribute("aria-disabled", "true");
    resultsList.appendChild(item);
    resultsList.style.display = "block";
    return;
  }

  stops.forEach((stop, index) => {
    const item = document.createElement("li");
    item.dataset.stopId = String(stop.id);
    item.role = "option";
    item.setAttribute("aria-selected", index === 0 ? "true" : "false");
    item.innerHTML = `<strong>${stop.id} - ${stop.name}</strong>`;
    resultsList.appendChild(item);
  });
  resultsList.style.display = "block";
}

function setActiveOption(options: HTMLLIElement[], index: number): void {
  options.forEach((item, idx) => {
    item.setAttribute("aria-selected", idx === index ? "true" : "false");
    if (idx === index) {
      item.scrollIntoView({ block: "nearest" });
    }
  });
  if (resultsList) {
    resultsList.style.display = "block";
  }
}

function findStopById(stopId: number): StopSummary | undefined {
  return allStops.find((stop) => stop.id === stopId);
}

async function selectStop(stop: StopSummary): Promise<void> {
  currentStopId = stop.id;
  if (searchInput) {
    searchInput.value = "";
  }
  clearSearchResults();
  updateCurrentStopLabel(stop);
  await loadArrivals(currentStopId, { manual: true });
}

async function loadArrivals(
  stopId: number,
  options: { manual?: boolean } = {},
): Promise<void> {
  const { manual = false } = options;
  setStatus(manual ? "Actualizando bajo pedido..." : "Buscando datos frescos...");
  clearRefreshTimer();

  try {
    const result = (await app.callServerTool({
      name: "show_bus_arrivals",
      arguments: { stopId },
    })) as ToolResultLike;

    applyToolResult(result);
  } catch {
    renderArrivalError("transit_api_unavailable");
  } finally {
    refreshTimer = window.setTimeout(() => {
      void loadArrivals(currentStopId);
    }, 45_000);
  }
}

function renderNextArrivals(arrivals: ArrivalsResponse): void {
  if (!nextArrivalsEl) {
    return;
  }
  nextArrivalsEl.innerHTML = "";
  nextShownMap = new Map<number, number>();

  const upcoming: { line: LineArrivals; bus: ArrivalBus }[] = [];
  for (const line of arrivals.lines) {
    const nextBus = line.buses.find((bus) => typeof bus.eta_minutes === "number");
    if (nextBus) {
      upcoming.push({ line, bus: nextBus });
    }
  }

  if (!upcoming.length) {
    nextArrivalsEl.innerHTML = '<div class="empty-state">Sin llegadas próximas.</div>';
    return;
  }

  upcoming
    .sort((a, b) => toSortableEta(a.bus.eta_minutes) - toSortableEta(b.bus.eta_minutes))
    .slice(0, 4)
    .forEach((item) => {
      const card = document.createElement("div");
      card.className = "next-card-item";
      if (item.line.color_hex) {
        card.style.setProperty("--line-color", item.line.color_hex);
      }
      const lineName = item.line.line_name ?? `Línea ${item.line.line_id}`;
      const relative = formatEtaLabel(item.bus.eta_minutes);
      const absolute = formatAbsoluteTime(item.bus.eta_minutes);
      card.innerHTML = `
        <div class="next-line">${lineName}</div>
        <div class="next-time">${relative}</div>
        <div class="next-absolute">${absolute}</div>
      `;
      nextArrivalsEl.appendChild(card);
      nextShownMap.set(item.line.line_id, item.bus.bus_id);
    });
}

function renderArrivals(arrivals: ArrivalsResponse): void {
  if (!arrivalsEl) {
    return;
  }
  arrivalsEl.innerHTML = "";

  if (!arrivals.lines.length) {
    arrivalsEl.innerHTML = '<div class="empty-state">Sin datos para las líneas configuradas.</div>';
    return;
  }

  arrivals.lines.forEach((line) => {
    const card = document.createElement("div");
    card.className = "line-card";
    if (line.color_hex) {
      card.style.setProperty("--line-color", line.color_hex);
    }

    const title = document.createElement("div");
    title.className = "line-title";
    title.textContent = line.line_name ?? `Línea ${line.line_id}`;
    card.appendChild(title);

    const busContainer = document.createElement("div");
    busContainer.className = "bus-times";
    let hasDisplayed = false;

    line.buses.forEach((bus) => {
      if (nextShownMap.get(line.line_id) === bus.bus_id) {
        return;
      }
      const badge = document.createElement("div");
      badge.className = "badge";
      const relative = formatEtaLabel(bus.eta_minutes);
      const absolute = formatAbsoluteTime(bus.eta_minutes);
      badge.innerHTML = `${relative}${absolute ? `<span>${absolute}</span>` : ""}`;
      busContainer.appendChild(badge);
      hasDisplayed = true;
    });

    if (!line.buses.length || !hasDisplayed) {
      const empty = document.createElement("div");
      empty.className = "badge";
      empty.textContent = "Sin buses en ruta";
      busContainer.appendChild(empty);
    }

    card.appendChild(busContainer);
    arrivalsEl.appendChild(card);
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
        ? `Mostrando ${lineCount} línea${lineCount === 1 ? "" : "s"} configuradas`
        : "Sin líneas configuradas para esta parada";
  }
}

function showUnavailableState(reason: string): void {
  if (nextArrivalsEl) {
    nextArrivalsEl.innerHTML = '<div class="empty-state">No se encontró la parada solicitada.</div>';
  }
  if (arrivalsEl) {
    arrivalsEl.innerHTML = '<div class="empty-state">Selecciona otra parada para continuar.</div>';
  }
  if (stopNameEl) {
    stopNameEl.textContent = `Parada no disponible (${reason})`;
  }
  if (stopHelperEl) {
    stopHelperEl.textContent = "Sin datos";
  }
  setStatus("No se encontró la parada.");
}

function renderArrivalError(reason: string): void {
  if (nextArrivalsEl) {
    nextArrivalsEl.innerHTML = '<div class="empty-state">No se pudo conectar con el servicio.</div>';
  }
  if (arrivalsEl) {
    arrivalsEl.innerHTML = '<div class="empty-state">No hay datos disponibles en este momento.</div>';
  }
  setStatus(`No se pudo actualizar (${reason}).`);
}

function updateCurrentStopLabel(stop: StopSummary): void {
  if (!currentStopLabel) {
    return;
  }
  currentStopLabel.innerHTML = `<span>Parada seleccionada:</span> <strong>${stop.id} - ${stop.name}</strong>`;
}

function clearSearchResults(): void {
  if (!resultsList) {
    return;
  }
  resultsList.innerHTML = "";
  resultsList.style.display = "none";
}

function clearRefreshTimer(): void {
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function formatEtaLabel(value: number | null): string {
  if (typeof value !== "number") {
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
  if (typeof value !== "number") {
    return "";
  }
  const arrival = new Date(Date.now() + value * 60_000);
  return arrival.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toSortableEta(value: number | null): number {
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

function parseSearchPayload(raw: unknown): SearchToolPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (!Array.isArray(raw.stops) || typeof raw.total !== "number") {
    return null;
  }

  const stops = raw.stops.filter(isStopSummary);
  return {
    total: raw.total,
    stops,
    primaryStopId: typeof raw.primaryStopId === "number" ? raw.primaryStopId : undefined,
  };
}

function parseArrivalsPayload(raw: unknown): ArrivalsToolPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.primaryStopId !== "number") {
    return null;
  }

  const stop = isStopSummary(raw.stop) ? raw.stop : null;
  const arrivals = isArrivalsResponse(raw.arrivals) ? raw.arrivals : null;
  const message = typeof raw.message === "string" ? raw.message : undefined;

  return {
    primaryStopId: raw.primaryStopId,
    stop,
    arrivals,
    message,
  };
}

function isArrivalsResponse(value: unknown): value is ArrivalsResponse {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.stop_id === "number" && Array.isArray(value.lines);
}

function isStopSummary(value: unknown): value is StopSummary {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "number" && typeof value.name === "string" && Array.isArray(value.lines);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
