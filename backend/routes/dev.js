import { Router } from 'express';
import { normalizeListing } from '../normalize.js';
import { scrapeWithFirecrawl } from '../firecrawl.js';

// DORMANT / dev-only. The optional Firecrawl fallback extractor + the HTML fixtures used
// for local testing of the dealer→normalize→fill flow. server.js mounts this ONLY when
// NODE_ENV !== 'production', so none of it — and neither firecrawl.js nor normalize.js —
// is reachable (or even imported) in production.

const router = Router();

function mergeImages(...groups) {
  const seen = new Set();
  const images = [];
  for (const group of groups) {
    for (const image of group || []) {
      const url = typeof image === 'string' ? image : image && image.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      images.push(typeof image === 'string' ? { url } : image);
    }
  }
  return images;
}

router.post('/api/listings/extract', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const warnings = [];
    let firecrawlResult = null;

    if (payload.useFirecrawl !== false && payload.url) {
      try {
        firecrawlResult = await scrapeWithFirecrawl(payload.url);
      } catch (error) {
        warnings.push(`Firecrawl failed, using browser snapshot fallback: ${error.message}`);
      }
    }

    const listing = normalizeListing({
      ...payload,
      images: mergeImages(payload.images || [], firecrawlResult && firecrawlResult.images ? firecrawlResult.images : []),
      markdown: firecrawlResult && firecrawlResult.markdown
        ? `${firecrawlResult.markdown}\n\n${payload.pageText || ''}`
        : payload.pageText
    });

    res.json({
      ok: true,
      listing,
      meta: {
        firecrawlUsed: Boolean(firecrawlResult && firecrawlResult.markdown),
        warningCount: warnings.length,
        warnings
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get(/^\/(?:used|new|certified)-/i, (req, res) => res.type('html').send(sampleVdpHtml()));
router.get('/fixtures/sample-vdp', (req, res) => res.type('html').send(sampleVdpHtml()));
router.get('/fixtures/sample-inventory', (req, res) => res.type('html').send(sampleInventoryHtml()));

function sampleVdpHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="2025 Toyota Land Cruiser for sale in Alexandria, VA. VIN JTEABFAJ9SK020209.">
    <meta property="og:title" content="2025 Toyota Land Cruiser - Alexandria Toyota">
    <meta property="og:image" content="https://images.unsplash.com/photo-1549924231-f129b911e442?auto=format&fit=crop&w=1400&q=80">
    <title>2025 Toyota Land Cruiser - Alexandria Toyota</title>
    <style>
      body { margin: 0; color: #1f2328; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f8fa; }
      main { max-width: 1040px; margin: 0 auto; padding: 32px 18px 80px; }
      .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, .8fr); gap: 24px; align-items: start; }
      .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .photos img:first-child { grid-column: 1 / -1; }
      img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 8px; background: #d8dee4; }
      .details { background: white; border: 1px solid #d8dee4; border-radius: 8px; padding: 20px; }
      h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.1; }
      .price { font-size: 26px; font-weight: 800; margin-bottom: 16px; }
      dl { display: grid; grid-template-columns: 140px 1fr; gap: 8px 14px; }
      dt { color: #57606a; }
      dd { margin: 0; font-weight: 650; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="photos">
          <img src="https://images.unsplash.com/photo-1549924231-f129b911e442?auto=format&fit=crop&w=1400&q=80" alt="2025 Toyota Land Cruiser front exterior">
          <img src="https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=80" alt="2025 Toyota Land Cruiser side profile">
          <img src="https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=80" alt="2025 Toyota Land Cruiser rear exterior">
        </div>
        <aside class="details">
          <h1>2025 Toyota Land Cruiser</h1>
          <div class="price">$54,970</div>
          <p>Located in Alexandria, VA</p>
          <dl>
            <dt>Mileage</dt><dd>9,582 miles</dd>
            <dt>VIN</dt><dd>JTEABFAJ9SK020209</dd>
            <dt>Stock #</dt><dd>00P30392</dd>
            <dt>Body Style</dt><dd>Sport Utility</dd>
            <dt>Exterior Color</dt><dd>Grey</dd>
            <dt>Interior Color</dt><dd>Black</dd>
            <dt>Engine</dt><dd>4 Cyl - 2.4 L</dd>
            <dt>Transmission</dt><dd>Automatic</dd>
            <dt>Fuel Type</dt><dd>Hybrid Fuel</dd>
            <dt>City/Highway MPG</dt><dd>22/25</dd>
            <dt>Condition</dt><dd>Excellent</dd>
            <dt>Title Status</dt><dd>Clean title</dd>
          </dl>
          <p>Call or message Sayed today to schedule your test drive.</p>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}

function sampleInventoryHtml() {
  const vehicles = [
    {
      title: '2025 Toyota Land Cruiser 1958',
      vin: 'JTEABFAJ9SK020209',
      stock: '00P30392',
      model: '6165',
      miles: '9,582 mi',
      exterior: 'Grey',
      interior: 'Black',
      price: '$54,970',
      img: 'https://images.unsplash.com/photo-1549924231-f129b911e442?auto=format&fit=crop&w=900&q=80'
    },
    {
      title: '2012 Nissan Altima 3.5 SR',
      vin: '1N4BL2EP8CC223820',
      stock: '0N19865A',
      model: '15212',
      miles: '101,464 mi',
      exterior: 'Brilliant Silver Metallic',
      interior: 'Charcoal',
      price: '$8,470',
      img: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=80'
    },
    {
      title: '2015 Hyundai Elantra Sport',
      vin: 'KMHDH4AH6FU304808',
      stock: '0N19766A',
      model: '46452F4P',
      miles: '112,888 mi',
      exterior: 'Geranium Red',
      interior: 'Beige',
      price: '$8,970',
      img: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=900&q=80'
    }
  ];

  const cards = vehicles.map((vehicle) => `
    <article class="vehicle-card__body">
      <a class="vehicle-card__image" href="/used-+Alexandria-${encodeURIComponent(vehicle.title).replace(/%20/g, '+')}-${vehicle.vin}">
        <img src="${vehicle.img}" alt="${vehicle.title}">
      </a>
      <div class="vehicle-overview oem-toyota__tdg--srp-card-overview">
        <a class="vehicle-title" href="/used-+Alexandria-${encodeURIComponent(vehicle.title).replace(/%20/g, '+')}-${vehicle.vin}">${vehicle.title}</a>
        <div>VIN: ${vehicle.vin}</div>
        <div>Stock: ${vehicle.stock}</div>
        <div>Model: ${vehicle.model}</div>
        <div>${vehicle.miles}</div>
        <div>Ext.: ${vehicle.exterior}</div>
        <div>Int.: ${vehicle.interior}</div>
      </div>
      <div class="price-block">
        <strong>${vehicle.price}</strong>
        <a href="/used-+Alexandria-${encodeURIComponent(vehicle.title).replace(/%20/g, '+')}-${vehicle.vin}">View Details</a>
      </div>
    </article>
  `).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sample Used Inventory | ezlist</title>
    <style>
      body { margin: 0; color: #1f2328; background: #f6f8fa; font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
      main { max-width: 1120px; margin: 0 auto; padding: 32px 18px 80px; }
      h1 { margin: 0 0 18px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
      .vehicle-card__body { position: relative; min-height: 640px; background: #fff; border: 1px solid #d8dee4; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
      .vehicle-card__image img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
      .vehicle-overview { padding: 16px; display: grid; gap: 6px; }
      .vehicle-title { color: #0969da; font-weight: 800; font-size: 18px; text-decoration: none; }
      .price-block { border-top: 1px solid #d8dee4; padding: 16px; display: grid; gap: 10px; }
      .price-block strong { font-size: 22px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Showing all 3 vehicles</h1>
      <section class="grid">${cards}</section>
    </main>
  </body>
</html>`;
}

export default router;
