import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildVectorStyle, LABEL_ANCHOR_LAYER, LABEL_FONT } from '../src/lib/mapStyle.ts';
import type { MapLayer } from '../src/lib/types.ts';

function vectorLayer(ids: string[], overrides: Partial<MapLayer> = {}): MapLayer {
  return {
    id: 7,
    name: 'test.mbtiles',
    kind: 'mbtiles',
    visible: 1,
    is_default: 1,
    file_name: 'test.mbtiles',
    tile_count: 10,
    created_at: 0,
    min_zoom: 0,
    max_zoom: 14,
    fileInfo: {
      tileCount: 10,
      format: 'pbf',
      isVector: true,
      minzoom: 0,
      maxzoom: 14,
      vectorLayers: ids.map((id) => ({ id })),
    },
    ...overrides,
  } as MapLayer;
}

type StyleLayer = {
  id: string;
  type: string;
  'source-layer'?: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

const layersOf = (style: unknown) => (style as { layers: StyleLayer[] }).layers;

const OMT_LAYERS = [
  'water',
  'waterway',
  'landcover',
  'landuse',
  'park',
  'boundary',
  'aeroway',
  'transportation',
  'building',
  'place',
  'poi',
  'water_name',
  'transportation_name',
  'aerodrome_label',
  'mountain_peak',
  'housenumber',
];

test('an OpenMapTiles file gets a real cartographic style instead of generic dots', () => {
  const style = buildVectorStyle(vectorLayer(OMT_LAYERS));
  const layers = layersOf(style);

  // Text-only layers must not turn into meaningless dot layers.
  const dots = layers.filter((l) => l.type === 'circle' && l.id !== LABEL_ANCHOR_LAYER);
  assert.deepEqual(dots, []);

  const water = layers.find((l) => l.id === 'water');
  assert.equal(water?.type, 'fill');
  assert.equal(water?.['source-layer'], 'water');

  const casing = layers.find((l) => l.id === 'road-casing-motorway');
  const motorway = layers.find((l) => l.id === 'road-motorway');
  assert.equal(casing?.type, 'line');
  assert.equal(motorway?.type, 'line');
  // حاشیه پیش از بدنه رسم می‌شود تا ضخیم‌تر و زیر آن بماند.
  assert.ok(layers.indexOf(casing!) < layers.indexOf(motorway!));

  const building = layers.find((l) => l.id === 'building');
  assert.equal(building?.type, 'fill');

  // برچسب‌ها فقط از یک لایهٔ نامرئی لنگر می‌گیرند.
  const anchor = layers.find((l) => l.id === LABEL_ANCHOR_LAYER);
  assert.equal(anchor?.type, 'circle');
  assert.equal(anchor?.paint?.['circle-opacity'], 0.01);
});

test('layers missing from the file are not referenced by the style', () => {
  const style = buildVectorStyle(vectorLayer(['water', 'transportation']));
  const ids = layersOf(style).map((l) => l.id);
  assert.ok(ids.includes('water'));
  assert.ok(ids.includes('road-motorway'));
  assert.ok(!ids.includes('building'));
  assert.ok(!ids.includes(LABEL_ANCHOR_LAYER));
});

test('street and POI labels use locally bundled SDF glyphs', async () => {
  const style = buildVectorStyle(vectorLayer(OMT_LAYERS)) as {
    glyphs?: string;
    layers: StyleLayer[];
  };
  assert.equal(style.glyphs, '/glyphs/{fontstack}/{range}.pbf');

  const street = style.layers.find((l) => l.id === 'street-name');
  const poi = style.layers.find((l) => l.id === 'poi-name');
  assert.equal(street?.type, 'symbol');
  assert.equal(street?.['source-layer'], 'transportation_name');
  assert.equal(poi?.type, 'symbol');
  assert.equal(poi?.['source-layer'], 'poi');
  // نام فارسی بر نام پیش‌فرض مقدم است و هر دو به فونت محلی اشاره می‌کنند.
  for (const layer of [street, poi]) {
    assert.deepEqual(layer?.layout?.['text-font'], [LABEL_FONT]);
    assert.deepEqual(layer?.layout?.['text-field'], ['coalesce', ['get', 'name:fa'], ['get', 'name']]);
  }
  assert.equal(street?.layout?.['symbol-placement'], 'line');

  // فایل‌های گلیف باید واقعاً در پروژه موجود باشند: بازهٔ لاتین، حروف عربی/فارسی
  // و اَشکال نمایشی که MapLibre پیش از رسم می‌سازد.
  for (const range of ['0-255', '1536-1791', '65024-65279']) {
    const stat = await fs.stat(new URL(`../public/glyphs/${LABEL_FONT}/${range}.pbf`, import.meta.url));
    assert.ok(stat.size > 100, `glyph range ${range} is empty`);
  }
});

test('an unknown schema still yields a usable, muted map', () => {
  const style = buildVectorStyle(vectorLayer(['roads', 'blocks']));
  const layers = layersOf(style);
  assert.equal(layers[0].type, 'background');
  const fallback = layers.filter((l) => l.id.startsWith('fallback-'));
  assert.deepEqual(fallback.map((l) => l.id).sort(), [
    'fallback-fill-blocks',
    'fallback-fill-roads',
    'fallback-line-blocks',
    'fallback-line-roads',
  ]);
  for (const layer of fallback) assert.equal(layer['source-layer'], layer.id.split('-').pop());
  // استایل همیشه فقط به یک منبع برداری ارجاع می‌دهد.
  const sources = (style as unknown as { sources: Record<string, { tiles: string[] }> }).sources;
  assert.deepEqual(Object.keys(sources), ['netwatch']);
  assert.match(sources.netwatch.tiles[0], /\/api\/tiles\/7\/\{z\}\/\{x\}\/\{y\}\.pbf$/);
});
