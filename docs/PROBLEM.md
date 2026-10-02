# Problem and user need

## The problem we chose

**The right blood type is not in the right place at the right time, and the
people who could fix it do not know.**

Across many African blood services this shows up as two failures at once:

- **Shortages at the bedside.** Supply is seasonal: a large share of collections
  in many countries comes from school and college drives, so stocks fall when
  institutions close. Demand is uneven: obstetric haemorrhage, trauma, malaria
  anaemia in children and sickle cell disease create sudden local spikes.
- **Waste elsewhere at the same time.** Platelets last about 5 days and red cells
  about 5 weeks. A hospital that over-orders, or sees a quiet week, discards units
  that another facility needed.

Underneath both is an information problem:

1. **Stock is not visible across facilities.** It lives on paper registers,
   spreadsheets or isolated systems, so nobody can see that one hospital will
   discard O+ platelets tomorrow while another 40 km away is out of them.
2. **Demand data is wrong in a subtle way.** Most systems record what was
   *issued*. On days a hospital ran out, issues are low, so any forecast trained
   on issues learns that shortages mean low demand.
3. **Donors are recruited by broadcast, not by need.** General appeals on radio
   and social media bring in common blood types when the shortage is O-, or bring
   people to a site that is far away or not collecting that day.
4. **Connectivity is intermittent.** Rural facilities lose connectivity and power
   often enough that any system which needs a live connection to record a
   transfusion will be bypassed with paper.

## Users and what they need

| User | Need | What this slice gives them |
|---|---|---|
| **Donor** | "Is my blood type needed, where can I give near me, and when can I give again?" | Donor app: appeals matched to their blood type and sorted by urgency and distance, the nearest collection sites with Google Maps directions, booking, eligibility countdown, and confirmation that their unit is traced to a patient |
| **Hospital blood bank officer** | "Will I run out this week? Who can send me units?" | Stock by blood group with days of cover, a forecast with an explanation, transfer suggestions to approve or reject, donor appeals they publish |
| **Regional blood centre** | "Where should today's stock go? Where will it expire?" | Network-wide view, expiry-risk flags, redistribution suggestions that prefer units that would otherwise be discarded |
| **Lab technologist** | Record collection and screening results quickly, even offline | Event recording that queues offline and cannot release an untested or reactive unit |
| **Clinician** | Be confident the unit is safe, in date and meant for this patient | Lifecycle rules enforced at the point of issue, reservations honoured, full trace |
| **Ministry / national programme** | Trusted, comparable data across facilities | One event model, an HL7 FHIR interface, and audit trails that carry the role and site behind every action |

## Why this slice

It is the smallest loop that connects all six links of the vein-to-vein chain
(donor → collection → laboratory → inventory → hospital → patient) with live
data. It also exercises every hard technical requirement in the brief:
interoperability, unreliable infrastructure, security, forecasting, and
real-time operational decisions with a person in the loop.
