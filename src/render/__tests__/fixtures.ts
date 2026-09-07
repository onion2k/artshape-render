/**
 * Sketches the render tests draw. They are fixtures, not a catalogue: the
 * catalogue of examples belongs to an application, and a library's tests
 * should not reach up into one for something to render. Copied from
 * artshape's own examples, where they are what a reader looks at.
 */

export const sketches: Record<string, string> = {
  rosette: `# A rosette: eight pierced leaves, studded, with a curl between each
material gold polished

part petal = leaf(length: 34, width: 15, thickness: 1.1, piercings: 3, boss: 2.4)
part stud  = rivet(head: 3.6, height: 1.2, shank: 2.2, grip: 1.1) in rose gold polished
part curl  = wire(path: spiral(start: 1.1, turns: 1.25, growth: 3), radius: 1, tip: 0.15, sections: 120)
part heart = bead(radius: 7.2, point: 5.5) in rose gold satin

unit sector {
  place petal
  fasten stud to petal.boss
  place curl at (9, -5.5, 1.4) turn -29deg
}

form rosette {
  repeat sector around ring(8, radius: 5.5)
  place heart at (0, 0, 1.9)
}
`,
  chess: `# The whole set, laid out for the first move: the board brought in with
# "use", and both armies stood on it. "use" takes another sketch and binds
# its finished form to its name — the board's own parts and units stay its
# own business — so the board is written and looked at once, here and in
# its own example.
#
# The pieces cannot come the same way. A sketch imported by "use" arrives
# whole, in the metal it was written in, and the six piece examples each
# hold a silver piece and a gold one at a fixed distance apart; so the men
# are declared again here, both armies, and set out square by square.
#
# The board's squares are 22 apart and their tops are 6.8 above the table.
# White's queen stands on her own colour, which is what puts the two queens
# opposite each other on the d file.
use chessboard
material silver satin

part silverFoot  = disc(radius: 7.2, thickness: 2.4, bevel: 0.7) in silver polished
part silverInlay = plate(roundel(radius: 5.9), thickness: 1, bevel: 0.3, enamel: cobalt) in silver satin
part silverHoop  = band(radius: 2, width: 1.6, thickness: 0.9) in silver polished
part silverSeat  = setting(width: 3, style: bezel, height: 1.2) in silver polished
part silverStone = gem(cut: brilliant, width: 3) in sapphire

unit silverCollet {
  place silverSeat
  fasten silverStone to silverSeat.seat
}
unit silverBase {
  place silverFoot at (0, 0, 1.2)
  place silverInlay at (0, 0, 2.9)
}

part silverPawnShaft = stem(path: through((0,0,0), (0,0,9)), radius: 2.6, tip: 0.45, swell: 0.3) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverPawnHead  = pearl(radius: 3) in white pearl
part silverRookShaft  = stem(path: through((0,0,0), (0,0,7)), radius: 3, tip: 0.8, swell: 0.25) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverRookTower  = collar(inner: 2.6, wall: 2.1, length: 7, belly: 0.05) in silver satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part silverRookRim    = band(radius: 4.8, width: 1.5, thickness: 1) in silver polished
part silverRookLid    = disc(radius: 4.9, thickness: 1, bevel: 0.3) in silver polished
part silverRookMerlon = bar(length: 2.2, width: 2.6, thickness: 2.4, bevel: 0.3) in silver polished
part silverKnightShaft = stem(path: through((0,0,0), (0,0,7)), radius: 3, tip: 0.8, swell: 0.25) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverKnightCrest = blade(path: through((0,0,0), (0,0,5), (0,1.5,9), (0,4,11.5), (0,6.5,11)), width: 6.5, thickness: 2.4, sections: 40) in silver satin
part silverKnightEar   = plate(lozenge(length: 3.4, width: 1.5), thickness: 1.1, bevel: 0.25) in silver polished
part silverBishopShaft = stem(path: through((0,0,0), (0,0,9)), radius: 2.8, tip: 0.5, swell: 0.3) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverBishopMitre = bud(length: 10.5, width: 7, lobes: 2, lobeDepth: 0.18, point: 0.5) in silver satin
part silverBishopPip   = pearl(radius: 1.6) in white pearl
part silverQueenShaft = stem(path: through((0,0,0), (0,0,13.5)), radius: 2.8, tip: 0.55, swell: 0.3) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverQueenCup   = bell(length: 6.5, mouth: 10, throat: 6.4, wall: 1.3, flare: 1.2) in silver satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part silverQueenPip   = pearl(radius: 2.5) in white pearl
part silverKingShaft    = stem(path: through((0,0,0), (0,0,15.5)), radius: 2.8, tip: 0.55, swell: 0.3) in silver satin engraved hatch(scale: 1.3, depth: 0.13)
part silverKingCup      = bell(length: 5, mouth: 9.5, throat: 6.2, wall: 1.3, flare: 1.2) in silver satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part silverKingUpright  = bar(length: 7, width: 2.2, thickness: 2.2, bevel: 0.35) in silver polished
part silverKingCrossarm = bar(length: 4.4, width: 2.2, thickness: 2.2, bevel: 0.35) in silver polished

unit silverPawn {
  place silverBase
  place silverPawnShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 12.6)
  place silverPawnHead at (0, 0, 15.8)
}
unit silverRook {
  place silverBase
  place silverRookShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 10.6)
  place silverRookRim at (0, 0, 11.4)
  place silverRookTower at (0, 0, 14.6)
  place silverRookLid at (0, 0, 17.6)
  repeat silverRookMerlon around ring(4, radius: 3.5, z: 19.3)
}
unit silverKnight {
  place silverBase
  place silverKnightShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 10.6)
  place silverKnightCrest at (0, 0, 11)
  place silverKnightEar at (1.2, 0, 23.4) roll 90deg pitch -25deg
  place silverCollet at (2.4, 1.3, 21.6) pitch 90deg roll 20deg
  place silverCollet at (2.4, -1.3, 21.6) pitch 90deg roll -20deg
}
unit silverBishop {
  place silverBase
  place silverBishopShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 12.6)
  place silverBishopMitre at (0, 0, 13)
  place silverBishopPip at (0, 0, 24.2)
  place silverCollet at (0, -3.1, 17.4) roll -90deg
}
unit silverQueen {
  place silverBase
  place silverQueenShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 17)
  place silverQueenCup at (0, 0, 17.2)
  repeat silverCollet around ring(8, radius: 4.6, z: 23.6, tilt: 40deg)
  place silverQueenPip at (0, 0, 25.6)
}
unit silverKing {
  place silverBase
  place silverKingShaft at (0, 0, 3.4)
  place silverHoop at (0, 0, 19)
  place silverKingCup at (0, 0, 19.2)
  repeat silverCollet around ring(8, radius: 4.4, z: 24.4, tilt: 40deg)
  place silverKingUpright at (0, 0, 27.5) pitch -90deg
  place silverKingCrossarm at (0, 0, 28.5)
}

part goldFoot  = disc(radius: 7.2, thickness: 2.4, bevel: 0.7) in gold polished
part goldInlay = plate(roundel(radius: 5.9), thickness: 1, bevel: 0.3, enamel: ruby) in gold satin
part goldHoop  = band(radius: 2, width: 1.6, thickness: 0.9) in gold polished
part goldSeat  = setting(width: 3, style: bezel, height: 1.2) in gold polished
part goldStone = gem(cut: brilliant, width: 3) in ruby

unit goldCollet {
  place goldSeat
  fasten goldStone to goldSeat.seat
}
unit goldBase {
  place goldFoot at (0, 0, 1.2)
  place goldInlay at (0, 0, 2.9)
}

part goldPawnShaft = stem(path: through((0,0,0), (0,0,9)), radius: 2.6, tip: 0.45, swell: 0.3) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldPawnHead  = pearl(radius: 3) in gold pearl
part goldRookShaft  = stem(path: through((0,0,0), (0,0,7)), radius: 3, tip: 0.8, swell: 0.25) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldRookTower  = collar(inner: 2.6, wall: 2.1, length: 7, belly: 0.05) in gold satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part goldRookRim    = band(radius: 4.8, width: 1.5, thickness: 1) in gold polished
part goldRookLid    = disc(radius: 4.9, thickness: 1, bevel: 0.3) in gold polished
part goldRookMerlon = bar(length: 2.2, width: 2.6, thickness: 2.4, bevel: 0.3) in gold polished
part goldKnightShaft = stem(path: through((0,0,0), (0,0,7)), radius: 3, tip: 0.8, swell: 0.25) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldKnightCrest = blade(path: through((0,0,0), (0,0,5), (0,1.5,9), (0,4,11.5), (0,6.5,11)), width: 6.5, thickness: 2.4, sections: 40) in gold satin
part goldKnightEar   = plate(lozenge(length: 3.4, width: 1.5), thickness: 1.1, bevel: 0.25) in gold polished
part goldBishopShaft = stem(path: through((0,0,0), (0,0,9)), radius: 2.8, tip: 0.5, swell: 0.3) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldBishopMitre = bud(length: 10.5, width: 7, lobes: 2, lobeDepth: 0.18, point: 0.5) in gold satin
part goldBishopPip   = pearl(radius: 1.6) in gold pearl
part goldQueenShaft = stem(path: through((0,0,0), (0,0,13.5)), radius: 2.8, tip: 0.55, swell: 0.3) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldQueenCup   = bell(length: 6.5, mouth: 10, throat: 6.4, wall: 1.3, flare: 1.2) in gold satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part goldQueenPip   = pearl(radius: 2.5) in gold pearl
part goldKingShaft    = stem(path: through((0,0,0), (0,0,15.5)), radius: 2.8, tip: 0.55, swell: 0.3) in gold satin engraved hatch(scale: 1.3, depth: 0.13)
part goldKingCup      = bell(length: 5, mouth: 9.5, throat: 6.2, wall: 1.3, flare: 1.2) in gold satin engraved hatch(scale: 1.3, depth: 0.13, angle: 90deg)
part goldKingUpright  = bar(length: 7, width: 2.2, thickness: 2.2, bevel: 0.35) in gold polished
part goldKingCrossarm = bar(length: 4.4, width: 2.2, thickness: 2.2, bevel: 0.35) in gold polished

unit goldPawn {
  place goldBase
  place goldPawnShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 12.6)
  place goldPawnHead at (0, 0, 15.8)
}
unit goldRook {
  place goldBase
  place goldRookShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 10.6)
  place goldRookRim at (0, 0, 11.4)
  place goldRookTower at (0, 0, 14.6)
  place goldRookLid at (0, 0, 17.6)
  repeat goldRookMerlon around ring(4, radius: 3.5, z: 19.3)
}
unit goldKnight {
  place goldBase
  place goldKnightShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 10.6)
  place goldKnightCrest at (0, 0, 11)
  place goldKnightEar at (1.2, 0, 23.4) roll 90deg pitch -25deg
  place goldCollet at (2.4, 1.3, 21.6) pitch 90deg roll 20deg
  place goldCollet at (2.4, -1.3, 21.6) pitch 90deg roll -20deg
}
unit goldBishop {
  place goldBase
  place goldBishopShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 12.6)
  place goldBishopMitre at (0, 0, 13)
  place goldBishopPip at (0, 0, 24.2)
  place goldCollet at (0, -3.1, 17.4) roll -90deg
}
unit goldQueen {
  place goldBase
  place goldQueenShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 17)
  place goldQueenCup at (0, 0, 17.2)
  repeat goldCollet around ring(8, radius: 4.6, z: 23.6, tilt: 40deg)
  place goldQueenPip at (0, 0, 25.6)
}
unit goldKing {
  place goldBase
  place goldKingShaft at (0, 0, 3.4)
  place goldHoop at (0, 0, 19)
  place goldKingCup at (0, 0, 19.2)
  repeat goldCollet around ring(8, radius: 4.4, z: 24.4, tilt: 40deg)
  place goldKingUpright at (0, 0, 27.5) pitch -90deg
  place goldKingCrossarm at (0, 0, 28.5)
}

form chess {
  place chessboard

  # the silver army, on the first and second ranks
  repeat silverPawn around along(bow((-77,-55,6.8), (77,-55,6.8), sag: 0), 8)
  place silverRook at (-77, -77, 6.8)
  place silverKnight at (-55, -77, 6.8)
  place silverBishop at (-33, -77, 6.8)
  place silverQueen at (-11, -77, 6.8)
  place silverKing at (11, -77, 6.8)
  place silverBishop at (33, -77, 6.8)
  place silverKnight at (55, -77, 6.8)
  place silverRook at (77, -77, 6.8)

  # the gold army, on the seventh and eighth, its knights turned about
  repeat goldPawn around along(bow((-77,55,6.8), (77,55,6.8), sag: 0), 8)
  place goldRook at (-77, 77, 6.8)
  place goldKnight at (-55, 77, 6.8) turn 180deg
  place goldBishop at (-33, 77, 6.8)
  place goldQueen at (-11, 77, 6.8)
  place goldKing at (11, 77, 6.8)
  place goldBishop at (33, 77, 6.8)
  place goldKnight at (55, 77, 6.8) turn 180deg
  place goldRook at (77, 77, 6.8)
}`,
  chessboard: `# An art deco chessboard: sixty-four enamel squares laid on a gold ground,
# with a millimetre of gold showing between them for the veins, a guilloche
# border, a dentil band of chevrons, and a sunburst with an onyx at each
# corner.
#
# The grid is made by doubling rather than by any grid symmetry, which the
# language does not have: a pair of squares becomes a file of eight along a
# line, two files become four, four become eight. Note the line: a "through"
# of two points is a spline whose parameter is not arc length, so eight
# squares along one come out unevenly spaced — a "bow" with no sag is a
# straight line evenly walked, which is what a grid wants.
material gold satin

part ground = plate(polygon(sides: 4, radius: 147, rotate: 45deg), thickness: 2.6, tiers: 2, shrink: 0.055, bevel: 1.2) engraved guilloche(scale: 5, depth: 0.1)
part light  = plate(polygon(sides: 4, radius: 14.85, rotate: 45deg), thickness: 1.6, bevel: 0.25, enamel: white)
part dark   = plate(polygon(sides: 4, radius: 14.85, rotate: 45deg), thickness: 1.6, bevel: 0.25, enamel: black)
part rail   = bar(length: 182, width: 3.4, thickness: 1.8, bevel: 0.4) in gold polished
part ray    = plate(fan(radius: 17, spread: 86deg, blades: 5, inner: 3.5), thickness: 1.4, bevel: 0.3) in gold polished
part chev   = plate(chevron(width: 9, rise: 4, bar: 1.8), thickness: 1.2, bevel: 0.25) in gold polished
part seat   = setting(width: 5.5, style: bezel, height: 1.8) in gold polished
part stone  = gem(cut: brilliant, width: 5.5) in onyx

unit collet {
  place seat
  fasten stone to seat.seat
}

# a1 is dark, so the a file starts dark and the b file light
unit pairA { place dark
  place light at (0, 22, 0) }
unit pairB { place light
  place dark at (0, 22, 0) }
unit fileA { repeat pairA around along(bow((0,0,0), (0,132,0), sag: 0), 4) }
unit fileB { repeat pairB around along(bow((0,0,0), (0,132,0), sag: 0), 4) }
unit two   { place fileA
  place fileB at (22, 0, 0) }
unit four  { place two
  place two at (44, 0, 0) }
unit eight { place four
  place four at (88, 0, 0) }

# a rail spans a side rather than pointing out of the centre, so it is
# turned within its own unit before the ring repeats it
unit railing { place rail turn 90deg }
unit teeth { repeat chev around along(bow((0,-77,0), (0,77,0), sag: 0), 8) }

form chessboard {
  place ground at (0, 0, 2.6)
  place eight at (-77, -77, 6)
  repeat railing around ring(4, radius: 90.5, z: 6)
  repeat ray around ring(4, radius: 126, phase: 45deg, z: 5.9)
  repeat teeth around ring(4, radius: 99, z: 5.9)
  repeat collet around ring(4, radius: 122, phase: 45deg, z: 5.6)
}`,
};

/** Resolves a `use` between them, as an application's own resolver would. */
export const resolveSketch = (name: string): string | undefined => sketches[name];
