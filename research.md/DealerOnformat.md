Dealership Inventory Streams for Sold Detection
Executive takeaway
Your core thesis is directionally right: for public-web monitoring, a VIN disappearing from the dealership’s active inventory is the most practical sold proxy you can get without DMS access. After inspecting multiple Alexandria-area dealership sites running on DealerOn, I found a repeatable public pattern: a searchable inventory surface, a public sitemap.aspx page that lists VIN-level inventory entries, and VIN-bearing vehicle detail pages that expose status fields such as In Stock or In Transit. For these stores, the public inventory sitemap is the cleanest “source of truth” I could verify, and it is much easier to operationalize than scraping every search-results card. 

The more scalable answer, though, is usually upstream syndication, not page scraping. DealerOn explicitly references daily inventory export to Facebook or Google for enrolled dealers, and its platform materials describe inventory flowing from source feeds through processing to site display. Google Vehicle Listings and Meta Automotive catalogs both depend on hosted inventory feeds, which means many dealerships already have a feed-shaped data product somewhere, even if it is vendor-managed and not publicly linked. 

The practical conclusion is: best is a dealer-authorized or vendor-authorized catalog/feed URL; next best is the public DealerOn sitemap.aspx; fallback is SRP/VDP scraping with a grace window and reappearance handling. 

Verified public endpoints on the Alexandria DealerOn stores
All three of the Alexandria-area stores I inspected identify DealerOn in the site footer and expose the same broad endpoint family: inventory search pages, a public inventory sitemap, and VIN-bearing VDPs. That is strong evidence of a reusable DealerOn public-web pattern, even if I did not verify a public no-auth JSON inventory feed on these specific sites. 

Store	Verified public endpoints	What they give you
Alexandria Toyota	https://www.alexandriatoyota.com/searchnew.aspx • https://www.alexandriatoyota.com/searchused.aspx • https://www.alexandriatoyota.com/certified-pre-owned.html • https://www.alexandriatoyota.com/sitemap.aspx • Example VDPs: https://www.alexandriatoyota.com/new-%2BAlexandria-2026-Toyota-Tacoma-SR5-3TMLB5JN3TM289231 and https://www.alexandriatoyota.com/used-%2BAlexandria-2025-Kia-K5-GT%2BLine-KNAG64J7XS5336550	The sitemap publicly lists VIN-level inventory entries; the VDP exposes VIN, stock, specs, and status. One Toyota VDP shows In Transit plus an estimated availability date, which is useful because it proves the site distinguishes active-but-not-on-lot units from missing units. 
MINI of Alexandria	https://www.miniofalexandria.com/searchnew.aspx • https://www.miniofalexandria.com/searchused.aspx • https://www.miniofalexandria.com/sitemap.aspx	The sitemap includes VIN-level inventory lines for new inventory, and the site footer confirms DealerOn. Even where SRP parsing is sparse, the sitemap gives you a compact VIN roster without having to traverse every model page. 
Passport Nissan Alexandria	https://www.passportnissanva.com/searchnew.aspx • https://www.passportnissanva.com/searchused.aspx • https://www.passportnissanva.com/sitemap.aspx • Example VDP: https://www.passportnissanva.com/new-Alexandria-2026-Nissan-Sentra-SR-3N1AB9DV3TY256607	The sitemap lists VIN-level entries for new inventory, and the VDP exposes VIN, stock, specs, and status. The example Sentra VDP is explicitly marked In Stock, which makes disappearance-from-current-roster a stronger sold proxy than a mere change in merchandising copy. 

Across these DealerOn stores, the most operationally useful public endpoint is /sitemap.aspx, not because it is a formal API, but because it already collapses inventory membership into one crawl target. For sold detection, that matters more than whether the page is branded as “API” or “HTML.” 

Feeds and APIs that are more scalable than direct page scraping
DealerOn’s own materials strongly suggest that real feed infrastructure exists upstream of the websites. DealerOn Connect references exporting vehicle inventory daily to Facebook or Google for enrolled accounts, DealerOn’s resource center describes inventory flowing via feed types and delivery methods, and DealerOn’s Smart Inventory Manager is described as an approved GM DVIM connected to D2C2. In other words, the public website is usually downstream of a more structured inventory pipeline. 

Google’s Vehicle Listings documentation is very explicit about what such a feed looks like. Google says the feed is the central data source used to access and display vehicles, supports CSV with optional ZIP/GZ compression, and expects fields such as vin, store_code, dealership_name, dealership_address, price, condition, make, model, trim, year, and a VDP link. Google also supports vehicle_fulfillment values like IN_STORE, SHIP_TO_STORE, and ONLINE, which is directly relevant to your “vanished vs actually sold” problem. 

Meta’s automotive catalog docs describe the same general architecture from the other side: you need a catalog plus a hosted vehicles feed, and supported feed formats include CSV, TSV, or XML. So if a dealership is actively running automotive inventory ads, the cleanest production move is often to ask the dealer or vendor for the exact catalog export URL rather than reverse-engineering the storefront pages. 

If you need a third-party normalized feed instead of per-store reverse engineering, the most concrete off-the-shelf option I found is MarketCheck. Its Dealership Inventory Syndication endpoint is GET https://api.marketcheck.com/v2/dealerships/inventory; it returns fields including vin, vdp_url, first_seen_at_source, last_seen_at, dom, dom_active, and in_transit, supports up to 1,500 rows per request, and says active listings are refreshed daily on or before 11 AM UTC. MarketCheck also documents a marketplace-formatted endpoint at /v2/dealerships/inventory/marketplaces/{marketplace_name} for Google/Facebook-style syndication flows. 

For VIN enrichment after you detect movement, NHTSA’s official vPIC API is useful and free. The public endpoints include /vehicles/DecodeVinValues/{vin} and /vehicles/DecodeVINValuesBatch/, which let you normalize make/model/year/specs even if the dealer page is thin or temporarily unavailable. That does not tell you sold status by itself, but it helps de-duplicate and validate your VIN store. 

At the enterprise end, Cox Automotive also advertises a DMS+ Vehicle API for approved partners that provides programmatic access to dealership vehicle records, including inventory vehicles. That is closer to “real system-of-record” integration, but it is partner-gated rather than a public plug-and-play endpoint. 

Recommended sold-detection architecture
If I were building this specifically for the DealerOn Alexandria stores you referenced, I would use a tiered ingest:

Tier one: dealer-authorized or vendor-authorized syndication feed if available, especially anything already powering Google Vehicle Listings or Meta Automotive catalogs. Those feeds are designed to represent active inventory and already carry the fields ad platforms need. 

Tier two: the public DealerOn inventory sitemap. For the stores I inspected, sitemap.aspx is the fastest way to get the current VIN set without having to paginate search pages. It already exposes inventory-type groupings and VIN-bearing rows. 

Tier three: VDP enrichment only for candidate VINs. Once you have the VIN roster from the sitemap, fetch the VDP for a smaller subset to capture stock, status, and pricing state. On the sites I checked, VDPs expose at least VIN, stock, and operational status such as In Transit or In Stock. 

A realistic warehouse schema is simple: dealer_id, vin, inventory_type, source_endpoint, vdp_url, stock_no, observed_status, first_seen, last_seen, present_this_run, and posted_to_fb. If you also ingest MarketCheck, add last_seen_at_source, dom_active, and in_transit as external corroboration fields. That gives you enough to separate “not present on this site today” from “consistently absent everywhere I trust.” The recommendation to use MarketCheck here is an engineering inference, but it is grounded in the fact that the API explicitly returns those timestamps and state fields. 

False-positive controls and state handling
Your caution about false positives is not theoretical. The dealer pages themselves repeatedly say vehicles are subject to prior sale and ask shoppers to verify availability, which is a reminder that public-web inventory is operationally useful but not legally identical to a dealer management system. The same Toyota site also contains a strong anti-scraping notice prohibiting automated extraction, which is another reason to prefer dealer-authorized feeds where possible. 

The right state machine for public inventory monitoring is not binary. I would use active -> missing_once -> missing_confirmed -> sold, with a re-entry path from any missing state back to active if the VIN reappears. On DealerOn public data, two consecutive misses spaced at least a day apart is the minimum I would trust; three is safer if the store often reprices, moves units between rooftops, or has frequent site refresh anomalies. That timing recommendation is my inference, but it is supported by how these ecosystems publish: DealerOn Connect references daily export, and MarketCheck documents daily inventory refresh. 

One nuance worth preserving in the model is active non-lot inventory. Google’s listing spec already provides a vocabulary for this with vehicle_fulfillment values such as IN_STORE and SHIP_TO_STORE, and the Toyota VDP I inspected explicitly shows In Transit with an estimated availability date. So a robust system should not collapse everything into present/absent; it should preserve at least in_stock, in_transit, build_phase, and missing. 

What I would actually use in production
For the specific Alexandria DealerOn stores I inspected, my production order of operations would be:

Ask first for the dealer’s existing syndication feed — especially anything already powering Google Vehicle Listings or Meta automotive catalogs. The feed almost certainly exists for any store actively enrolled in those channels, and it will be cleaner than storefront scraping. 
If no feed access is possible, use sitemap.aspx as the primary VIN roster and treat searchnew.aspx / searchused.aspx as discovery or backup surfaces. For DealerOn, that is the strongest public pattern I could verify across multiple Alexandria stores. 
Use VDPs only to enrich or confirm candidates, not as the main crawl surface. The VDPs are rich, but the sitemap is cheaper. 
Optionally add MarketCheck as an external corroboration layer if you want a normalized dealer inventory stream with last_seen_at and in_transit semantics without building every store adapter yourself. 
Use NHTSA vPIC only for VIN normalization and spec recovery, not sold detection. 
So the short answer is: yes, your “inventory disappearance = sold proxy” model is realistic, but for these DealerOn stores the concrete public endpoint to anchor on is usually /sitemap.aspx, not a visible JSON feed. The cleaner long-term solution is to obtain the same feed the store or vendor is already using for Google/Meta syndication. 