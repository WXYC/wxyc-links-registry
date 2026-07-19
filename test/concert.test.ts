// concert.test.ts
//
// Unit tests for the Concert decoder: the required floor, the lenient
// degradation of everything else, tolerance of extra wire fields (the live
// API sends more than this page models — headlining_artist_id, venue.id,
// genres, similar_artists — and must keep decoding), and id integrity (a
// non-integer id would flow into canonical/og:url/app-argument URLs that
// this Worker's own route rejects).

import { describe, expect, it } from "vitest";
import { parseConcert } from "../src/concert";
import { makeJessicaPratt, wireBody } from "./helpers";

describe("parseConcert", () => {
  it("decodes the full wire shape, ignoring the fields this page does not model", () => {
    const concert = makeJessicaPratt({ id: 4821 });
    const parsed = parseConcert(JSON.parse(wireBody(concert)));
    expect(parsed).toEqual(concert);
  });

  it("rejects payloads missing the required floor", () => {
    const concert = makeJessicaPratt({ id: 4821 });
    const wire = JSON.parse(wireBody(concert)) as Record<string, unknown>;
    delete wire.starts_on;
    expect(parseConcert(wire)).toBeNull();
  });

  it("rejects non-integer and non-positive ids instead of building self-dead URLs", () => {
    const concert = makeJessicaPratt({ id: 4821 });
    for (const id of [4821.5, 0, -3, 1e21]) {
      const wire = JSON.parse(wireBody(concert)) as Record<string, unknown>;
      wire.id = id;
      expect(parseConcert(wire), String(id)).toBeNull();
    }
  });

  it("degrades an unrecognized status to unknown rather than failing the page", () => {
    const concert = makeJessicaPratt({ id: 4821 });
    const wire = JSON.parse(wireBody(concert)) as Record<string, unknown>;
    wire.status = "hologram_tour";
    expect(parseConcert(wire)?.status).toBe("unknown");
  });
});
