// render.ts
//
// HTML templates for the share surface: the /shows/:id page (mockup §5 in the
// iOS repo's docs/ideas/on-tour-share-cards.html), the friendly not-found
// page, and the upstream-error page. Everything is a self-contained string —
// inline CSS, no frameworks, no external JS — because the primary audience is
// link unfurlers, which read meta tags and run nothing. The one script is the
// optional inline analytics snippet, emitted only when a PostHog key is
// configured.
//
// Safety rule: every upstream string passes through esc() exactly once, and
// every upstream URL through safeHttpUrl(). Static copy is authored raw.

import type { Concert } from "./concert";
import {
  buildDescription,
  directionsUrl,
  escapeHtml as esc,
  formatEventDate,
  formatPrice,
  formatTimeNY,
  initialGrapheme,
  isPast,
  ogTitle,
  safeHttpUrl,
} from "./format";
import { posterPair } from "./poster";

/** The live stream the share page plays — RadioStation.swift's stream URL. */
export const WXYC_STREAM_URL = "https://audio-mp3.ibiblio.org/wxyc.mp3";

/** WXYC Radio on the App Store (documented in wxyc-ios-64's README). */
export const APP_STORE_ID = "353182815";
export const APP_STORE_URL = `https://apps.apple.com/us/app/wxyc-radio/id${APP_STORE_ID}`;

/** Share links are canonically on the apex, whatever host served this render. */
const CANONICAL_ORIGIN = "https://wxyc.org";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** PostHog config for the inline snippet; absent = no analytics at all. */
export interface AnalyticsConfig {
  projectKey: string;
  host?: string;
}

/** Per-request rendering inputs. */
export interface RenderOptions {
  /** Origin serving this render — og:image must resolve on the same host. */
  requestOrigin: string;
  /** Clock override for tests; defaults to the real now. */
  now?: Date;
  analytics?: AnalyticsConfig;
}

const SHELL_CSS = `
  :root {
    /* Sunset palette: stops lifted verbatim from the app-icon gradient
       (rose -> salmon -> pink -> periwinkle); deep tones are darkened
       periwinkle, not new hues. */
    --rose: #e6a1bf; --salmon: #e98c8c; --pink: #e27db2;
    --peri-light: #878dc1; --peri: #7e85c1; --peri-deep: #1e2142;
    --card: rgba(26,24,52,0.72);
    --ink: #ffffff; --ink-dim: rgba(255,255,255,0.75); --ink-faint: rgba(255,255,255,0.55);
    --glass-line: rgba(255,255,255,0.22);
    --live: #34c759;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: linear-gradient(180deg, var(--rose) 0%, var(--salmon) 28%, var(--pink) 34%, var(--peri-light) 92%, var(--peri) 100%) var(--peri);
    color: var(--ink);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; padding: 18px 14px;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .sheet {
    width: 100%; max-width: 430px; background: var(--card);
    -webkit-backdrop-filter: blur(20px) saturate(1.2); backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid var(--glass-line); border-radius: 18px; overflow: hidden;
  }
  .hero { position: relative; aspect-ratio: 4 / 3.1; overflow: hidden; }
  .hero .art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .hero .initial {
    position: absolute; right: -3%; top: -12%; line-height: 1;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: clamp(150px, 52vw, 230px); font-weight: 900; color: rgba(255,255,255,0.09);
  }
  .hero .scrim {
    position: absolute; inset: 0;
    background: linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0) 35%, rgba(26,24,52,0.95));
  }
  .hero .facts { position: absolute; left: 16px; right: 16px; bottom: 13px; }
  .pill {
    display: inline-block; border-radius: 999px; padding: 4px 10px; margin-bottom: 8px;
    font: 700 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 1px;
  }
  .pill-live { background: var(--live); color: #06210d; }
  .pill-muted { background: rgba(255,255,255,0.18); color: var(--ink); }
  .pill-cancelled { background: #ff453a; color: #2b0503; }
  .pill-accent { background: var(--pink); color: #3c1027; }
  h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.3px; margin-bottom: 3px; }
  .billing, .meta {
    font: 600 11px/1.7 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 1px; text-transform: uppercase; color: rgba(255,255,255,0.85);
  }
  .event-title { font-size: 13px; color: var(--ink-dim); margin-top: 3px; }
  .actions { padding: 16px; display: grid; gap: 10px; }
  .cta {
    display: block; text-align: center; text-decoration: none;
    font-weight: 700; font-size: 16px; padding: 14px; border-radius: 12px;
    background: var(--ink); color: #2e3160;
  }
  .cta.ghost { background: rgba(255,255,255,0.1); color: var(--ink); border: 1px solid var(--glass-line); }
  .caption { font-size: 12px; color: var(--ink-faint); text-align: center; margin-top: -4px; }
  .passed {
    font-size: 14px; text-align: center; color: #ffe1ee;
    background: rgba(230,161,191,0.14); border: 1px solid rgba(230,161,191,0.55);
    border-radius: 12px; padding: 12px;
  }
  .listen {
    border: 1px solid var(--glass-line); border-radius: 12px; padding: 12px;
    background: rgba(255,255,255,0.05);
  }
  .listen-title { font-size: 14px; font-weight: 650; }
  .listen-sub {
    font: 600 10px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 1px; text-transform: uppercase; color: var(--ink-faint);
  }
  .listen audio { width: 100%; margin-top: 8px; }
  footer {
    padding: 4px 16px 18px; text-align: center;
    font: 600 10px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 1px; text-transform: uppercase; color: var(--ink-faint);
  }
  footer a { color: var(--rose); text-decoration: none; }
  .wordmark {
    background: var(--peri-deep); padding: 44px 16px 40px; text-align: center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .wordmark .wm { font-size: 34px; font-weight: 900; letter-spacing: 3px; }
  .wordmark .fm { color: var(--pink); }
  .wordmark .tag {
    margin-top: 7px; font-size: 10px; font-weight: 600;
    letter-spacing: 2px; text-transform: uppercase; color: var(--ink-faint);
  }
  .notice { padding: 20px 16px 6px; text-align: center; }
  .notice h1 { font-size: 21px; }
  .notice p { margin-top: 6px; font-size: 14px; color: var(--ink-dim); }
`;

interface HeadInput {
  title: string;
  description: string;
  canonicalUrl: string | null;
  imageUrl: string;
  imageAlt: string;
}

/** The head block that authors every share card. All inputs pre-escaped. */
function headBlock(input: HeadInput): string {
  const canonical =
    input.canonicalUrl === null
      ? ""
      : `
  <link rel="canonical" href="${input.canonicalUrl}">
  <meta property="og:url" content="${input.canonicalUrl}">`;
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${input.title}</title>
  <meta name="description" content="${input.description}">
  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
  <meta name="theme-color" content="#e6a1bf">${canonical}
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WXYC 89.3 FM">
  <meta property="og:title" content="${input.title}">
  <meta property="og:description" content="${input.description}">
  <meta property="og:image" content="${input.imageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="640">
  <meta property="og:image:alt" content="${input.imageAlt}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${input.title}">
  <meta name="twitter:description" content="${input.description}">
  <meta name="twitter:image" content="${input.imageUrl}">
  <style>${SHELL_CSS}</style>`;
}

function page(head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  ${head}
</head>
<body>
${body}
</body>
</html>
`;
}

/** The live-stream row — present on every page; the radio outlives the API. */
function listenBlock(): string {
  return `    <section class="listen">
      <p class="listen-title">Listen to WXYC</p>
      <p class="listen-sub">Live · 89.3 FM Chapel Hill</p>
      <audio controls preload="none" src="${WXYC_STREAM_URL}"></audio>
    </section>`;
}

function footerBlock(): string {
  return `  <footer>WXYC 89.3 FM · Chapel Hill's student-run radio · <a href="https://wxyc.org">wxyc.org</a></footer>`;
}

/**
 * The inline PostHog capture snippet. Vanilla fetch/sendBeacon against the
 * capture endpoint — no external script, so unfurl bots and slow networks
 * never pay for it. `os` is derived client-side (the page is edge-cached, so
 * the server cannot bake in a per-visitor value); `concert_id` is baked in.
 */
function analyticsSnippet(concertId: number, analytics: AnalyticsConfig): string {
  const host = (analytics.host ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  const literal = (value: string): string => JSON.stringify(value).replaceAll("</", "<\\/");
  return `  <script>
  (function () {
    var key = ${literal(analytics.projectKey)};
    var endpoint = ${literal(`${host}/i/v0/e/`)};
    var concertId = ${concertId};
    function osName() {
      var ua = navigator.userAgent || "";
      if (/iPhone|iPad|iPod/.test(ua)) return "ios";
      if (/Android/.test(ua)) return "android";
      if (/Macintosh/.test(ua)) return "macos";
      if (/Windows/.test(ua)) return "windows";
      return "other";
    }
    var distinctId = self.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : "anon-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    function capture(event, extra) {
      try {
        var payload = {
          api_key: key,
          event: event,
          distinct_id: distinctId,
          timestamp: new Date().toISOString(),
          properties: {
            concert_id: concertId,
            os: osName(),
            $current_url: location.href,
            $process_person_profile: false
          }
        };
        if (extra) for (var k in extra) payload.properties[k] = extra[k];
        var body = JSON.stringify(payload);
        if (navigator.sendBeacon) {
          navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }));
        } else {
          fetch(endpoint, { method: "POST", body: body, keepalive: true });
        }
      } catch (err) { /* analytics must never break the page */ }
    }
    capture(${literal("share_page_viewed")});
    document.querySelectorAll("[data-cta]").forEach(function (el) {
      el.addEventListener("click", function () {
        capture(${literal("share_page_cta_tapped")}, { cta: el.getAttribute("data-cta") });
      });
    });
    var audio = document.querySelector("audio");
    if (audio) {
      audio.addEventListener("play", function () {
        capture(${literal("share_page_cta_tapped")}, { cta: "listen" });
      }, { once: true });
    }
  })();
  </script>`;
}

interface TicketCta {
  href: string;
  /** Ready-to-render HTML: static copy raw, embedded data already escaped. */
  labelHtml: string;
  /** Ready-to-render HTML: static copy raw, embedded data already escaped. */
  captionHtml: string;
  prominent: boolean;
}

/**
 * The ticket-slot CTA, mirroring the iOS BoxOfficeTicketPresenter: target is
 * event_url over ticket_url (`ctaURL` precedence), and the wording never
 * claims more than the status supports.
 */
function ticketCta(concert: Concert): TicketCta | null {
  const eventUrl = safeHttpUrl(concert.event_url);
  const href = eventUrl ?? safeHttpUrl(concert.ticket_url);
  if (href === null) return null;
  const targetsVenuePage = eventUrl !== null;
  const venue = esc(concert.venue.name);

  switch (concert.status) {
    case "on_sale":
    case "rescheduled": {
      const price = formatPrice(concert.price_min, null);
      const labelHtml = price === null ? "Get Tickets" : `Get Tickets — ${esc(price)}`;
      const where = targetsVenuePage ? `Opens ${venue}'s event page` : "Opens the ticket page";
      const captionHtml = concert.status === "rescheduled" ? `Rescheduled — ${where}` : where;
      return { href, labelHtml, captionHtml, prominent: true };
    }
    case "sold_out":
      return {
        href,
        labelHtml: targetsVenuePage ? "See Venue Page" : "See Ticket Page",
        captionHtml: `Sold out here — ${venue} sometimes releases more.`,
        prominent: false,
      };
    case "cancelled":
      return {
        href,
        labelHtml: targetsVenuePage ? "See the venue's page" : "See the ticket page",
        captionHtml: "This show has been cancelled.",
        prominent: false,
      };
    case "unknown":
      return {
        href,
        labelHtml: targetsVenuePage ? "See Venue Page" : "See Ticket Page",
        captionHtml: targetsVenuePage ? `Opens ${venue}'s event page` : "Opens the ticket page",
        prominent: false,
      };
  }
}

function statusPill(concert: Concert, passed: boolean): string {
  if (passed) return `<span class="pill pill-muted">PASSED</span>`;
  switch (concert.status) {
    case "on_sale":
      return `<span class="pill pill-live">ON SALE</span>`;
    case "sold_out":
      return `<span class="pill pill-muted">SOLD OUT</span>`;
    case "cancelled":
      return `<span class="pill pill-cancelled">CANCELLED</span>`;
    case "rescheduled":
      return `<span class="pill pill-accent">RESCHEDULED</span>`;
    case "unknown":
      return "";
  }
}

/** The hero facts line: date · doors/time · price · age, unknowns omitted. */
function factsLine(concert: Concert, now: Date): string {
  const segments = [formatEventDate(concert.starts_on, now)];
  const doors = concert.doors_at === null ? null : formatTimeNY(concert.doors_at);
  const showTime = concert.starts_at === null ? null : formatTimeNY(concert.starts_at);
  if (doors !== null) {
    segments.push(`Doors ${doors}`);
  } else if (showTime !== null) {
    segments.push(showTime);
  }
  const price = formatPrice(concert.price_min, concert.price_max);
  if (price !== null) segments.push(price);
  if (concert.age_restriction !== null && concert.age_restriction !== "") {
    segments.push(concert.age_restriction);
  }
  return segments.join(" · ");
}

function heroBlock(concert: Concert, passed: boolean, now: Date): string {
  const imageUrl = safeHttpUrl(concert.image_url);
  const gradient = posterPair(concert.venue.slug, concert.id);
  const backdrop =
    imageUrl === null
      ? `<span class="initial" aria-hidden="true">${esc(initialGrapheme(concert.headlining_artist_raw))}</span>`
      : `<img class="art" src="${esc(imageUrl)}" alt="">`;
  const heroStyle =
    imageUrl === null
      ? ` style="background:linear-gradient(133deg,${gradient.start} 0%,${gradient.end} 100%)"`
      : "";

  const support =
    concert.supporting_artists_raw.length === 0
      ? ""
      : `
      <p class="billing">w/ ${esc(concert.supporting_artists_raw.join(", "))}</p>`;
  const eventTitle =
    concert.title === null || concert.title === ""
      ? ""
      : `
      <p class="event-title">${esc(concert.title)}</p>`;

  return `  <header class="hero"${heroStyle}>
    ${backdrop}
    <div class="scrim"></div>
    <div class="facts">
      ${statusPill(concert, passed)}
      <h1>${esc(concert.headlining_artist_raw)}</h1>${support}
      <p class="meta">${esc(concert.venue.name)}, ${esc(concert.venue.city)}</p>
      <p class="meta">${esc(factsLine(concert, now))}</p>${eventTitle}
    </div>
  </header>`;
}

/** Renders the full share page for a concert. */
export function renderShowPage(concert: Concert, options: RenderOptions): string {
  const now = options.now ?? new Date();
  const passed = isPast(concert.starts_on, now);
  const canonicalUrl = `${CANONICAL_ORIGIN}/shows/${concert.id}`;

  const actions: string[] = [];
  if (passed) {
    actions.push(
      `    <p class="passed">This one's passed — here's what's coming up on WXYC's On Tour.</p>`,
      `    <a class="cta" data-cta="open_app" href="${APP_STORE_URL}">See what's coming up in the WXYC app</a>`,
      listenBlock()
    );
  } else {
    const cta = ticketCta(concert);
    if (cta !== null) {
      actions.push(
        `    <a class="cta${cta.prominent ? "" : " ghost"}" data-cta="tickets" href="${esc(cta.href)}">${cta.labelHtml}</a>`,
        `    <p class="caption">${cta.captionHtml}</p>`
      );
    }
    actions.push(
      listenBlock(),
      `    <a class="cta ghost" data-cta="directions" href="${esc(directionsUrl(concert))}">Directions to ${esc(concert.venue.name)}</a>`,
      `    <a class="cta ghost" data-cta="open_app" href="${APP_STORE_URL}">Open in the WXYC app</a>`
    );
  }

  const body = `<main class="sheet">
${heroBlock(concert, passed, now)}
  <section class="actions">
${actions.join("\n")}
  </section>
${footerBlock()}
</main>
${options.analytics === undefined ? "" : analyticsSnippet(concert.id, options.analytics)}`;

  return page(
    headBlock({
      title: esc(ogTitle(concert)),
      description: esc(buildDescription(concert, now)),
      canonicalUrl: esc(canonicalUrl),
      imageUrl: esc(`${options.requestOrigin}/shows/og-card.png`),
      imageAlt: "WXYC 89.3 FM — Chapel Hill's student-run radio station",
    }),
    body
  );
}

/** The wordmark hero shared by the non-concert pages. */
function wordmarkBlock(): string {
  return `  <header class="wordmark">
    <div class="wm">WX<span class="fm">YC</span></div>
    <div class="tag">89.3 FM · Chapel Hill</div>
  </header>`;
}

/** The friendly 404 for unknown, malformed, or long-gone show ids. */
export function renderNotFoundPage(options: RenderOptions): string {
  const body = `<main class="sheet">
${wordmarkBlock()}
  <div class="notice">
    <h1>We couldn't find that show</h1>
    <p>It may have come and gone, or the link got scrambled on the way here. Here's what's coming up instead:</p>
  </div>
  <section class="actions">
    <a class="cta" data-cta="open_app" href="${APP_STORE_URL}">See what's coming up in the WXYC app</a>
${listenBlock()}
  </section>
${footerBlock()}
</main>`;
  return page(
    headBlock({
      title: "Show not found — WXYC 89.3 FM",
      description:
        "We couldn't find that show. See what's coming up around the Triangle in the WXYC app, and listen live to Chapel Hill's student-run radio.",
      canonicalUrl: null,
      imageUrl: esc(`${options.requestOrigin}/shows/og-card.png`),
      imageAlt: "WXYC 89.3 FM — Chapel Hill's student-run radio station",
    }),
    body
  );
}

/**
 * The degraded page for upstream failures. Deliberately free of any dynamic
 * interpolation so the top-level catch can always render it.
 */
export function renderUpstreamErrorPage(): string {
  const body = `<main class="sheet">
${wordmarkBlock()}
  <div class="notice">
    <h1>Having trouble loading this show</h1>
    <p>Our concert listings aren't answering right now. Give it a minute and reload — and have the radio while you wait.</p>
  </div>
  <section class="actions">
${listenBlock()}
    <a class="cta ghost" data-cta="open_app" href="${APP_STORE_URL}">Open in the WXYC app</a>
  </section>
${footerBlock()}
</main>`;
  return page(
    headBlock({
      title: "WXYC 89.3 FM",
      description:
        "Chapel Hill's student-run radio station. Freeform radio from the basement of the Student Union since 1977.",
      canonicalUrl: null,
      imageUrl: "https://wxyc.org/shows/og-card.png",
      imageAlt: "WXYC 89.3 FM — Chapel Hill's student-run radio station",
    }),
    body
  );
}
