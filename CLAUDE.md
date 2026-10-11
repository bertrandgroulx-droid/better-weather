# Better Weather — working notes for Claude

## How the owner works
- **Mock-ups first; nothing changes without approval.** Render a mock-up from a scratch copy
  (never the repo) and wait for an explicit "go"/"put it in the app" before shipping.
- After every deploy, report the publish time (UTC) and build.
- Links must be clickable markdown with the full file path
  (e.g. `https://shozbot.com/better-weather/index.html`); the shozbot proxy 404s on bare folders.

## Data design principles
- **Information must be meaningful and comparable: proper scaling and details matter.**
  Never distort or clamp a value's visual size just to make the layout tidier — a big snow day
  must look bigger than a small one, on the same scale as its neighbours. Fix readability
  another way (outlines, placement), not by hiding the size of the data.
- Show values the way people read them: e.g. a day's low is the *following night's*
  (6 PM → 9 AM), not the midnight-to-midnight minimum; icon intensity follows the amount shown.
- Keep presentation consistent across views: no bold anywhere; yellow means "now" (NOW labels,
  the NOW bar/pill); snow is white, rain blue.

## Checks before saying something is done
- `CHROMIUM_PATH=/opt/pw-browsers/chromium PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm test`
- Then confirm GitHub's **CI** run for the commit passed (not just the local run): the sandbox
  can't reach shozbot.com or open-meteo.com, so things that load only there (e.g. the studio
  kit's "by shozbot" credit) never show up locally. A CI failure prints its reason as an
  annotation (`check-runs/<id>/annotations`).
- Tests must not depend on the time of day (fixtures are built from "now").
