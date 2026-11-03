// Where the portfolio billboards may go when they are NOT on Times Square's screens (see portfolio-billboards.js: they are, unless ?portfolioTs=0 or a board finds no screen): the ONE place that lists candidate street points. Each entry is a point on a street from which a billboard is looked for on a wall
// (a horizontal ray is cast from it, see findWall in portfolio-billboards.js); nothing here is assumed to be a wall. The allocator takes the first candidate of a category
// that really has a flat free wall, so every category lists many.
//
//   hq        the identity board next to where Spider-Man starts (5th Ave and 41st St); its map pin must stay where it is
//   project   one board per project (featured projects first)
//   skills    the Skills & Technologies board
//   contact   the Contact & Links board
//   decor     repeats of the identity board (no pin), up to SITE_RULES.decorMax
//   pool      the overflow: any category falls back to these
//
// `prefer` is the direction of the first ray tried ([1,0] = east wall, [-1,0] west, [0,1] south, [0,-1] north); the others follow.

const SITE_RULES = {
  decorMax: 3,
  minSpacing: 70,        // metres between the street points of two boards (the boards are spread over the city, not stacked)
  hqSpacing: 40,         // ... and from the HQ board
  gap: 2                 // extra metres of clear wall around a board
};

/** @param cc { avenueX, streetZ, TELEPORT_LOCATIONS } from city-config.js */
function buildSites({ avenueX, streetZ, TELEPORT_LOCATIONS: T }) {
  // a mid-block point on an avenue's sidewalk: ave = avenue id, st = the street just north of it (z grows to the south)
  const at = (id, ave, st, prefer) => ({ id, x: avenueX(ave) + 3.6, z: streetZ(st) + 40, prefer });
  const hq = [{ id: 'hq', x: avenueX('5') + 3.6, z: (streetZ(41) + streetZ(42)) / 2 + 30, prefer: [1, 0] }];
  const project = [
    at('5th-ave-34', '5', 34), at('6th-ave-44', '6', 44), at('madison-39', 'madison', 39), at('5th-ave-50', '5', 50), at('7th-ave-40', '7', 40), at('park-ave-45', 'park', 45),
    at('6th-ave-36', '6', 36), at('madison-47', 'madison', 47), at('lex-41', 'lex', 41), at('5th-ave-46', '5', 46), at('6th-ave-52', '6', 52), at('7th-ave-48', '7', 48),
    at('park-ave-38', 'park', 38), at('3rd-ave-43', '3', 43), at('5th-ave-54', '5', 54), at('6th-ave-40', '6', 40)
  ];
  const skills = [
    { id: 'grand-central', ...T.grandcentral }, at('park-ave-41', 'park', 41), at('lex-45', 'lex', 45), at('madison-43', 'madison', 43), at('3rd-ave-39', '3', 39)
  ];
  const contact = [
    { id: 'empire', ...T.empire }, at('5th-ave-37', '5', 37), at('6th-ave-33', '6', 33), at('madison-35', 'madison', 35), at('7th-ave-37', '7', 37)
  ];
  const decor = [{ id: 'times-square', ...T.timessq }, { id: 'empire-2', ...T.empire }, { id: 'flatiron', ...T.flatiron }, { id: 'chrysler', ...T.chrysler }, { id: 'gct-2', ...T.grandcentral }, { id: 'central-park', ...T.centralpark }];
  const pool = [
    { id: 'bryant', ...T.bryant }, at('5th-ave-28', '5', 28), at('6th-ave-30', '6', 30), at('5th-ave-56', '5', 56), at('6th-ave-56', '6', 56), at('madison-52', 'madison', 52), at('7th-ave-44', '7', 44),
    at('park-ave-50', 'park', 50), at('lex-36', 'lex', 36), at('3rd-ave-52', '3', 52), at('2nd-ave-45', '2', 45), at('8th-ave-45', '8', 45), at('8th-ave-35', '8', 35)
  ];
  return { hq, project, skills, contact, decor, pool };
}

export { buildSites, SITE_RULES };
