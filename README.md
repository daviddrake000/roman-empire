# Roman Empire Timeline

A reading companion for books covering the Roman Empire. Features a timeline of events, a map that steps through them over Roman borders, the Julio-Claudian family tree, a chart of who held power, and dossiers for the key figures. It runs on Firebase (Hosting + Firestore + Google sign-in).  

Associated books:
- Stephen P. Kershaw, *A Brief History of the Roman Empire* (2013)
- Ammianus Marcellinus, *The Later Roman Empire (AD 354-378)* (1986)

## Using it

Open https://roman-empire-kt.firebaseapp.com. Anyone with the link can read the timeline. **FULL / TLDR** above the timeline switches between every event and just the turning points, one line each; **More** on a TLDR line opens that event in the full timeline. The page remembers the choice.

**Sign in** with the admin Google account to:

- add, replace or remove bust photos from a dossier in the People view. Choose a file, or paste: copy an image (right-click it, then Copy image) or its link, open the dossier, and press Ctrl+V (⌘V on a Mac) or the Paste button. Links from Wikipedia/Wikimedia work; some other sites block downloads, and then copying the image itself does. Anyone can use **Copy** to copy a saved photo;
- edit people: **Edit details** in a dossier changes the name, short name, dates, role, side, summary, key moments and fate. People who appear only in the family tree have no dossier, so tap their box in the tree to edit their name, dates and caption. **Restore original** undoes your edits to that person;
- push the latest content from `seed/` into the database (this happens on its own when you open the page signed in; a message says how many changes were saved).

Any other account sees the page as view only.

## Where the data lives

| What | Where |
| --- | --- |
| Events, people, places, power spans, links, milestones, reading progress | `seed/<collection>/<id>.json` in this folder, the source of truth. Mirrored into Firestore collections of the same names. |
| Edits to people made on the page | Firestore `personEdits/{personId}`: only the fields you changed, shown on top of `seed/`. The sync never overwrites them. `npm run pull-edits` copies them into `seed/people/` (no sign-in needed). |
| Bust photos | Firestore `photos/{personId}`, as a JPEG data URL (the page shrinks photos to fit Firestore's 1 MiB document limit). Not in `seed/`; Cloud Storage would need a billing account. |
| Map borders | `public/geo.json` |

The page shows the bundled copy of `seed/` until Firestore has data, so it is never blank. When the owner opens the page, `src/sync.ts` compares `seed/` with Firestore and writes new and changed documents and deletes ones that were removed. It never touches photos.

Security rules (`firestore.rules`): everyone can read those collections; only the owner's Google account can write, identified by its Firebase user ID. The ID is also in `src/firebaseConfig.ts` (`OWNER_UID`); change both together.

## After each chapter

The workflow from the original guide still applies (take notes, have Claude fact-check them, report corrections in chat only, keep the page a standalone history). What changes is how the data gets in:

1. Paste your notes into Claude Code
2. Claude runs `npm run pull-edits` first, so `seed/` includes anything you changed on the page, then edits `seed/` and runs `npm run deploy`. A page edit to a field wins over `seed/` until you choose **Restore original**.
3. Open the site signed in. The new content syncs to Firestore and appears for everyone.
4. Add bust photos for new people from their dossiers.

### Rules for the data

- **Years** are numbers: BCE negative, CE positive, no year 0 (1 BCE is `-1`, 1 CE is `1`). `label` holds the readable form, e.g. `"15 March 44 BCE"` or `"c. 116–113 BCE"`; use "c." when sources disagree.
- **Legendary events** get a traditional date, and the text says they are legend.
- **TLDR**: give an event a `tldr` (one sentence, about 15 words, saying why it matters) to make it a turning point in the TLDR timeline. Keep it to the events a reader could not follow the story without; about one in three so far.
- **Event ids** step by 10 (`e250`, `e260`) so later events can slot in between. Put an event's main subject first in `people`.
- `source`, `note` and `chapter` are record-keeping only; the page never shows them.
- A person's `faction` is one of `legend`, `kings`, `republic`, `enemy`, `optimates`, `populares`, `caesarians`, `egypt`, `family`. `kind: "main"` gets a dossier; `"link"` appears only in the family tree.
- **Family tree** boxes show the name, the `life` dates and, for `link` people, the `sub` caption, so give everyone in the tree a `life`. Positions are set by hand: boxes are 150 × 70, columns at x = 40, 220, 400, 580, 760, 960, generations at y = 20, 160, 310, 460, 600. Spouses sit side by side; children go below, centred where possible. Start a new block lower down for a new dynasty.
- **Power chart**: `power` spans are `{ person, start, end, lane, label }` (reuse a lane once its person has left the stage); `links` are `alliance` (shaded band), `war` (hatched band) or `handoff` (arrow from `people[0]` to `people[1]`); `milestones` are dashed lines.
- Places use the ancient name, with the modern one in brackets if it helps, e.g. `"Bononia (Bologna)"`.

### Changes that need code, not just data

| When | Change |
| --- | --- |
| A new period starts | Add it to `ERA` in `src/app.ts` and a `--era-<id>` colour (light and dark) in `src/styles.css`. |
| A new person joins the Power chart | Add `--c-<id>` for light and dark in `src/styles.css`; without it the bar is grey. |
| Events go past 100 CE | Add the years (200, 300, 400, 500 CE) to `YEARS` in `scripts/build-geo.mjs` and run `npm run build-geo`. |
| Events go beyond the map frame (longitude −10 to 44, latitude 28 to 54) | Widen the frame in `setupProjection()` in `src/app.ts`. The map data covers longitude −12 to 50 and latitude 24 to 56; to go further, widen `BBOX` in `scripts/build-geo.mjs` and run `npm run build-geo`. |
| The Power chart or family tree gets crowded | Add a period or dynasty selector. (The tree already drags and zooms, and the Power chart keeps its names column in view when scrolled.) |

## Developing

```bash
npm install
npm run dev
```

Then open http://localhost:5177. The dev server uses the live Firebase project and data.

To publish (needs the Firebase CLI, signed in with `firebase login`):

```bash
npm run deploy
```

## Project layout

| Path | What it is |
| --- | --- |
| `seed/` | The timeline content, one JSON file per document |
| `src/app.ts` | The page: timeline, map, family tree, power chart, people and dossiers, photo upload |
| `src/seed.ts`, `src/sync.ts` | Bundles `seed/` into the build and mirrors it into Firestore for the owner |
| `scripts/pull-edits.mjs` | Copies page edits to people from Firestore into `seed/people/` |
| `src/firebase.ts`, `src/firebaseConfig.ts` | Firebase setup, Google sign-in, owner check |
| `src/types.ts` | The shape of each record |
| `src/styles.css` | The whole visual design: colours (light and dark), type, layout |
| `public/geo.json`, `scripts/build-geo.mjs` | Coastlines and Roman territory snapshots for the map, and the script that rebuilds them from Natural Earth and historical-basemaps |
| `public/favicon*`, `public/icon-*.png`, `public/apple-touch-icon.png` | Site and home-screen icons, cut from a photo of the Colosseum |
| `firestore.rules`, `firebase.json` | Database security rules, hosting and sign-in config |
