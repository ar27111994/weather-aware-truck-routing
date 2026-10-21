/**
 * A MapLibre test double for jsdom (no WebGL): it records sources, layers, filters, paint,
 * feature-state, images, camera calls and markers, and lets a test fire map events. Tests load it
 * with `vi.mock("maplibre-gl", () => import("<path>/test/fake-maplibre"))`.
 */

type Listener = (event: FakeEvent) => void;

/** What a fired event carries (a subset of MapLibre's event objects). */
export interface FakeEvent {
  readonly type: string;
  readonly features?: readonly FakeFeature[];
  readonly originalEvent?: unknown;
  readonly lngLat?: { readonly lng: number; readonly lat: number };
}

/** A rendered feature as a layer event reports it. */
export interface FakeFeature {
  readonly id?: number | string;
  readonly properties: Readonly<Record<string, unknown>>;
}

interface Registration {
  readonly type: string;
  readonly layer: string | undefined;
  readonly listener: Listener;
  readonly once: boolean;
}

/** A style layer as the fake stores it. */
export interface FakeLayer {
  readonly id: string;
  readonly type: string;
  readonly source?: string;
  readonly "source-layer"?: string;
  filter?: unknown;
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
}

/** A GeoJSON source as the fake stores it. */
export interface FakeSource {
  readonly type: string;
  data: unknown;
  readonly options: Readonly<Record<string, unknown>>;
  setDataCalls: number;
  setData: (data: unknown) => FakeSource;
}

/** Every map the fake constructed, in order (the newest last). */
export const fakeMaps: FakeMap[] = [];
/** Every marker the fake constructed, in order. */
export const fakeMarkers: FakeMarker[] = [];
/** URLs passed to {@link setWorkerUrl}. */
export const workerUrls: string[] = [];
/**
 * What the next `Map` constructor throws instead of building a map (a browser without WebGL 2
 * makes MapLibre throw {@link GPUInitializationError}); `undefined` builds it.
 */
export const fakeFailures: { construct: Error | undefined } = { construct: undefined };

/** Forgets every map and marker (call in `beforeEach`). */
export function resetFakes(): void {
  fakeMaps.length = 0;
  fakeMarkers.length = 0;
  workerUrls.length = 0;
  fakeFailures.construct = undefined;
}

/** MapLibre's error for a map that cannot get a WebGL 2 context. */
export class GPUInitializationError extends Error {
  readonly requestedAttributes: WebGLContextAttributes;
  readonly statusMessage: string | null;

  constructor(
    requestedAttributes: WebGLContextAttributes,
    creationEvent: WebGLContextEvent | null,
  ) {
    super("Failed to initialize WebGL");
    this.name = "GPUInitializationError";
    this.requestedAttributes = requestedAttributes;
    this.statusMessage = creationEvent?.statusMessage ?? null;
  }
}

/** Records the worker URL, like MapLibre's `setWorkerUrl`. */
export function setWorkerUrl(url: string): void {
  workerUrls.push(url);
}

/** A stand-in for MapLibre's `Map`. */
export class FakeMap {
  readonly options: Readonly<Record<string, unknown>>;
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The basemap's own layers (set by {@link loadStyle}); ours are appended to `layers`. */
  layers: FakeLayer[] = [];
  sources = new Map<string, FakeSource>();
  images = new Map<string, { readonly image: unknown; readonly options: unknown }>();
  featureState = new Map<string, Record<string, unknown>>();
  featureStateWrites = 0;
  styleUrl: unknown;
  styleOptions: unknown;
  styleLoaded = false;
  removed = false;
  resizeCalls = 0;
  zoom = 5;
  readonly cameraCalls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  readonly controls: { readonly control: unknown; readonly position: unknown }[] = [];
  readonly paintCalls: {
    readonly layer: string;
    readonly property: string;
    readonly value: unknown;
  }[] = [];
  private registrations: Registration[] = [];

  constructor(options: Record<string, unknown>) {
    if (fakeFailures.construct) throw fakeFailures.construct;
    this.options = options;
    this.container = options["container"] as HTMLElement;
    this.styleUrl = options["style"];
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "Map");
    this.canvas.setAttribute("role", "region");
    this.canvas.tabIndex = 0;
    this.container.append(this.canvas);
    fakeMaps.push(this);
  }

  // Events --------------------------------------------------------------------------------------

  on(type: string, layerOrListener: string | Listener, maybeListener?: Listener): this {
    if (typeof layerOrListener === "string") {
      if (maybeListener)
        this.registrations.push({
          type,
          layer: layerOrListener,
          listener: maybeListener,
          once: false,
        });
    } else {
      this.registrations.push({ type, layer: undefined, listener: layerOrListener, once: false });
    }
    return this;
  }

  off(type: string, layerOrListener: string | Listener, maybeListener?: Listener): this {
    const layer = typeof layerOrListener === "string" ? layerOrListener : undefined;
    const listener = typeof layerOrListener === "string" ? maybeListener : layerOrListener;
    this.registrations = this.registrations.filter(
      (registration) =>
        !(
          registration.type === type &&
          registration.layer === layer &&
          registration.listener === listener
        ),
    );
    return this;
  }

  /** How many listeners are registered (a leak check after cleanup). */
  listenerCount(): number {
    return this.registrations.length;
  }

  /** Calls `listener` on the next `type` event only, like MapLibre's `once`. */
  once(type: string, listener: Listener): this {
    this.registrations.push({ type, layer: undefined, listener, once: true });
    return this;
  }

  /** Fires `type` (on `layer` when given) with `event` fields. */
  fire(type: string, event: Omit<FakeEvent, "type"> = {}, layer?: string): void {
    for (const registration of [...this.registrations]) {
      if (registration.type === type && registration.layer === layer) {
        if (registration.once) {
          this.registrations = this.registrations.filter((other) => other !== registration);
        }
        registration.listener({ type, ...event });
      }
    }
  }

  /** Completes a style load with `layers` as the basemap, then fires `style.load`. */
  loadStyle(layers: readonly Omit<FakeLayer, "paint" | "layout">[] = []): void {
    this.layers = layers.map((layer) => ({ ...layer, paint: {}, layout: {} }));
    this.sources.clear();
    this.images.clear();
    this.featureState.clear();
    this.styleLoaded = true;
    this.fire("style.load");
  }

  // Style ---------------------------------------------------------------------------------------

  setStyle(style: unknown, options?: unknown): this {
    this.styleUrl = style;
    this.styleOptions = options;
    this.styleLoaded = false;
    return this;
  }

  isStyleLoaded(): boolean {
    return this.styleLoaded;
  }

  getStyle(): { readonly layers: FakeLayer[] } {
    return { layers: this.layers };
  }

  addSource(id: string, source: Record<string, unknown>): this {
    if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}".`);
    const created: FakeSource = {
      type: String(source["type"]),
      data: source["data"],
      options: source,
      setDataCalls: 0,
      setData: (data) => {
        created.data = data;
        created.setDataCalls += 1;
        return created;
      },
    };
    this.sources.set(id, created);
    return this;
  }

  getSource(id: string): FakeSource | undefined {
    return this.sources.get(id);
  }

  removeSource(id: string): this {
    this.sources.delete(id);
    return this;
  }

  addLayer(layer: Record<string, unknown>, beforeId?: string): this {
    const id = String(layer["id"]);
    if (this.layers.some((existing) => existing.id === id)) {
      throw new Error(`Layer "${id}" already exists.`);
    }
    const source = layer["source"];
    if (typeof source === "string" && !this.sources.has(source)) {
      throw new Error(`Source "${source}" not found.`);
    }
    const stored: FakeLayer = {
      id,
      type: String(layer["type"]),
      ...(typeof source === "string" ? { source } : {}),
      filter: layer["filter"],
      paint: { ...((layer["paint"] as Record<string, unknown> | undefined) ?? {}) },
      layout: { ...((layer["layout"] as Record<string, unknown> | undefined) ?? {}) },
    };
    const index =
      beforeId === undefined ? -1 : this.layers.findIndex((existing) => existing.id === beforeId);
    if (index === -1) this.layers.push(stored);
    else this.layers.splice(index, 0, stored);
    return this;
  }

  getLayer(id: string): FakeLayer | undefined {
    return this.layers.find((layer) => layer.id === id);
  }

  removeLayer(id: string): this {
    this.requireLayer(id);
    this.layers = this.layers.filter((layer) => layer.id !== id);
    return this;
  }

  /** Ids of every layer, bottom to top. */
  layerIds(): string[] {
    return this.layers.map((layer) => layer.id);
  }

  setFilter(id: string, filter: unknown): this {
    const layer = this.requireLayer(id);
    layer.filter = filter;
    return this;
  }

  setPaintProperty(id: string, property: string, value: unknown): this {
    this.requireLayer(id).paint[property] = value;
    this.paintCalls.push({ layer: id, property, value });
    return this;
  }

  setLayoutProperty(id: string, property: string, value: unknown): this {
    this.requireLayer(id).layout[property] = value;
    return this;
  }

  private requireLayer(id: string): FakeLayer {
    const layer = this.getLayer(id);
    if (!layer) throw new Error(`The layer '${id}' does not exist in the map's style.`);
    return layer;
  }

  // Feature state -------------------------------------------------------------------------------

  setFeatureState(
    target: { readonly source: string; readonly id?: number | string },
    state: Record<string, unknown>,
  ): void {
    if (!this.sources.has(target.source))
      throw new Error(`The source '${target.source}' does not exist.`);
    const key = `${target.source}/${String(target.id)}`;
    this.featureState.set(key, { ...this.featureState.get(key), ...state });
    this.featureStateWrites += 1;
  }

  removeFeatureState(
    target: { readonly source: string; readonly id?: number | string },
    key?: string,
  ): void {
    const stateKey = `${target.source}/${String(target.id)}`;
    const current = this.featureState.get(stateKey);
    if (!current) return;
    if (key === undefined) {
      this.featureState.delete(stateKey);
      return;
    }
    this.featureState.set(
      stateKey,
      Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)),
    );
  }

  getFeatureState(target: {
    readonly source: string;
    readonly id?: number | string;
  }): Record<string, unknown> {
    return this.featureState.get(`${target.source}/${String(target.id)}`) ?? {};
  }

  // Images --------------------------------------------------------------------------------------

  addImage(id: string, image: unknown, options?: unknown): this {
    if (this.images.has(id)) throw new Error(`An image named "${id}" already exists.`);
    this.images.set(id, { image, options });
    return this;
  }

  hasImage(id: string): boolean {
    return this.images.has(id);
  }

  removeImage(id: string): void {
    this.images.delete(id);
  }

  // Camera and lifecycle ------------------------------------------------------------------------

  fitBounds(...args: unknown[]): this {
    this.cameraCalls.push({ method: "fitBounds", args });
    return this;
  }

  easeTo(...args: unknown[]): this {
    this.cameraCalls.push({ method: "easeTo", args });
    return this;
  }

  jumpTo(...args: unknown[]): this {
    this.cameraCalls.push({ method: "jumpTo", args });
    return this;
  }

  getZoom(): number {
    return this.zoom;
  }

  project(lngLat: readonly [number, number] | { readonly lng: number; readonly lat: number }): {
    x: number;
    y: number;
  } {
    const [lng, lat] = "lng" in lngLat ? [lngLat.lng, lngLat.lat] : lngLat;
    return { x: lng * 10, y: lat * 10 };
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  addControl(control: unknown, position?: unknown): this {
    this.controls.push({ control, position });
    return this;
  }

  resize(): this {
    this.resizeCalls += 1;
    return this;
  }

  remove(): void {
    this.removed = true;
    this.canvas.remove();
  }
}

/** A stand-in for MapLibre's `Marker`. */
export class FakeMarker {
  readonly element: HTMLElement;
  readonly options: Readonly<Record<string, unknown>>;
  lngLat: readonly [number, number] | undefined;
  map: FakeMap | undefined;
  removed = false;
  moves = 0;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.element = options["element"] as HTMLElement;
    fakeMarkers.push(this);
  }

  setLngLat(lngLat: readonly [number, number]): this {
    this.lngLat = lngLat;
    this.moves += 1;
    return this;
  }

  addTo(map: FakeMap): this {
    this.map = map;
    map.getContainer().append(this.element);
    return this;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  remove(): this {
    this.removed = true;
    this.element.remove();
    return this;
  }
}

/** A stand-in for MapLibre's controls: they only need to be constructible. */
export class NavigationControl {
  readonly options: unknown;
  constructor(options?: unknown) {
    this.options = options;
  }
}

/** See {@link NavigationControl}. */
export class AttributionControl {
  readonly options: unknown;
  constructor(options?: unknown) {
    this.options = options;
  }
}

export { FakeMap as Map, FakeMarker as Marker };
