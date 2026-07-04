const VEHICLE_MAKES = [
  'Acura', 'Alfa Romeo', 'Aston Martin', 'Audi', 'Bentley', 'BMW', 'Buick',
  'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Ferrari', 'Fiat', 'Ford',
  'Genesis', 'GMC', 'Honda', 'Hyundai', 'Infiniti', 'Jaguar', 'Jeep', 'Kia',
  'Lamborghini', 'Land Rover', 'Lexus', 'Lincoln', 'Maserati', 'Mazda',
  'McLaren', 'Mercedes-Benz', 'Mercedes', 'Mini', 'Mitsubishi', 'Nissan',
  'Porsche', 'Ram', 'Rivian', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen',
  'Volvo'
];

const FIELD_LABELS = {
  price: ['price', 'internet price', 'sale price', 'market price', 'asking price'],
  mileage: ['mileage', 'miles', 'odometer', 'driven'],
  vin: ['vin', 'vin number'],
  stockNumber: ['stock #', 'stock number', 'stock'],
  bodyStyle: ['body style', 'body', 'vehicle type'],
  exteriorColor: ['exterior color', 'exterior'],
  interiorColor: ['interior color', 'interior'],
  engine: ['engine'],
  transmission: ['transmission'],
  fuelType: ['fuel type', 'fuel'],
  mpg: ['city/highway mpg', 'mpg', 'fuel economy'],
  condition: ['condition'],
  titleStatus: ['title status', 'title']
};

function normalizeListing(input = {}) {
  const sourceUrl = input.url || input.sourceUrl || '';
  const titleHints = compact([
    input.pageTitle,
    input.title,
    input.metaDescription
  ]).join('\n');
  const sourceText = compact([
    input.pageText,
    input.markdown,
    input.text,
    titleHints
  ]).join('\n');
  const lines = cleanLines(sourceText);
  const title = chooseTitle(input, lines);
  const vehicle = extractVehicleFromTitle(title, sourceText);
  const price = parseMoney(firstField(lines, sourceText, FIELD_LABELS.price) || firstMatch(sourceText, /\$[\d,]+(?:\.\d{2})?/));
  const mileage = parseInteger(firstField(lines, sourceText, FIELD_LABELS.mileage) || firstMatch(sourceText, /(?:mileage|miles|odometer|driven)\D{0,20}([\d,]+)\s*(?:mi|miles)?/i));
  const vin = normalizeVin(firstField(lines, sourceText, FIELD_LABELS.vin) || firstMatch(sourceText, /\b[A-HJ-NPR-Z0-9]{17}\b/i));
  const stockNumber = cleanupValue(firstField(lines, sourceText, FIELD_LABELS.stockNumber));
  const exteriorColor = normalizeColor(firstField(lines, sourceText, FIELD_LABELS.exteriorColor) || firstMatch(sourceText, /exterior color:\s*([^.\n\r|]+?)(?:\s*[·|]\s*interior|\n|$)/i));
  const interiorColor = normalizeColor(firstField(lines, sourceText, FIELD_LABELS.interiorColor) || firstMatch(sourceText, /interior color:\s*([^.\n\r|]+?)(?:\n|$)/i));
  const transmission = normalizeTransmission(firstField(lines, sourceText, FIELD_LABELS.transmission) || firstMatch(sourceText, /\b(automatic|manual|cvt)\b(?:\s+transmission)?/i));
  const fuelType = normalizeFuel(firstField(lines, sourceText, FIELD_LABELS.fuelType) || firstMatch(sourceText, /fuel type:\s*([^.\n\r|]+)/i));
  const bodyStyle = cleanupValue(firstField(lines, sourceText, FIELD_LABELS.bodyStyle));
  const engine = cleanupValue(firstField(lines, sourceText, FIELD_LABELS.engine));
  const mpg = cleanupValue(firstField(lines, sourceText, FIELD_LABELS.mpg));
  const condition = normalizeCondition(firstField(lines, sourceText, FIELD_LABELS.condition) || firstMatch(sourceText, /\b(excellent|good|fair|salvage|like new|new|used)\s+condition\b/i));
  const titleStatus = normalizeTitleStatus(firstField(lines, sourceText, FIELD_LABELS.titleStatus) || firstMatch(sourceText, /\b(clean|rebuilt|salvage|lien)\s+title\b/i));
  const location = cleanupLocation(input.location || firstMatch(sourceText, /listed\s+(?:.+?)\s+in\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i) || firstMatch(sourceText, /\b([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\b/));
  const photos = normalizePhotos(input.images || input.photos || []);
  const facebookTitle = buildFacebookTitle({ ...vehicle, title });
  const description = buildDescription({
    title: facebookTitle,
    price,
    mileage,
    vin,
    stockNumber,
    bodyStyle,
    exteriorColor,
    interiorColor,
    engine,
    transmission,
    fuelType,
    mpg,
    sourceUrl,
    salespersonName: input.salespersonName || 'Sayed'
  });

  return pruneEmpty({
    sourceUrl,
    title: facebookTitle,
    rawTitle: title,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    price,
    mileage,
    vin,
    stockNumber,
    bodyStyle,
    exteriorColor,
    interiorColor,
    engine,
    transmission,
    fuelType,
    mpg,
    condition,
    titleStatus,
    location,
    description,
    photos,
    confidence: buildConfidence({ price, mileage, vin, photos, vehicle, title })
  });
}

function buildDescription(listing) {
  const rows = [
    `**Sold by dealer. Message ${listing.salespersonName || 'us'} for test drive.**`,
    `**${listing.title || 'Vehicle for sale'}**`
  ];

  pushRow(rows, 'Price', formatMoney(listing.price));
  pushRow(rows, 'Mileage', listing.mileage ? `${formatNumber(listing.mileage)} miles` : '');
  pushRow(rows, 'VIN', listing.vin);
  pushRow(rows, 'Stock #', listing.stockNumber);
  pushRow(rows, 'Body Style', listing.bodyStyle);
  pushRow(rows, 'Exterior Color', listing.exteriorColor);
  pushRow(rows, 'Interior Color', listing.interiorColor);
  pushRow(rows, 'Engine', listing.engine);
  pushRow(rows, 'Transmission', listing.transmission);
  pushRow(rows, 'Fuel Type', listing.fuelType);
  pushRow(rows, 'City/Highway MPG', listing.mpg);

  rows.push(`Contact ${listing.salespersonName || 'us'} today to schedule your test drive!`);
  if (listing.sourceUrl) rows.push(`Vehicle details: ${listing.sourceUrl}`);
  return rows.join('\n');
}

function pushRow(rows, label, value) {
  if (value) rows.push(`- **${label}:** ${value}`);
}

function chooseTitle(input, lines) {
  const candidates = compact([
    input.vehicleTitle,
    input.title,
    input.pageTitle,
    ...lines.slice(0, 12)
  ])
    .map((value) => stripTitleSuffix(cleanupValue(value)))
    .filter((value) => /\b(19|20)\d{2}\b/.test(value));

  return candidates[0] || cleanupValue(input.pageTitle || lines[0] || 'Vehicle for sale');
}

function extractVehicleFromTitle(title, sourceText = '') {
  const joined = `${title}\n${sourceText}`;
  const year = parseInteger(firstMatch(joined, /\b(19|20)\d{2}\b/));
  const make = findMake(joined);
  let model = '';
  let trim = '';

  if (year && make) {
    const pattern = new RegExp(`\\b${year}\\b\\s+${escapeRegExp(make)}\\s+([^\\n\\r|,-]+)`, 'i');
    const afterMake = firstMatch(joined, pattern);
    if (afterMake) {
      const parts = stripTitleSuffix(afterMake).split(/\s+/).filter(Boolean);
      model = parts.slice(0, modelWordCount(make, parts)).join(' ');
      trim = parts.slice(modelWordCount(make, parts)).join(' ');
    }
  }

  return pruneEmpty({ year, make: normalizeMake(make), model: titleCase(model), trim: cleanupValue(trim) });
}

function modelWordCount(make, parts) {
  if (!parts.length) return 0;
  const twoWordModels = new Set(['land cruiser', 'grand cherokee', 'range rover', 'civic type', 'model y', 'model x', 'model s', 'model 3']);
  const firstTwo = parts.slice(0, 2).join(' ').toLowerCase();
  if (twoWordModels.has(firstTwo)) return 2;
  if (make && make.toLowerCase() === 'land rover' && parts.length >= 2) return 2;
  return 1;
}

function findMake(text) {
  for (const make of VEHICLE_MAKES) {
    if (new RegExp(`\\b${escapeRegExp(make)}\\b`, 'i').test(text)) return make;
  }
  return '';
}

function normalizePhotos(images) {
  const seen = new Set();
  const photos = [];

  for (const image of images) {
    const url = typeof image === 'string' ? image : image.url || image.src || image.currentSrc;
    if (!url || seen.has(url) || /^data:/i.test(url) || /^blob:/i.test(url)) continue;
    seen.add(url);
    photos.push({
      url,
      alt: cleanupValue(image.alt || image.title || ''),
      width: parseInteger(image.width),
      height: parseInteger(image.height)
    });
    if (photos.length >= 20) break;
  }

  return photos;
}

function firstField(lines, sourceText, labels) {
  for (const label of labels) {
    const lineValue = firstLabeledLine(lines, label);
    if (lineValue) return lineValue;
  }

  for (const label of labels) {
    const labelPattern = escapeRegExp(label).replace(/\\ /g, '\\s+');
    const match = sourceText.match(new RegExp(`(?:^|[\\n\\r\\-\\*\\s])${labelPattern}\\*?\\*?\\s*[:#]\\s*([^\\n\\r|]+)`, 'i'));
    if (match) return cleanupValue(match[1]);
  }

  return '';
}

function firstLabeledLine(lines, label) {
  const normalizedLabel = normalizeKey(label);
  for (const line of lines) {
    const cleaned = line.replace(/^[-*•\s]+/, '').replace(/\*\*/g, '');
    const idx = cleaned.indexOf(':');
    if (idx === -1) continue;
    const key = normalizeKey(cleaned.slice(0, idx));
    if (key === normalizedLabel) return cleanupValue(cleaned.slice(idx + 1));
  }
  return '';
}

function cleanLines(text) {
  return String(text || '')
    .split(/\n|\r|(?=\s+-\s+\*\*)/g)
    .map((line) => cleanupValue(line))
    .filter(Boolean);
}

function cleanupValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,\-|*#]+/, '')
    .replace(/[\s,;|*]+$/, '')
    .trim();
}

function stripTitleSuffix(value) {
  return cleanupValue(value)
    .replace(/\s*\|\s*.*$/, '')
    .replace(/\s+-\s+.*(?:dealer|dealership|inventory|cars|trucks|facebook|marketplace).*$/i, '')
    .replace(/\s+-\s+[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}.*$/i, '');
}

function cleanupLocation(value) {
  return cleanupValue(value).replace(/\s+Location is approximate$/i, '');
}

function normalizeColor(value) {
  return titleCase(cleanupValue(value).replace(/\s*[·|].*$/, ''));
}

function normalizeFuel(value) {
  const cleaned = cleanupValue(value).replace(/\s+fuel$/i, '');
  if (!cleaned) return '';
  if (/hybrid/i.test(cleaned)) return 'Hybrid';
  if (/electric|ev/i.test(cleaned)) return 'Electric';
  if (/diesel/i.test(cleaned)) return 'Diesel';
  if (/gas/i.test(cleaned)) return 'Gasoline';
  return titleCase(cleaned);
}

function normalizeTransmission(value) {
  const cleaned = cleanupValue(value);
  if (/automatic/i.test(cleaned)) return 'Automatic';
  if (/manual/i.test(cleaned)) return 'Manual';
  if (/cvt/i.test(cleaned)) return 'CVT';
  return titleCase(cleaned);
}

function normalizeCondition(value) {
  const cleaned = cleanupValue(value).replace(/\s+condition$/i, '');
  return titleCase(cleaned);
}

function normalizeTitleStatus(value) {
  const cleaned = cleanupValue(value);
  if (/clean/i.test(cleaned)) return 'Clean title';
  if (/rebuilt/i.test(cleaned)) return 'Rebuilt title';
  if (/salvage/i.test(cleaned)) return 'Salvage title';
  if (/lien/i.test(cleaned)) return 'Lien title';
  return titleCase(cleaned);
}

function normalizeVin(value) {
  const match = String(value || '').toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  return match ? match[0] : '';
}

function normalizeMake(make) {
  if (!make) return '';
  if (/^mercedes$/i.test(make)) return 'Mercedes-Benz';
  return make;
}

function buildFacebookTitle(vehicle) {
  if (vehicle.year && vehicle.make && vehicle.model) {
    return compact([vehicle.year, normalizeMake(vehicle.make), vehicle.model, vehicle.trim]).join(' ');
  }
  return cleanupValue(vehicle.title || 'Vehicle for sale');
}

function buildConfidence({ price, mileage, vin, photos, vehicle, title }) {
  const checks = [
    Boolean(title),
    Boolean(vehicle.year),
    Boolean(vehicle.make),
    Boolean(vehicle.model),
    Boolean(price),
    Boolean(mileage),
    Boolean(vin),
    Boolean(photos && photos.length)
  ];
  const score = checks.filter(Boolean).length / checks.length;
  return Math.round(score * 100) / 100;
}

function parseMoney(value) {
  const match = String(value || '').match(/\$?\s*([\d,]+)(?:\.\d{2})?/);
  return match ? parseInteger(match[1]) : undefined;
}

function parseInteger(value) {
  const match = String(value || '').match(/\d[\d,]*/);
  return match ? Number(match[0].replace(/,/g, '')) : undefined;
}

function formatMoney(value) {
  return value ? `$${formatNumber(value)}` : '';
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function firstMatch(text, regex) {
  const match = String(text || '').match(regex);
  if (!match) return '';
  return cleanupValue(match[1] || match[0]);
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

function titleCase(value) {
  return cleanupValue(value).replace(/\w\S*/g, (word) => {
    if (/^[A-Z0-9]{2,}$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function compact(values) {
  return values.filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function pruneEmpty(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export {
  normalizeListing,
  buildDescription,
  cleanLines,
  extractVehicleFromTitle
};
