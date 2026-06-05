# Looker Studio report (Google Analytics as a second source of truth)

The self-hosted dashboard is the primary view. This guide wires a **Looker Studio**
report onto the same GA4 data so you (or a client) can slice it with Google's tooling,
schedule emailed PDFs, and share read-only links — no extra infrastructure.

## What lands in GA4

| Event | Source | Key params |
|---|---|---|
| `affiliate_click` | server-side tracker (amst-air) + gtag | `affiliate_provider`, `affiliate_product`, `link_domain`, `source_page`, `device`, `geo_country`, `campaign`, `visitor_id`, `session_id` |
| `affiliate_conversion` | dashboard CSV import → Measurement Protocol *(only when `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are set)* | `value` (commission), `currency`, `affiliate_provider`, `affiliate_product`, `bookings`, `site`, `source=gyg_import` |

So **clicks** are real-time and **conversions** are back-filled from the GYG export.
EPC / conversion-rate in Looker = `affiliate_conversion.value` ÷ `affiliate_click count`.

## One-time GA4 setup

1. **Register the custom dimensions/metric** (GA4 → *Admin → Custom definitions*):
   - Dimensions (event-scoped): `affiliate_provider`, `affiliate_product`, `site`, `link_domain`, `campaign`, `source_page`.
   - Metric: `value` already maps to *Event value*; optionally register `bookings` as a custom metric (Integer).
2. **Mark `affiliate_conversion` as a key event** (*Admin → Events → mark as key event*) so it shows in conversion reports.
3. **Measurement Protocol secret** (for mirroring): *Admin → Data Streams → [your stream] → Measurement Protocol API secrets → Create*. Put the value in the dashboard's `GA4_API_SECRET`, and the stream's `G-…` id in `GA4_MEASUREMENT_ID`.

## Build the Looker Studio report

1. Go to <https://lookerstudio.google.com> → **Create → Report** → add a **Google Analytics** data source → pick the property/stream.
2. Add a **scorecard row** (the KPIs that matter, per the research):
   - **Clicks** = Event count filtered to `Event name = affiliate_click`.
   - **Conversions** = Event count filtered to `affiliate_conversion`.
   - **Commission** = Sum of *Event value* filtered to `affiliate_conversion`.
   - **Conversion rate** = create a calculated field: `Conversions / Clicks`.
   - **EPC** = calculated field: `Commission / Clicks`.
   - **AOV** = calculated field: `Commission / Conversions`.
3. Add a **time-series** chart: dimension *Date*, metrics *Clicks* and *Conversions*. Turn on *comparison: previous period* for the up/down deltas.
4. Add **tables** broken down by `affiliate_provider`, `affiliate_product`, `Country`, `Device category`, `source_page` — sort by EPC.
5. Add a **filter control** on `site` and a **date-range control** at the top.
6. (Optional) **Schedule delivery**: *Share → Schedule email delivery* for a weekly PDF; *Share → Manage access* for a read-only link.

## Calculated fields (paste-ready)

```
Conversion rate:  SUM(IF(REGEXP_MATCH(Event name,'affiliate_conversion'),1,0)) / SUM(IF(REGEXP_MATCH(Event name,'affiliate_click'),1,0))
EPC:              SUM(IF(Event name='affiliate_conversion', Event value, 0)) / SUM(IF(Event name='affiliate_click',1,0))
```

> Note: GA4 Measurement Protocol conversions arrive without a real `client_id`/cookie, so
> they enrich **aggregate** reporting (totals, by provider/product/date) but are **not** stitched
> to the original click's user journey. For per-click attribution use the self-hosted dashboard,
> which keeps the raw click rows.
