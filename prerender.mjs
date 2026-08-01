// scripts/prerender.mjs
// Genera HTML estatico indexable por Google, GPTBot, ClaudeBot y PerplexityBot.
// Fuente de datos: vera-os (properties + property_images). La CRM vieja
// (varela-crm) queda obsoleta para este script.
//
// Produce:
//   /propiedades/index.html                  -> hub CollectionPage + ItemList
//   /propiedades/<slug>-<codigo>/index.html  -> ficha + RealEstateListing
//   /sitemap.xml
//
// NOTA: no consulta ni publica owner_id / owner_observations.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SUPABASE_URL = 'https://tlptpyhtddwaiwzmzgcg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_WMr3U_Vq_jcXqIZ8H_ecfw_2w8c7D7n';
const SITE = 'https://www.varelapropiedadescde.com.ar';
const WA_VENTAS = '5492246586030';

// Columnas publicas explicitas de vera-os. NO usar select=*.
const COLS = [
  'id', 'legacy_id', 'codigo', 'title', 'type', 'operation', 'status', 'price',
  'address', 'city', 'province', 'rooms', 'bedrooms', 'bathrooms',
  'area_m2', 'lot_area_m2', 'semi_covered_area_m2', 'floors',
  'amenities', 'description', 'radar', 'created_at',
  'property_images(bucket,object_path,position)'
].join(',');

// Mapeo de taxonomia nueva -> shape viejo que usa el resto del script,
// para no tocar la generacion de HTML/JSON-LD de mas abajo.
const TYPE_LABEL = { casa: 'Casa', terreno: 'Terreno / Lote', departamento: 'Departamento', ph: 'PH', duplex: 'Duplex', local: 'Local comercial', galpon: 'Local comercial' };
const OP_LABEL = { venta: 'Venta', alquiler: 'Alquiler' };
const STATUS_LABEL = { active: 'Disponible', reserved: 'Reservada', sold: 'Vendida' };
const photoUrl = img => `${SUPABASE_URL}/storage/v1/object/public/${img.bucket}/${img.object_path}`;
// En vera-os estos campos son 0 (no null) cuando no aplican (p.ej. ambientes en un terreno).
const z = v => (v === 0 ? undefined : v);

function normalizarPropiedad(p) {
  const fotos = (p.property_images || [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(photoUrl);
  return {
    id: p.id,
    codigo: p.codigo,
    titulo: p.title,
    tipo: TYPE_LABEL[p.type] || p.type,
    operacion: OP_LABEL[p.operation] || p.operation,
    estado: STATUS_LABEL[p.status] || p.status,
    precio: p.price,
    direccion: p.address,
    ciudad: p.city,
    provincia: p.province,
    ambientes: z(p.rooms),
    dormitorios: z(p.bedrooms),
    banios: z(p.bathrooms),
    mts: p.lot_area_m2 || p.area_m2,
    mts_cubiertos: z(p.area_m2),
    mts_semicubiertos: z(p.semi_covered_area_m2),
    plantas: z(p.floors),
    amenities: p.amenities,
    descripcion: p.description,
    fotos,
    radar: p.radar,
    created_at: p.created_at
  };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const slug = s => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const fmtUSD = p => p ? 'USD ' + Number(p).toLocaleString('es-AR') : 'Consultar';

// `ciudad` viene sin normalizar: "Costa del Este" y "costa del este" conviven.
const CIUDADES = {
  'costa del este': 'Costa del Este',
  'mar del tuyu': 'Mar del Tuyu',
  'mar del tuyú': 'Mar del Tuyu',
  'aguas verdes': 'Aguas Verdes',
  'la lucila del mar': 'La Lucila del Mar',
  'san bernardo': 'San Bernardo del Tuyu'
};
const ciudadDe = p => {
  const raw = String(p.ciudad ?? '').trim();
  return CIUDADES[raw.toLowerCase()] || raw || 'Costa del Este';
};

// Los titulos vienen en formato MercadoLibre, con sufijo de marca.
// "Venta 3 Aparts con Gas Nat - Costa del Este - Inmobiliaria Varela"
const tituloDe = p => {
  let t = String(p.titulo ?? '').trim()
    .replace(/\s*[-|·]\s*Inmobiliaria\s+Varela.*$/i, '')
    .replace(/\s*[-|·]\s*Varela\s+Inmobiliaria.*$/i, '')
    .trim();
  if (!t) t = `${p.tipo || 'Propiedad'} en ${ciudadDe(p)}`;
  return t;
};

const AMEN = {
  'amenity-jardin': 'Jardin', 'amenity-deck': 'Deck', 'amenity-parrilla': 'Parrilla',
  'amenity-pileta': 'Pileta', 'amenity-cochera': 'Cochera', 'amenity-gas': 'Gas natural',
  'amenity-quincho': 'Quincho', 'amenity-galeria': 'Galeria', 'amenity-lavadero': 'Lavadero',
  'amenity-aire': 'Aire acondicionado', 'amenity-calefaccion': 'Calefaccion',
  'amenity-seguridad': 'Seguridad', 'amenity-amoblado': 'Amoblado'
};
const amenDe = p => (Array.isArray(p.amenities) ? p.amenities : [])
  .map(a => AMEN[a] || String(a).replace(/^amenity-/, '').replace(/-/g, ' ')
    .replace(/^./, c => c.toUpperCase()))
  .filter(Boolean);

const vendida = p => /vendid/i.test(p.estado || '');
const reservada = p => /reservad/i.test(p.estado || '');

// ---------- 1. Traer datos ----------
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/properties?select=${COLS}&status=in.(active,reserved,sold)&archived=eq.false&order=created_at.desc&property_images.order=position.asc`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
);
if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
const props = (await res.json()).map(normalizarPropiedad);

const activas = props.filter(p => !vendida(p));
const historial = props.filter(vendida);
console.log(`${props.length} propiedades: ${activas.length} activas, ${historial.length} vendidas`);

// ---------- 2. Helpers ----------
const urlOf = p => `${SITE}/propiedades/${slug(tituloDe(p))}-${slug(p.codigo || p.id)}/`;

// Prosa declarativa: es lo que un LLM extrae y cita. Los specs sueltos no se citan.
function resumen(p) {
  const c = ciudadDe(p);
  const out = [];
  out.push(`${p.tipo || 'Propiedad'} en ${p.operacion === 'Alquiler' ? 'alquiler' : 'venta'} en ${c}, Partido de La Costa, Provincia de Buenos Aires.`);
  const f = [];
  if (p.ambientes) f.push(`${p.ambientes} ambientes`);
  if (p.dormitorios) f.push(`${p.dormitorios} dormitorios`);
  if (p.banios) f.push(`${p.banios} banos`);
  if (p.mts_cubiertos) f.push(`${p.mts_cubiertos} m2 cubiertos`);
  if (p.mts) f.push(`${p.mts} m2 de terreno`);
  if (f.length) out.push(`Cuenta con ${f.join(', ')}.`);
  if (p.direccion) out.push(`Ubicada en ${p.direccion}, ${c}.`);
  const am = amenDe(p);
  if (am.length) out.push(`Incluye ${am.join(', ').toLowerCase()}.`);
  if (p.antiguedad) out.push(`Antiguedad: ${String(p.antiguedad).toLowerCase()}.`);
  if (vendida(p)) out.push(`Operacion cerrada por Varela Inmobiliaria. Precio de publicacion: ${fmtUSD(p.precio)}.`);
  else if (reservada(p)) out.push(`Actualmente reservada. Precio: ${fmtUSD(p.precio)}.`);
  else out.push(`Precio: ${fmtUSD(p.precio)}.`);
  return out.join(' ');
}

function specsDe(p) {
  return [
    ['Tipo', p.tipo], ['Operacion', p.operacion || 'Venta'],
    ['Ambientes', p.ambientes], ['Dormitorios', p.dormitorios], ['Banos', p.banios],
    ['Sup. cubierta', p.mts_cubiertos && `${p.mts_cubiertos} m2`],
    ['Sup. semicubierta', p.mts_semicubiertos && `${p.mts_semicubiertos} m2`],
    ['Terreno', p.mts && `${p.mts} m2`],
    ['Plantas', p.plantas], ['Antiguedad', p.antiguedad],
    ['Localidad', ciudadDe(p)], ['Codigo', p.codigo], ['Estado', p.estado]
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
}

const HEAD = ({ title, desc, canonical, image, noindex }) => `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large,max-snippet:-1'}">
<meta property="og:type" content="website">
<meta property="og:locale" content="es_AR">
<meta property="og:site_name" content="Inmobiliaria Varela CDE">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image || SITE + '/og-cover.jpg'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1E1E20">
<link rel="icon" href="/logo-varela.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,700&family=DM+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--amarillo:#D6CC6A;--bg:#1E1E20;--bg-card:#272729;--border:rgba(255,255,255,.08);--text:#fff;--text-2:rgba(255,255,255,.65);--text-3:rgba(255,255,255,.4)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);line-height:1.65}
a{color:var(--amarillo)}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px}
header{border-bottom:1px solid var(--border);padding:18px 0}
header .wrap{display:flex;align-items:center;gap:16px;justify-content:space-between;flex-wrap:wrap}
header img{height:44px}
nav a{color:var(--text-2);text-decoration:none;font-size:14px;margin-left:18px}
nav a:hover{color:var(--amarillo)}
.bc{font-size:13px;color:var(--text-3);padding:22px 0}
.bc a{color:var(--text-3);text-decoration:none}
h1{font-size:36px;line-height:1.18;letter-spacing:-.8px;margin-bottom:10px}
h2{font-size:24px;margin:38px 0 12px}
h3{font-size:17px;margin-bottom:6px}
.precio{font-family:'Playfair Display',serif;font-size:38px;color:var(--amarillo);font-weight:700;margin:14px 0}
.meta{color:var(--text-2);font-size:15px}
.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 12px;border-radius:20px;margin-bottom:12px}
.badge.v{background:rgba(255,255,255,.10);color:var(--text-2)}
.badge.r{background:rgba(214,204,106,.15);color:var(--amarillo);border:1px solid rgba(214,204,106,.3)}
.specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:26px 0;list-style:none}
.specs li{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.specs b{display:block;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:1.4px;font-weight:600}
.specs span{font-size:19px;font-weight:600}
.amen{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0;list-style:none}
.amen li{background:var(--bg-card);border:1px solid var(--border);border-radius:20px;padding:7px 16px;font-size:14px;color:var(--text-2)}
.gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:26px 0}
.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;background:var(--bg-card)}
.cta{display:inline-block;background:var(--amarillo);color:#0E0E10;font-weight:700;padding:15px 28px;border-radius:12px;text-decoration:none;margin:8px 8px 8px 0}
.cta.sec{background:transparent;color:#fff;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:15px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border)}
th{color:var(--text-3);font-weight:600;width:42%}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;margin:24px 0}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden;position:relative}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
.card.sold img{filter:grayscale(1) opacity(.55)}
.card-tag{position:absolute;top:10px;left:10px;font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;padding:5px 11px;border-radius:20px;background:rgba(0,0,0,.75);color:#fff}
.card-b{padding:16px}
.card-b a{text-decoration:none;color:#fff;font-weight:600}
.card-b a:hover{color:var(--amarillo)}
.card-p{color:var(--amarillo);font-weight:700;margin-top:6px}
.intro{color:var(--text-2);max-width:760px;margin-bottom:8px}
footer{border-top:1px solid var(--border);margin-top:64px;padding:34px 0;color:var(--text-3);font-size:13px}
footer a{color:var(--text-2)}
@media(max-width:640px){h1{font-size:26px}.precio{font-size:30px}}
</style>
</head>
<body>
<header><div class="wrap">
<a href="/"><img src="/logo-varela.svg" alt="Inmobiliaria Varela CDE"></a>
<nav>
<a href="/propiedades/">Propiedades</a>
<a href="/tasador.html">Tasar mi propiedad</a>
<a href="/#contacto">Contacto</a>
</nav>
</div></header>`;

const FOOT = `<footer><div class="wrap">
<p><strong>Inmobiliaria Varela CDE</strong> &middot; Av. Interbalnearia Interna 162, B7108 Costa del Este, Provincia de Buenos Aires.</p>
<p>Ventas <a href="https://wa.me/${WA_VENTAS}">2246 58-6030</a> &middot; Alquileres 2257 40-4000 &middot; <a href="mailto:varelavendecde@gmail.com">varelavendecde@gmail.com</a></p>
<p>Martillero Publico Jorge Varela &middot; T III F 103 N 865</p>
</div></footer>
</body></html>`;

const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

// ---------- 3. Fichas ----------
if (existsSync('propiedades')) await rm('propiedades', { recursive: true, force: true });

for (const p of props) {
  const url = urlOf(p);
  const dir = url.replace(SITE + '/', '').replace(/\/$/, '');
  const t = tituloDe(p);
  const c = ciudadDe(p);
  const fotos = Array.isArray(p.fotos) ? p.fotos : [];
  const am = amenDe(p);
  const sold = vendida(p);
  const resv = reservada(p);

  const title = `${t}${sold ? ' (Vendida)' : ''} - ${fmtUSD(p.precio)} | Varela CDE`.slice(0, 68);
  const desc = resumen(p).slice(0, 158);
  const specs = specsDe(p);

  const similares = activas
    .filter(x => x.id !== p.id && x.tipo === p.tipo && ciudadDe(x) === c)
    .slice(0, 3);

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': ['RealEstateListing', 'Product'],
      '@id': url + '#listing',
      url, name: t, description: resumen(p),
      image: fotos.slice(0, 8),
      sku: p.codigo || undefined,
      datePosted: p.created_at,
      offers: {
        '@type': 'Offer',
        price: p.precio ? String(p.precio) : undefined,
        priceCurrency: 'USD',
        availability: sold ? 'https://schema.org/SoldOut'
          : resv ? 'https://schema.org/LimitedAvailability'
            : 'https://schema.org/InStock',
        url,
        seller: { '@id': SITE + '/#organization' }
      },
      about: {
        '@type': /lote|terreno/i.test(p.tipo || '') ? 'Place' : 'SingleFamilyResidence',
        name: t,
        address: {
          '@type': 'PostalAddress',
          streetAddress: p.direccion || undefined,
          addressLocality: c,
          addressRegion: p.provincia || 'Buenos Aires',
          addressCountry: 'AR'
        },
        ...(p.ambientes ? { numberOfRooms: Number(p.ambientes) } : {}),
        ...(p.dormitorios ? { numberOfBedrooms: Number(p.dormitorios) } : {}),
        ...(p.banios ? { numberOfBathroomsTotal: Number(p.banios) } : {}),
        ...(p.plantas ? { numberOfFloors: Number(p.plantas) } : {}),
        ...(p.mts_cubiertos ? { floorSize: { '@type': 'QuantitativeValue', value: Number(p.mts_cubiertos), unitCode: 'MTK' } } : {}),
        ...(p.mts ? { lotSize: { '@type': 'QuantitativeValue', value: Number(p.mts), unitCode: 'MTK' } } : {}),
        ...(am.length ? { amenityFeature: am.map(a => ({ '@type': 'LocationFeatureSpecification', name: a, value: true })) } : {})
      },
      provider: { '@id': SITE + '/#organization' }
    }, {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Propiedades', item: SITE + '/propiedades/' },
        { '@type': 'ListItem', position: 3, name: t, item: url }
      ]
    }]
  };

  const html = HEAD({ title, desc, canonical: url, image: fotos[0] }) + `
<main class="wrap">
<div class="bc"><a href="/">Inicio</a> / <a href="/propiedades/">Propiedades</a> / ${esc(t)}</div>
${sold ? '<div class="badge v">Vendida</div>' : resv ? '<div class="badge r">Reservada</div>' : ''}
<h1>${esc(t)}</h1>
<p class="meta">${esc([p.direccion, c].filter(Boolean).join(', '))} &middot; ${esc(p.tipo || '')} en ${esc(String(p.operacion || 'Venta').toLowerCase())}</p>
<p class="precio">${fmtUSD(p.precio)}</p>

${sold ? `<p><a class="cta" href="/propiedades/">Ver propiedades similares disponibles</a>
<a class="cta sec" href="/tasador.html">Tasar mi propiedad</a></p>
<p class="meta">Esta propiedad fue vendida por Inmobiliaria Varela CDE. La publicamos como registro de operaciones realizadas.</p>`
      : `<p><a class="cta" href="https://wa.me/${WA_VENTAS}?text=${encodeURIComponent('Hola, me interesa: ' + t + ' (' + (p.codigo || '') + ') - ' + url)}">Consultar por WhatsApp</a>
<a class="cta sec" href="/tasador.html">Tasar mi propiedad</a></p>`}

<h2>Descripcion</h2>
<p>${esc(resumen(p))}</p>
${p.descripcion ? `<p>${esc(p.descripcion).replace(/\n/g, '<br>')}</p>` : ''}

<h2>Caracteristicas</h2>
<ul class="specs">${specs.map(([k, v]) => `<li><b>${esc(k)}</b><span>${esc(v)}</span></li>`).join('')}</ul>

${am.length ? `<h2>Comodidades</h2><ul class="amen">${am.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}

${fotos.length ? `<h2>Fotos</h2><div class="gal">${fotos.slice(0, 14).map((f, i) =>
        `<img src="${esc(f)}" alt="${esc(t)} - ${esc(c)} - foto ${i + 1}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async" width="800" height="600">`).join('')}</div>` : ''}

<h2>Ficha tecnica</h2>
<table><tbody>${specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}
<tr><th>Precio</th><td>${fmtUSD(p.precio)}</td></tr>
<tr><th>Publicada por</th><td>Inmobiliaria Varela CDE &middot; Costa del Este</td></tr></tbody></table>

${similares.length ? `<h2>Propiedades similares en ${esc(c)}</h2><div class="grid">${similares.map(r => `
<article class="card">${(r.fotos || [])[0] ? `<img src="${esc(r.fotos[0])}" alt="${esc(tituloDe(r))}" loading="lazy" decoding="async" width="600" height="450">` : ''}
<div class="card-b"><h3><a href="${urlOf(r)}">${esc(tituloDe(r))}</a></h3>
<div class="meta">${esc([r.direccion, ciudadDe(r)].filter(Boolean).join(', '))}</div>
<div class="card-p">${fmtUSD(r.precio)}</div></div></article>`).join('')}</div>` : ''}
</main>` + ld(jsonld) + FOOT;

  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/index.html`, html);
}

// ---------- 4. Hub ----------
const cardOf = p => {
  const sold = vendida(p), resv = reservada(p);
  return `<article class="card${sold ? ' sold' : ''}">${(p.fotos || [])[0]
    ? `<img src="${esc(p.fotos[0])}" alt="${esc(tituloDe(p))}" loading="lazy" decoding="async" width="600" height="450">` : ''}
${sold ? '<span class="card-tag">Vendida</span>' : resv ? '<span class="card-tag">Reservada</span>' : ''}
<div class="card-b"><h3><a href="${urlOf(p)}">${esc(tituloDe(p))}</a></h3>
<div class="meta">${esc(p.tipo || '')}${p.ambientes ? ` &middot; ${p.ambientes} amb` : ''}${p.mts_cubiertos ? ` &middot; ${p.mts_cubiertos} m2 cub` : ''}${p.mts ? ` &middot; ${p.mts} m2 terreno` : ''}</div>
<div class="card-p">${fmtUSD(p.precio)}</div></div></article>`;
};

const porCiudad = activas.reduce((a, p) => { (a[ciudadDe(p)] ??= []).push(p); return a; }, {});

const hub = HEAD({
  title: 'Propiedades en venta en Costa del Este | Inmobiliaria Varela CDE',
  desc: `${activas.length} propiedades en venta en Costa del Este y Mar del Tuyu: casas, lotes, PH, duplex y departamentos con precio publicado y ficha completa.`,
  canonical: SITE + '/propiedades/'
}) + `
<main class="wrap">
<div class="bc"><a href="/">Inicio</a> / Propiedades</div>
<h1>Propiedades en venta en Costa del Este y Mar del Tuyu</h1>
<p class="intro">${activas.length} propiedades disponibles en la cartera de Inmobiliaria Varela CDE, con precio publicado, fotos y ficha tecnica completa. Operamos en Costa del Este y Mar del Tuyu, Partido de La Costa, Provincia de Buenos Aires. Actualizado el ${new Date().toLocaleDateString('es-AR')}.</p>
${Object.entries(porCiudad).map(([c, l]) => `
<h2>${esc(c)} (${l.length})</h2>
<div class="grid">${l.map(cardOf).join('')}</div>`).join('')}

${historial.length ? `
<h2>Operaciones realizadas</h2>
<p class="intro">Propiedades vendidas por Inmobiliaria Varela CDE. Las publicamos como registro verificable de nuestra actividad en la zona.</p>
<div class="grid">${historial.map(cardOf).join('')}</div>` : ''}
</main>` + ld({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  '@id': SITE + '/propiedades/',
  name: 'Propiedades en venta en Costa del Este y Mar del Tuyu',
  description: `${activas.length} propiedades disponibles y ${historial.length} operaciones cerradas.`,
  isPartOf: { '@id': SITE + '/#website' },
  about: { '@id': SITE + '/#organization' },
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: activas.length,
    itemListElement: activas.map((p, i) => ({
      '@type': 'ListItem', position: i + 1, url: urlOf(p), name: tituloDe(p)
    }))
  }
}) + FOOT;

await mkdir('propiedades', { recursive: true });
await writeFile('propiedades/index.html', hub);

// ---------- 5. sitemap.xml ----------
const hoy = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: SITE + '/', pri: '1.0', freq: 'daily' },
  { loc: SITE + '/propiedades/', pri: '0.9', freq: 'daily' },
  { loc: SITE + '/tasador.html', pri: '0.8', freq: 'monthly' },
  { loc: SITE + '/vender.html', pri: '0.8', freq: 'monthly' },
  ...props.map(p => ({
    loc: urlOf(p),
    pri: vendida(p) ? '0.3' : '0.7',
    freq: vendida(p) ? 'yearly' : 'weekly',
    img: (p.fotos || []).slice(0, 5)
  }))
];

await writeFile('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${hoy}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>${(u.img || []).map(i => `
    <image:image><image:loc>${esc(i)}</image:loc></image:image>`).join('')}
  </url>`).join('\n')}
</urlset>`);

console.log(`OK: ${props.length} fichas + hub + sitemap.xml (${urls.length} URLs)`);
