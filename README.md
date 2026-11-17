# gta6-twitch-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/ALENSALIM/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/ALENSALIM/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

A forecaster for how many people watch Grand Theft Auto VI live on Twitch
through its release day, 2026-11-19 (UTC), given only the first hour's
viewer count.

The idea is simple: big console launches trace a similar audience curve
once you scale by how big the first hour was. For each hour from 2 to 24,
the program looks at the past launches shipped in the case file, fits a
weighted local-linear regression of the log ratio
`ln(viewers_hour / viewers_hour1)` on `ln(viewers_hour1)` — weighted
toward launches whose first hour was a similar size to this one — and
takes the fitted value as the median. The spread comes from the weighted
quantiles of the regression residuals, so the five quantiles (5%, 25%,
50%, 75%, 95%) reflect how much comparable launches actually varied
around the usual shape, rather than a guessed spread. Only launches with
a complete 24-hour release-day curve are used, which also drops the GTA VI
pre-release entry that has no release day yet.

The case's minute history, top streams and hourly category tables are
deliberately not used: leave-one-out testing on the past launches showed
they add nothing once the hour-1 print and the comparables are in. If no
comparable is usable, or anything goes wrong with a case, the program
falls back to the house persistence baseline (every hour stays at the
first hour's count, with a spread widening like a random walk), so every
case still gets a valid forecast.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
