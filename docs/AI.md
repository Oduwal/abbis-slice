# AI and data approach

## The use case

**Forecast demand per facility × blood type × component, and turn the forecast
into decisions a person approves:** move units that would expire unused to where
they will be transfused, top up facilities heading for a shortage, and, when no
transfer can close the gap, draft an appeal to the right donors.

This is where AI earns its place here. The benefit is measurable (discards
avoided, stock-outs avoided), the decision is reversible and reviewed by a
person, and a wrong answer degrades to today's practice rather than harming a
patient. AI is **not** used for anything clinical: compatibility, eligibility
and release rules are deterministic code.

## Data inputs

| Input | Source | Why it matters |
|---|---|---|
| **Requested** units per day (including requests not filled) | `demand` table | Forecasting on *issued* units teaches a model that a stock-out means low demand. We record unconstrained demand. |
| Available stock by expiry | unit projection | For FEFO expiry-risk simulation |
| In-transit units | unit projection | Avoids double-counting what is already on its way |
| Site locations | `sites` | Transport time and donor distance |
| Eligible donors by type and location | `donors` | How many donors an appeal would reach |

## Model choice

**Damped Holt-Winters (level + damped trend + weekly seasonality), tuned per
series by grid search, with automatic fallback to a 28-day average.**
(`src/ai/forecast.ts`, about 250 lines with no libraries.)

Why not a neural network or gradient boosting:
- A series is a few units a day at most, with months of history. At that scale,
  well-tuned exponential smoothing is a strong baseline.
- Every number has to be explainable to a blood bank officer: *"weekday effect
  +3 on Tuesdays, demand down 5% on last fortnight"* is something they can check
  against what they know about their own hospital.
- It runs on a laptop in milliseconds, with no GPU, no cloud and no model
  artefacts to deploy.

## Evaluation

Each series is **backtested on a 14-day holdout before use**, against two
baselines: "same day last week" and the 28-day average. If Holt-Winters does not
beat the average, the system uses the average and says so. If the result does not
beat "same day last week", confidence is set to *low* and the UI says the
forecast is "indicative only".

Network-wide rolling-origin evaluation (`npm run eval`): 6 weekly origins × 7-day
horizon, 576 forecasts on the synthetic history:

| Volume tier | Forecasts | MAE model | MAE same-day-last-week | MAE 28-day avg | Skill vs naive | P90 coverage |
|---|---|---|---|---|---|---|
| high (≥3/day) | 42 | 1.98 | 2.54 | 2.02 | 22% | 86% |
| medium (0.5–3/day) | 174 | 0.95 | 1.19 | 0.95 | 20% | 87% |
| sparse (<0.5/day) | 360 | 0.19 | 0.19 | 0.19 | −1% | 92% |

How to read this honestly:
- On high- and medium-volume series the forecaster cuts error by about a fifth
  compared with "same day last week", the rule of thumb many blood banks use
  today.
- It is **no better than a 28-day average**. On this synthetic data, demand is
  mostly a weekday pattern plus noise, so a good average is close to the ceiling.
  Real data with holidays, outbreaks and referral changes should favour the
  adaptive model more, but **that has to be shown on pilot data, not assumed**.
- On rare blood types (most series), nothing beats the baselines: demand is a
  handful of units a month. There the value comes from the interval (P90 coverage
  of 92%) and the expiry simulation, not the point forecast. A pilot should test
  Croston/TSB methods for this intermittent demand.
- The P90 band contains 86–92% of actual days, close to the 90% target, so the
  reorder points built on it are calibrated.

## From forecast to decision (`src/ai/advisor.ts`)

1. **Reorder point** per series: P90 demand over transport lead time plus safety
   days. Stock plus in-transit below it is *low*; below expected demand before a
   delivery could arrive is *critical*.
2. **FEFO expiry simulation**: walk stock in expiry order against forecast
   consumption, and flag units that will still be on the shelf when they expire.
3. **Transfers**: cover the most urgent deficits first, preferring (a) units
   that would expire unused at another hospital, then (b) blood centre stock,
   then (c) another hospital's genuine surplus; nearest first. Each unit must
   arrive with usable shelf life, using a distance-based transport time.
4. **Rehoming**: units at risk where they are go to a hospital that will use them
   before they expire, given what that hospital already holds.
5. **Draft donor appeals** for red cell shortfalls that no transfer can close,
   showing how many eligible, compatible donors within 50 km they would reach.

## Explainability

Every suggestion carries, in plain language: what the receiving site should
hold and why, what it holds, which model produced the forecast and how it
performed on its backtest, and how many of the units would otherwise expire. The
forecast screen shows the history (with unmet requests in red), the band, the
backtest table, and the fitted weekday and trend effects.

## Human oversight

- **Nothing moves without approval** by an inventory officer *at the sending
  site* (role and site enforced on the server).
- Approval re-checks every unit: anything moved, issued or expired since the
  suggestion was made is skipped and reported.
- **Rejection requires a reason.** Reasons are logged with the suggestion and
  appear in the monitor, for model review ("courier unavailable",
  "clinician expects lower use").
- Donor appeals drafted by AI are labelled as such and need a staff member to
  publish them.

## Monitoring

`GET /api/ai/monitor` (shown on the Advisor tab): model mix, confidence mix,
share of series that beat the naive baseline, mean MAE, and approval/rejection
counts with recent rejection reasons. In a pilot this feeds a weekly review. A
model whose share beating the naive baseline falls, or whose rejection rate rises,
is investigated before anyone trusts it further.

## Fallbacks

| Situation | Behaviour |
|---|---|
| Fewer than 28 days of history | Plain average, *low* confidence, "review manually" |
| Model loses to the average on the holdout | Average is used, and the reason says so |
| Model loses to "same day last week" | Used, but marked *low* confidence / indicative |
| Forecasting fails or is switched off | The inventory view, lifecycle rules, transfers and appeals keep working. AI suggestions are an extra layer on top. |
| Offline | Last advisor output is cached on the device; approvals need a connection, because the sending site must confirm the units are on the shelf |

## Known limitations

- Synthetic data. Real demand has features the simulator does not have.
- No cross-series learning yet (hierarchical forecasting would help rare types by
  borrowing strength from O+/A+ at the same hospital).
- Holidays and known events (school calendars, elective surgery lists) are not
  inputs yet; both are cheap to add as regressors.
- Transport time is estimated from distance; a pilot would use observed courier
  times.
