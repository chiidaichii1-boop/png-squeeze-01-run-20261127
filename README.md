# PNG Squeeze

[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/chiidaichii1-boop/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/chiidaichii1-boop/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![entries](https://make.fun/badge/png-squeeze-01-run-20261127/chiidaichii1-boop/png-squeeze-01-run-20261127/entries.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG recompressor for 1280x720 RGBA screenshots. It reads every
`/input/<id>/image.png` and writes the smallest lossless PNG it can find to
`/output/<id>/image.png`.

How it squeezes, per image:

1. **Colour form** — a palette (at most 256 colours, transparent entries
   first so tRNS stays short), grey / grey+alpha when every pixel is grey,
   RGB / RGBA otherwise, with a tRNS key when the image holds a single fully
   transparent value and no opaque pixel shares it.
2. **Filtering** — every row tried five ways plus the per-row minimum-sum and
   fewest-pairs choices; the best few are weighed by real zlib level 9.
3. **Brute-force refinement** — each row takes the filter whose own zlib
   stream (level 4, the 32 KiB already written as dictionary) is shortest.
4. **Deflate** — the winner is written at zlib levels 6 and 9, each with the
   default and filtered strategies, keeping the smallest stream.

No clock is read and no randomness is used, so two runs write identical
bytes. Node 22, standard library only; run with
`MAKEFUN_INPUT_DIR=<in> MAKEFUN_OUTPUT_DIR=<out> node main.ts`.
